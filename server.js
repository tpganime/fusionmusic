const express = require('express');
const { spawn, execSync } = require('child_process');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const play = require('play-dl');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);
app.disable('x-powered-by');

const CACHE_DIR = path.join(__dirname, 'audio_cache');
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR);
}
const activeDownloads = new Map();

// Auto-detect if FFmpeg is installed (supports Windows and Termux)
let hasFfmpeg = false;
try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    hasFfmpeg = true;
    console.log(`[FUSION MUSIC] FFmpeg is available and will be used for stream transcoding fallbacks.`);
} catch (e) {
    console.log(`[FUSION MUSIC] FFmpeg is not available. Stream transcoding fallbacks will be disabled.`);
}

// HTTPS Keep-Alive Agent for TCP/TLS connection reuse (eliminates connection latency for range requests)
const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 60000
});

// Simple in-memory cache for search queries
const searchCache = {
    store: new Map(),
    get(key) {
        const item = this.store.get(key);
        if (!item) return null;
        if (Date.now() > item.expiry) {
            this.store.delete(key);
            return null;
        }
        return item.value;
    },
    set(key, value, ttl = 24 * 60 * 60 * 1000) {
        this.store.set(key, {
            value,
            expiry: Date.now() + ttl
        });
    }
};

// In-memory cache for direct Google Video URLs to make range requests instant
const directUrlCache = {
    store: new Map(),
    get(key) {
        const item = this.store.get(key);
        if (!item) return null;
        if (Date.now() > item.expiry) {
            this.store.delete(key);
            return null;
        }
        return item.value;
    },
    set(key, value, ttl = 4 * 60 * 60 * 1000) { // Cache for 4 hours (Google URLs expire in 6)
        this.store.set(key, {
            value,
            expiry: Date.now() + ttl
        });
    }
};

// Helper to inject cookies if a cookies.txt file exists in the directory
function getYtdlpArgs(baseArgs) {
    const secretCookiesPath = process.env.YOUTUBE_COOKIES_FILE || '/etc/secrets/cookies.txt';
    if (fs.existsSync(secretCookiesPath)) {
        console.log(`[FUSION MUSIC] Using YouTube cookies secret file for yt-dlp request.`);
        return [...baseArgs, '--cookies', secretCookiesPath];
    }

    const envCookiesPath = materializeCookiesFromEnv();
    if (envCookiesPath) {
        console.log(`[FUSION MUSIC] Using YouTube cookies from Render environment for yt-dlp request.`);
        return [...baseArgs, '--cookies', envCookiesPath];
    }

    const cookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesPath)) {
        console.log(`[FUSION MUSIC] Using cookies.txt for yt-dlp request.`);
        return [...baseArgs, '--cookies', cookiesPath];
    }
    return baseArgs;
}

function materializeCookiesFromEnv() {
    const targetPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(targetPath)) {
        return null;
    }

    const rawCookies = process.env.YOUTUBE_COOKIES_TXT || process.env.YOUTUBE_COOKIES || '';
    const base64Cookies = process.env.YOUTUBE_COOKIES_BASE64 || '';
    let cookieText = '';

    if (rawCookies.trim()) {
        cookieText = rawCookies.replace(/\\n/g, '\n').trim();
    } else if (base64Cookies.trim()) {
        try {
            cookieText = Buffer.from(base64Cookies.trim(), 'base64').toString('utf8').trim();
        } catch (err) {
            console.error(`[FUSION MUSIC] Failed to decode YOUTUBE_COOKIES_BASE64:`, err.message);
        }
    }

    if (!cookieText) {
        return null;
    }

    try {
        fs.writeFileSync(targetPath, cookieText.endsWith('\n') ? cookieText : `${cookieText}\n`, { mode: 0o600 });
        return targetPath;
    } catch (err) {
        console.error(`[FUSION MUSIC] Failed to write Render cookies.txt:`, err.message);
        return null;
    }
}

// Semaphore to prevent CPU thrashing by limiting concurrent yt-dlp executions
class Semaphore {
    constructor(maxConcurrent) {
        this.maxConcurrent = maxConcurrent;
        this.currentConcurrent = 0;
        this.queue = [];
    }

    async acquire() {
        if (this.currentConcurrent < this.maxConcurrent) {
            this.currentConcurrent++;
            return;
        }
        return new Promise(resolve => {
            this.queue.push(resolve);
        });
    }

    release() {
        this.currentConcurrent--;
        if (this.queue.length > 0) {
            this.currentConcurrent++;
            const next = this.queue.shift();
            next();
        }
    }
}

const ytdlpSemaphore = new Semaphore(10); // Spawning max 10 concurrent yt-dlp processes to support multi-device playback

// Helper function to extract raw 11-character video ID from any YouTube URL
function extractVideoId(str) {
    if (!str) return '';
    str = str.trim();
    // If it's already an 11-char ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(str)) {
        return str;
    }
    // Check for standard YouTube watch URL (contains v=)
    const vMatch = str.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (vMatch) return vMatch[1];

    // Check for youtu.be short URL
    const shortMatch = str.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (shortMatch) return shortMatch[1];

    // Check for shorts/ URL
    const shortsMatch = str.match(/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shortsMatch) return shortsMatch[1];

    // Check for embed/ URL
    const embedMatch = str.match(/embed\/([a-zA-Z0-9_-]{11})/);
    if (embedMatch) return embedMatch[1];

    // Fallback: match any 11-character sequence of valid characters that looks like an ID
    const fallbackMatch = str.match(/\/([a-zA-Z0-9_-]{11})(?:\?|&|$)/);
    if (fallbackMatch) return fallbackMatch[1];

    return str;
}

function resolveWithPlayDl(videoUrl, formatSpec) {
    return new Promise(async (resolve, reject) => {
        try {
            const videoId = extractVideoId(videoUrl);
            const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
            console.log(`[FUSION MUSIC] [RACE] [PLAY-DL] Resolving: ${cleanUrl}`);
            const videoInfo = await play.video_info(cleanUrl);
            const isVideo = formatSpec.includes('height') || formatSpec.startsWith('22/') || formatSpec.startsWith('18/');
            
            let format;
            const requestedItags = formatSpec.split('/')
                .map(part => parseInt(part, 10))
                .filter(itag => !isNaN(itag));
                
            for (const itag of requestedItags) {
                format = videoInfo.format.find(f => f.itag === itag);
                if (format) {
                    console.log(`[FUSION MUSIC] [PLAY-DL] Selected format by itag: ${itag}`);
                    break;
                }
            }

            if (!format) {
                if (isVideo) {
                    format = videoInfo.format.find(f => f.hasVideo && f.hasAudio && f.container === 'mp4');
                    if (!format) format = videoInfo.format.find(f => f.hasVideo && f.hasAudio);
                } else {
                    format = videoInfo.format.find(f => f.mimeType && f.mimeType.startsWith('audio/'));
                }
            }

            if (!format && videoInfo.format.length > 0) {
                format = videoInfo.format[0];
            }

            if (format && format.url) {
                console.log(`[FUSION MUSIC] [RACE] [PLAY-DL] Won the race!`);
                resolve({ url: format.url, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
            } else {
                reject(new Error('play-dl resolved but found no URL'));
            }
        } catch (e) {
            reject(e);
        }
    });
}

function resolveWithYtdlp(videoUrl, formatSpec) {
    return new Promise(async (resolve, reject) => {
        try {
            const videoId = extractVideoId(videoUrl);
            const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
            console.log(`[FUSION MUSIC] [RACE] [YT-DLP] Resolving: ${cleanUrl}`);
            
            const spawnArgs = getYtdlpArgs([
                '-f', formatSpec,
                '-j',
                '--no-config',
                '--no-playlist',
                '--no-check-certificate',
                '--no-warnings',
                '--no-cache-dir',
                '--no-check-formats',
                '--force-ipv4',
                '--socket-timeout', '10',
                '--extractor-args', 'youtube:player_client=android,ios,web',
                cleanUrl
            ]);

            const ytdlp = spawn('yt-dlp', spawnArgs);
            let stdout = '';
            let stderr = '';
            
            ytdlp.on('error', (err) => {
                reject(new Error(`yt-dlp spawn failed: ${err.message}`));
            });
            
            ytdlp.stdout.on('data', (data) => { stdout += data.toString(); });
            ytdlp.stderr.on('data', (data) => { stderr += data.toString(); });
            
            ytdlp.on('close', (code) => {
                if (code === 0 && stdout.trim()) {
                    try {
                        const metadata = JSON.parse(stdout.trim());
                        const url = metadata.url;
                        const userAgent = (metadata.http_headers && metadata.http_headers['User-Agent']) || 
                                          (metadata.http_headers && metadata.http_headers['user-agent']) ||
                                          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
                        console.log(`[FUSION MUSIC] [RACE] [YT-DLP] Won the race!`);
                        resolve({ url, userAgent });
                    } catch (parseErr) {
                        reject(new Error(`yt-dlp JSON parse failed: ${parseErr.message}. Output was: ${stdout}`));
                    }
                } else {
                    reject(new Error(`yt-dlp failed: ${stderr.trim()}`));
                }
            });
        } catch (e) {
            reject(e);
        }
    });
}

async function getDirectUrl(videoUrl, formatSpec, format) {
    const videoId = extractVideoId(videoUrl);
    const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const cacheKey = `${cleanUrl}_${formatSpec}`;
    const cachedData = directUrlCache.get(cacheKey);
    if (cachedData) {
        return cachedData;
    }

    let directUrl;
    let userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    if (format === 'video') {
        console.log(`[FUSION MUSIC] [VIDEO] Resolving using yt-dlp exclusively: ${cleanUrl}`);
        const res = await resolveWithYtdlp(videoUrl, formatSpec);
        directUrl = res.url;
        userAgent = res.userAgent;
    } else {
        console.log(`[FUSION MUSIC] [AUDIO] Resolving using play-dl: ${cleanUrl}`);
        try {
            const res = await resolveWithPlayDl(videoUrl, formatSpec);
            directUrl = res.url;
            userAgent = res.userAgent;
        } catch (err) {
            console.warn(`[FUSION MUSIC] play-dl audio resolution failed, falling back to yt-dlp:`, err.message);
            const res = await resolveWithYtdlp(videoUrl, formatSpec);
            directUrl = res.url;
            userAgent = res.userAgent;
        }
    }

    const data = { url: directUrl, userAgent };
    directUrlCache.set(cacheKey, data);
    return data;
}

function downloadUrlToFile(directUrl, userAgent, tempFilePath, rangeHeader = null) {
    return new Promise((resolve, reject) => {
        let attempts = 0;

        function performDownload(currentUrl) {
            attempts++;
            const parsedUrl = url.parse(currentUrl);
            const headers = { 
                'User-Agent': userAgent,
                'Accept': '*/*',
                'Connection': 'keep-alive'
            };
            if (rangeHeader) {
                headers['Range'] = rangeHeader;
            }

            const options = {
                hostname: parsedUrl.hostname,
                path: parsedUrl.path,
                method: 'GET',
                headers: headers,
                rejectUnauthorized: false,
                agent: httpsAgent
            };

            const fileStream = fs.createWriteStream(tempFilePath);
            const request = https.get(options, (response) => {
                // Handle Redirects (301, 302, 303, 307, 308)
                if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                    response.resume();
                    fileStream.close();
                    try { fs.unlinkSync(tempFilePath); } catch (e) {}
                    if (attempts < 5) {
                        performDownload(response.headers.location);
                    } else {
                        reject(new Error('Too many redirects'));
                    }
                    return;
                }

                if (response.statusCode !== 200 && response.statusCode !== 206) {
                    response.resume();
                    fileStream.close();
                    try { fs.unlinkSync(tempFilePath); } catch (e) {}
                    reject(new Error(`HTTP status code ${response.statusCode}`));
                    return;
                }

                response.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    resolve(response);
                });
            });

            request.on('error', (err) => {
                fileStream.close();
                try { fs.unlinkSync(tempFilePath); } catch (e) {}
                reject(err);
            });

            request.setTimeout(60000, () => {
                request.destroy();
                fileStream.close();
                try { fs.unlinkSync(tempFilePath); } catch (e) {}
                reject(new Error('Request timeout'));
            });
        }

        performDownload(directUrl);
    });
}

function downloadToCache(videoUrl, formatSpec, cacheKey, filePath, tempFilePath) {
    if (activeDownloads.has(cacheKey)) {
        return activeDownloads.get(cacheKey);
    }

    const downloadPromise = (async () => {
        let attempts = 0;
        const maxAttempts = 2;

        async function tryDownload(bypassCache = false) {
            attempts++;
            try {
                if (bypassCache) {
                    const videoId = extractVideoId(videoUrl);
                    const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
                    const directUrlCacheKey = `${cleanUrl}_${formatSpec}`;
                    directUrlCache.store.delete(directUrlCacheKey);
                }

                const streamData = await getDirectUrl(videoUrl, formatSpec, 'audio');
                const directUrl = streamData.url;
                const userAgent = streamData.userAgent;

                await downloadUrlToFile(directUrl, userAgent, tempFilePath);

                if (fs.existsSync(tempFilePath)) {
                    const stats = fs.statSync(tempFilePath);
                    if (stats.size > 100 * 1024) {
                        fs.renameSync(tempFilePath, filePath);
                        console.log(`[FUSION MUSIC] [CACHE] Successfully cached: ${cacheKey} (${stats.size} bytes)`);
                        return filePath;
                    } else {
                        try { fs.unlinkSync(tempFilePath); } catch (e) {}
                        throw new Error('Downloaded file too small');
                    }
                } else {
                    throw new Error('Temp file not found after download');
                }
            } catch (err) {
                console.warn(`[FUSION MUSIC] [CACHE] Cache download attempt ${attempts} failed:`, err.message);
                if (attempts < maxAttempts) {
                    return tryDownload(true);
                }
                throw err;
            }
        }

        try {
            const result = await tryDownload(false);
            activeDownloads.delete(cacheKey);
            return result;
        } catch (err) {
            activeDownloads.delete(cacheKey);
            throw err;
        }
    })();

    activeDownloads.set(cacheKey, downloadPromise);
    return downloadPromise;
}

const activePreloads = new Map();

function preloadSong(videoUrl, videoId) {
    const cacheKey = `${videoId}_audio_high`;
    if (activePreloads.has(cacheKey)) {
        return activePreloads.get(cacheKey);
    }

    const preloadPromise = (async () => {
        let attempts = 0;
        const maxAttempts = 2;

        async function tryPreload(bypassCache = false) {
            attempts++;
            try {
                const formatSpec = '140/bestaudio';
                if (bypassCache) {
                    const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
                    const directUrlCacheKey = `${cleanUrl}_${formatSpec}`;
                    directUrlCache.store.delete(directUrlCacheKey);
                }

                const streamData = await getDirectUrl(videoUrl, formatSpec, 'audio');
                const directUrl = streamData.url;
                const userAgent = streamData.userAgent;

                const tempPreloadFilePath = path.join(CACHE_DIR, `${cacheKey}.preload.tmp`);
                
                // Use redirect-aware download helper with the Range header
                const response = await downloadUrlToFile(directUrl, userAgent, tempPreloadFilePath, 'bytes=0-750000');

                // Get total size from content-range or content-length
                const contentRange = response.headers['content-range'];
                let totalSize = 0;
                if (contentRange) {
                    const match = contentRange.match(/\/(\d+)$/);
                    if (match) {
                        totalSize = parseInt(match[1], 10);
                    }
                }
                if (!totalSize) {
                    const contentLength = response.headers['content-length'];
                    totalSize = contentLength ? parseInt(contentLength, 10) : 4000000;
                }

                const finalPreloadPath = path.join(CACHE_DIR, `${cacheKey}.${totalSize}.preload`);

                if (fs.existsSync(tempPreloadFilePath)) {
                    const stats = fs.statSync(tempPreloadFilePath);
                    if (stats.size > 10 * 1024) {
                        fs.renameSync(tempPreloadFilePath, finalPreloadPath);
                        console.log(`[FUSION MUSIC] [PRELOAD] Successfully cached 30s preload for: ${videoId} (${stats.size} bytes, total size ${totalSize})`);
                        return finalPreloadPath;
                    } else {
                        try { fs.unlinkSync(tempPreloadFilePath); } catch (e) {}
                        throw new Error('Preload file too small');
                    }
                } else {
                    throw new Error('Temp preload file not found');
                }
            } catch (err) {
                console.warn(`[FUSION MUSIC] [PRELOAD] Preload attempt ${attempts} failed:`, err.message);
                if (attempts < maxAttempts) {
                    return tryPreload(true);
                }
                throw err;
            }
        }

        try {
            const result = await tryPreload(false);
            activePreloads.delete(cacheKey);
            return result;
        } catch (err) {
            activePreloads.delete(cacheKey);
            throw err;
        }
    })();

    activePreloads.set(cacheKey, preloadPromise);
    return preloadPromise;
}

function touchFile(filePath) {
    try {
        const now = new Date();
        fs.utimesSync(filePath, now, now);
    } catch (err) {
        // Ignore utimes errors
    }
}

function cleanCache() {
    try {
        if (!fs.existsSync(CACHE_DIR)) return;

        const files = fs.readdirSync(CACHE_DIR);
        const now = Date.now();
        const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
        const MAX_CACHE_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
        const TARGET_CACHE_SIZE_BYTES = 400 * 1024 * 1024; // 400 MB

        let fileDetails = [];
        let totalSize = 0;

        files.forEach(file => {
            const filePath = path.join(CACHE_DIR, file);
            try {
                const stats = fs.statSync(filePath);
                if (stats.isFile()) {
                    const age = now - stats.mtimeMs;
                    
                    // 1. Delete files older than 7 days
                    if (age > MAX_AGE_MS) {
                        fs.unlinkSync(filePath);
                        console.log(`[FUSION MUSIC] [CACHE CLEAN] Deleted expired cache file: ${file} (age: ${Math.round(age / (24*3600*1000))} days)`);
                    } else {
                        fileDetails.push({
                            name: file,
                            path: filePath,
                            size: stats.size,
                            mtimeMs: stats.mtimeMs
                        });
                        totalSize += stats.size;
                    }
                }
            } catch (e) {
                // file might have been deleted or busy
            }
        });

        console.log(`[FUSION MUSIC] [CACHE STATUS] Total cache size: ${(totalSize / (1024 * 1024)).toFixed(2)} MB / 500 MB`);

        // 2. If total size exceeds max cache size, evict oldest accessed files
        if (totalSize > MAX_CACHE_SIZE_BYTES) {
            console.log(`[FUSION MUSIC] [CACHE CLEAN] Cache limit exceeded. Evicting oldest files...`);
            // Sort by mtimeMs ascending (oldest first)
            fileDetails.sort((a, b) => a.mtimeMs - b.mtimeMs);

            for (const file of fileDetails) {
                if (totalSize <= TARGET_CACHE_SIZE_BYTES) break;
                try {
                    fs.unlinkSync(file.path);
                    totalSize -= file.size;
                    console.log(`[FUSION MUSIC] [CACHE CLEAN] Evicted oldest file: ${file.name} (${(file.size / (1024*1024)).toFixed(2)} MB)`);
                } catch (e) {
                    // ignore
                }
            }
            console.log(`[FUSION MUSIC] [CACHE STATUS] Cache size after eviction: ${(totalSize / (1024 * 1024)).toFixed(2)} MB`);
        }
    } catch (err) {
        console.error('[FUSION MUSIC] [CACHE CLEAN] Error cleaning cache:', err.message);
    }
}

// Run cleanCache 5 seconds after startup
setTimeout(cleanCache, 5000);
// Run cleanCache every 6 hours
setInterval(cleanCache, 6 * 60 * 60 * 1000);

// Cloudflare Tunnel / browser preflight compatibility.
app.use((req, res, next) => {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'x-fusion-key, ngrok-skip-browser-warning, range, content-type, accept, user-agent');
    res.setHeader('Access-Control-Expose-Headers', 'content-length, content-range, accept-ranges, content-type');

    if (req.path === '/stream') {
        res.setHeader('Cache-Control', 'no-store, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
    }

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
});

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'fusion-music',
        tunnel: req.headers['cf-ray'] ? 'cloudflare' : 'direct'
    });
});

app.get('/', (req, res) => {
    res.json({
        ok: true,
        service: 'fusion-music',
        endpoints: ['/search?q=QUERY', '/stream?url=YOUTUBE_URL', '/playlist?url=PLAYLIST_URL', '/preload?urls=URLS']
    });
});

app.get('/favicon.ico', (req, res) => res.sendStatus(204));

// FUSION MUSIC SECURITY HANDSHAKE
app.use((req, res, next) => {
    const protectedPaths = new Set(['/search', '/stream', '/playlist', '/preload']);
    if (!protectedPaths.has(req.path)) {
        return next();
    }

    const authHeader = req.headers.authorization || '';
    const bearerKey = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : '';
    const fusionKey =
        req.headers['x-fusion-key'] ||
        req.headers['x-fusion-key'.toLowerCase()] ||
        req.query.key ||
        req.query.fusionKey ||
        bearerKey;
    const MY_SECRET_KEY = "FusionMusicPersonalKey2026"; // <-- Matches the Android app key
    const requireFusionKey = String(process.env.REQUIRE_FUSION_KEY || '').toLowerCase() === 'true';

    if (!fusionKey || fusionKey !== MY_SECRET_KEY) {
        const source = req.headers['cf-connecting-ip'] || req.ip || 'unknown';
        const ray = req.headers['cf-ray'] ? ` cfRay=${req.headers['cf-ray']}` : '';
        console.log(`[FUSION MUSIC] Missing/invalid Fusion key for ${req.method} ${req.originalUrl} ip=${source}${ray}. Allowing playback request. Set REQUIRE_FUSION_KEY=true to enforce blocking.`);
        if (requireFusionKey) {
            return res.status(403).send('Unauthorized: Invalid Fusion Connect Key');
        }
    }
    next();
});

// SEARCH ENDPOINT - uses play-dl with yt-dlp fallback
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing q parameter' });

    const cleanQuery = query.trim().toLowerCase();

    // Check if query is a direct YouTube URL
    const isYtUrl = query.includes('youtube.com/') || query.includes('youtu.be/') || query.includes('youtube.com/shorts/');
    if (isYtUrl) {
        console.log(`[FUSION MUSIC] Direct YouTube URL detected as search query: "${query}"`);
        // Try play-dl first
        try {
            if (play.yt_validate(query) === 'video') {
                const info = await play.video_basic_info(query);
                const video = info.video_details;
                const track = {
                    id: video.id,
                    title: video.title || 'Unknown',
                    artist: video.channel?.name || 'Unknown Artist',
                    thumbnailUrl: video.thumbnails[0]?.url || `https://img.youtube.com/vi/${video.id}/hqdefault.jpg`,
                    youtubeUrl: video.url,
                    durationMs: (video.durationInSec || 0) * 1000
                };
                console.log(`[FUSION MUSIC] Direct URL resolved via play-dl: "${track.title}" (${track.durationMs}ms)`);
                return res.json([track]);
            }
        } catch (err) {
            console.warn(`[FUSION MUSIC] play-dl direct URL resolution failed: ${err.message}. Trying yt-dlp...`);
        }

        // Fallback to yt-dlp for direct URL
        try {
            const videoId = extractVideoId(query);
            const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
            const spawnArgs = getYtdlpArgs([
                '-j',
                '--no-config',
                '--no-playlist',
                '--no-check-certificate',
                '--no-warnings',
                '--no-cache-dir',
                cleanUrl
            ]);
            const ytdlp = spawn('yt-dlp', spawnArgs);

            let output = '';
            let errorOutput = '';
            ytdlp.on('error', (err) => {
                console.error(`[FUSION MUSIC] Direct URL yt-dlp spawn failed:`, err.message);
            });
            ytdlp.stdout.on('data', (data) => { output += data.toString(); });
            ytdlp.stderr.on('data', (data) => { errorOutput += data.toString(); });

            ytdlp.on('close', (code) => {
                if (code === 0 && output.trim()) {
                    try {
                        const item = JSON.parse(output.trim());
                        const track = {
                            id: videoId,
                            title: item.title || 'Unknown',
                            artist: item.uploader || item.channel || 'Unknown Artist',
                            thumbnailUrl: item.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
                            youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
                            durationMs: (item.duration || 0) * 1000
                        };
                        console.log(`[FUSION MUSIC] Direct URL resolved via yt-dlp: "${track.title}" (${track.durationMs}ms)`);
                        return res.json([track]);
                    } catch (parseError) {
                        console.error(`[FUSION MUSIC] Direct URL yt-dlp Parse error: ${parseError.message}`);
                        return res.status(500).json({ error: 'Failed to resolve URL details' });
                    }
                } else {
                    console.error(`[FUSION MUSIC] Direct URL yt-dlp failed: ${errorOutput}`);
                    return res.status(500).json({ error: 'Failed to resolve URL details' });
                }
            });
            return;
        } catch (err) {
            console.error(`[FUSION MUSIC] yt-dlp direct URL fallback failed: ${err.message}`);
            return res.status(500).json({ error: 'Failed to resolve URL details' });
        }
    }

    const cachedResults = searchCache.get(cleanQuery);
    if (cachedResults) {
        console.log(`[FUSION MUSIC] [CACHE HIT] Returning cached results for: "${query}"`);
        return res.json(cachedResults);
    }

    // Try play-dl first (extremely fast, pure Node.js HTTPS API requests)
    try {
        console.log(`[FUSION MUSIC] [PLAY-DL] Searching for: "${query}"`);
        const searchResults = await play.search(query, { limit: 10 });
        const tracks = searchResults.map(item => {
            return {
                id: item.id,
                title: item.title || 'Unknown',
                artist: item.channel?.name || 'Unknown Artist',
                thumbnailUrl: item.thumbnails[0]?.url || (item.id ? `https://img.youtube.com/vi/${item.id}/hqdefault.jpg` : ''),
                youtubeUrl: item.url,
                durationMs: (item.durationInSec || 0) * 1000
            };
        }).filter(t => t.id);

        console.log(`[FUSION MUSIC] [PLAY-DL] Found ${tracks.length} tracks. Caching results.`);
        searchCache.set(cleanQuery, tracks);
        return res.json(tracks);
    } catch (err) {
        console.warn(`[FUSION MUSIC] [PLAY-DL] Search failed: ${err.message}. Falling back to yt-dlp...`);
    }

    // Fallback to yt-dlp search
    console.log(`[FUSION MUSIC] [CACHE MISS] Searching YouTube via yt-dlp for: "${query}"`);
    const ytdlp = spawn('yt-dlp', getYtdlpArgs([
        `ytsearch10:${query}`,
        '--flat-playlist',
        '--dump-json',
        '--no-config',
        '--no-warnings',
        '--no-playlist',
        '--no-check-certificate',
        '--no-cache-dir'
    ]));

    let output = '';
    let errorOutput = '';

    ytdlp.on('error', (err) => {
        console.error(`[FUSION MUSIC] Search fallback yt-dlp spawn failed:`, err.message);
    });
    ytdlp.stdout.on('data', (data) => { output += data.toString(); });
    ytdlp.stderr.on('data', (data) => { errorOutput += data.toString(); });

    ytdlp.on('close', (code) => {
        if (code !== 0 && output.trim().length === 0) {
            console.error(`[FUSION MUSIC] yt-dlp Search failed with code ${code}: ${errorOutput}`);
            return res.status(500).json({ error: 'Search failed' });
        }

        try {
            const lines = output.trim().split('\n').filter(l => l.trim());
            const tracks = lines.map(line => {
                const item = JSON.parse(line);
                const rawId = item.id || item.url || '';
                const videoId = extractVideoId(rawId);
                return {
                    id: videoId,
                    title: item.title || 'Unknown',
                    artist: item.uploader || item.channel || 'Unknown Artist',
                    thumbnailUrl: item.thumbnail || (videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : ''),
                    youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
                    durationMs: (item.duration || 0) * 1000
                };
            }).filter(t => t.id);

            console.log(`[FUSION MUSIC] yt-dlp Found ${tracks.length} tracks. Caching results.`);
            searchCache.set(cleanQuery, tracks);
            res.json(tracks);
        } catch (parseError) {
            console.error(`[FUSION MUSIC] yt-dlp Parse error: ${parseError.message}`);
            res.status(500).json({ error: 'Failed to parse search results' });
        }
    });
});

// PLAYLIST ENDPOINT - fetches playlist metadata and tracks via play-dl with yt-dlp fallback
app.get('/playlist', async (req, res) => {
    const playlistUrl = req.query.url;
    if (!playlistUrl) return res.status(400).json({ error: 'Missing url parameter' });

    // Try play-dl first
    try {
        console.log(`[FUSION MUSIC] [PLAY-DL] Fetching playlist: "${playlistUrl}"`);
        const playlistInfo = await play.playlist_info(playlistUrl, { incomplete: true });
        const allVideos = await playlistInfo.all_videos();
        const tracks = allVideos.map(item => {
            let trackTitle = item.title || 'Unknown Track';
            let trackArtist = item.channel?.name || 'Unknown Artist';

            if (trackTitle.includes(' - ')) {
                const parts = trackTitle.split(' - ');
                if (parts.length >= 2) {
                    trackArtist = parts[0].trim();
                    trackTitle = parts[1].trim();
                }
            }
            if (trackArtist.endsWith(' - Topic')) {
                trackArtist = trackArtist.replace(' - Topic', '');
            }

            return {
                id: item.id,
                title: trackTitle,
                artist: trackArtist,
                thumbnailUrl: item.thumbnails[0]?.url || (item.id ? `https://img.youtube.com/vi/${item.id}/hqdefault.jpg` : ''),
                youtubeUrl: item.url,
                durationMs: (item.durationInSec || 0) * 1000
            };
        }).filter(t => t.id);

        console.log(`[FUSION MUSIC] [PLAY-DL] Successfully fetched ${tracks.length} tracks.`);
        return res.json({
            title: playlistInfo.title || 'Imported Playlist',
            tracks: tracks
        });
    } catch (err) {
        console.warn(`[FUSION MUSIC] [PLAY-DL] Playlist fetch failed: ${err.message}. Trying yt-dlp fallback...`);
    }

    // Fallback to yt-dlp
    console.log(`[FUSION MUSIC] Queueing playlist via yt-dlp: "${playlistUrl}"`);
    await ytdlpSemaphore.acquire();
    console.log(`[FUSION MUSIC] [ACQUIRED] Fetching playlist via yt-dlp: "${playlistUrl}"`);

    const ytdlp = spawn('yt-dlp', getYtdlpArgs([
        playlistUrl,
        '--flat-playlist',
        '--dump-json',
        '--no-config',
        '--no-warnings',
        '--no-check-certificate',
        '--no-cache-dir'
    ]));

    let output = '';
    let errorOutput = '';

    ytdlp.on('error', (err) => {
        console.error(`[FUSION MUSIC] Playlist fallback yt-dlp spawn failed:`, err.message);
    });
    ytdlp.stdout.on('data', (data) => { output += data.toString(); });
    ytdlp.stderr.on('data', (data) => { errorOutput += data.toString(); });

    ytdlp.on('close', (code) => {
        ytdlpSemaphore.release();
        if (code !== 0 && output.trim().length === 0) {
            console.error(`[FUSION MUSIC] yt-dlp Playlist fetch failed with code ${code}: ${errorOutput}`);
            return res.status(500).json({ error: 'Failed to fetch playlist' });
        }

        try {
            const lines = output.trim().split('\n').filter(l => l.trim());
            let playlistTitle = 'Imported Playlist';
            const tracks = [];

            for (const line of lines) {
                try {
                    const item = JSON.parse(line);
                    const rawId = item.id || item.url || '';
                    const videoId = extractVideoId(rawId);
                    if (!videoId) continue;

                    if (item.playlist_title && playlistTitle === 'Imported Playlist') {
                        playlistTitle = item.playlist_title;
                    } else if (item.playlist && playlistTitle === 'Imported Playlist') {
                        playlistTitle = item.playlist;
                    }

                    let trackTitle = item.title || 'Unknown Track';
                    let trackArtist = item.uploader || item.channel || 'Unknown Artist';

                    if (trackTitle.includes(' - ')) {
                        const parts = trackTitle.split(' - ');
                        if (parts.length >= 2) {
                            trackArtist = parts[0].trim();
                            trackTitle = parts[1].trim();
                        }
                    }

                    if (trackArtist.endsWith(' - Topic')) {
                        trackArtist = trackArtist.replace(' - Topic', '');
                    }

                    tracks.push({
                        id: videoId,
                        title: trackTitle,
                        artist: trackArtist,
                        thumbnailUrl: item.thumbnail || (videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : ''),
                        youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
                        durationMs: (item.duration || 0) * 1000
                    });
                } catch (e) {
                    console.error(`[FUSION MUSIC] Failed to parse playlist line: ${e.message}`);
                }
            }

            console.log(`[FUSION MUSIC] yt-dlp Found ${tracks.length} tracks in playlist "${playlistTitle}".`);
            res.json({
                title: playlistTitle,
                tracks: tracks
            });
        } catch (parseError) {
            console.error(`[FUSION MUSIC] Parse error: ${parseError.message}`);
            res.status(500).json({ error: 'Failed to parse playlist results' });
        }
    });
});

// PRELOAD ENDPOINT - Pre-downloads/caches songs in the background
app.get('/preload', async (req, res) => {
    const urlsParam = req.query.urls;
    if (!urlsParam) return res.status(400).send('Missing urls parameter');

    const urls = urlsParam.split(',');
    console.log(`[FUSION MUSIC] [PRELOAD] Received request to preload ${urls.length} songs.`);

    // Run preload downloads in the background
    urls.forEach(async (encodedUrl) => {
        try {
            const videoUrl = decodeURIComponent(encodedUrl);
            const videoId = extractVideoId(videoUrl);
            if (!videoId) return;

            const cacheKey = `${videoId}_audio_high`;
            const filePath = path.join(CACHE_DIR, `${cacheKey}.m4a`);

            // If already fully cached or downloading, skip
            if (fs.existsSync(filePath) || activeDownloads.has(cacheKey)) {
                return;
            }

            // Check if a preload file already exists
            const files = fs.readdirSync(CACHE_DIR);
            const preloadFileName = files.find(f => f.startsWith(`${videoId}_audio_high.`) && f.endsWith('.preload'));
            if (preloadFileName) {
                return;
            }

            console.log(`[FUSION MUSIC] [PRELOAD] Preloading first 30s for song: ${videoId}`);
            preloadSong(videoUrl, videoId).catch(e => {
                console.error(`[FUSION MUSIC] [PRELOAD] Background preload failed for ${videoId}:`, e.message);
            });
        } catch (err) {
            console.error(`[FUSION MUSIC] [PRELOAD] Failed to queue preload for url:`, err.message);
        }
    });

    res.send('Preload queued');
});

// STREAMING ENDPOINT - Default FFmpeg engine with direct proxy fallback
app.get('/stream', async (req, res) => {
    const videoUrl = req.query.url;
    const format = req.query.format || 'audio';
    const quality = (req.query.quality || 'high').toLowerCase();

    if (!videoUrl) return res.status(400).send('Missing url parameter');

    let formatSpec = '140/251/bestaudio';
    if (format === 'video') {
        if (quality === 'low' || quality === 'normal') {
            formatSpec = '18/best[height<=360][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]';
        } else {
            formatSpec = '22/18/best[height<=720][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]';
        }
    } else {
        if (quality === 'low') {
            formatSpec = '139/140/ba[abr<=96]/worst/best';
        } else if (quality === 'normal') {
            formatSpec = '140/251/ba[abr<=160]/ba/best';
        } else if (quality === 'high') {
            formatSpec = '140/251/bestaudio[abr<=320]/bestaudio/best';
        } else {
            formatSpec = '140/251/bestaudio/best';
        }
    }

    const videoId = extractVideoId(videoUrl);
    const cacheKey = `${videoId}_${format}_${quality}`;
    const filePath = path.join(CACHE_DIR, `${cacheKey}.m4a`);
    const tempFilePath = `${filePath}.tmp`;

    // 1. If fully cached, serve immediately!
    if (format === 'audio' && fs.existsSync(filePath)) {
        console.log(`[FUSION MUSIC] [CACHE HIT] Serving cached audio file: ${cacheKey}`);
        touchFile(filePath);
        return res.sendFile(filePath);
    }

    // 1.5. If preload cached, serve preload + fetch remainder!
    if (format === 'audio' && quality === 'high') {
        const files = fs.readdirSync(CACHE_DIR);
        const preloadFileName = files.find(f => f.startsWith(`${videoId}_audio_high.`) && f.endsWith('.preload'));
        if (preloadFileName) {
            const parts = preloadFileName.split('.');
            const totalSize = parseInt(parts[parts.length - 2], 10);
            const preloadFilePath = path.join(CACHE_DIR, preloadFileName);

            if (fs.existsSync(preloadFilePath) && totalSize > 0) {
                console.log(`[FUSION MUSIC] [PRELOAD HIT] Serving preload + background loader for: ${videoId}`);
                touchFile(preloadFilePath);

                let startByte = 0;
                let endByte = totalSize - 1;

                if (req.headers.range) {
                    const parts = req.headers.range.replace(/bytes=/, "").split("-");
                    startByte = parseInt(parts[0], 10);
                    endByte = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
                }

                const preloadSize = fs.statSync(preloadFilePath).size;

                if (!Number.isFinite(startByte) || startByte < 0) startByte = 0;
                if (!Number.isFinite(endByte) || endByte < startByte) endByte = totalSize - 1;

                if (startByte < preloadSize && endByte < preloadSize) {
                    res.writeHead(206, {
                        'Content-Type': 'audio/mp4',
                        'Accept-Ranges': 'bytes',
                        'Content-Range': `bytes ${startByte}-${endByte}/${totalSize}`,
                        'Content-Length': (endByte - startByte) + 1
                    });

                    const preloadStream = fs.createReadStream(preloadFilePath, {
                        start: startByte,
                        end: Math.min(preloadSize - 1, endByte)
                    });
                    preloadStream.pipe(res);
                     
                    req.on('close', () => {
                        preloadStream.destroy();
                    });
                    return;
                } else if (startByte < preloadSize) {
                    console.log(`[FUSION MUSIC] Preload range ${startByte}-${endByte} crosses cached boundary ${preloadSize}. Using stable direct proxy.`);
                } else {
                    console.log(`[FUSION MUSIC] Seeking beyond preload range. Fetching bytes ${startByte}-${endByte} from YouTube.`);
                }
            }
        }
    }

    // 2. Trigger background cache download if not cached and not currently downloading
    if (format === 'audio' && !fs.existsSync(filePath) && !activeDownloads.has(cacheKey)) {
        console.log(`[FUSION MUSIC] [CACHE MISS] Triggering background download to cache for: ${cacheKey}`);
        downloadToCache(videoUrl, formatSpec, cacheKey, filePath, tempFilePath).catch(e => {
            console.error(`[FUSION MUSIC] [CACHE] Background cache download failed:`, e.message);
        });
    }

    try {
        // Step 1: Resolve stream URL using requested formats
        const streamData = await getDirectUrl(videoUrl, formatSpec, format);
        const directStreamUrl = streamData.url;
        const resolvedUserAgent = streamData.userAgent;

        if (false && hasFfmpeg && format === 'audio') {
            // Step 2: Stream using FFmpeg by default (performs live transcoding & reconnection buffering)
            console.log(`[FUSION MUSIC] [FFMPEG] Streaming audio via FFmpeg: ${videoUrl}`);
            
            res.writeHead(200, {
                'Content-Type': 'audio/mpeg',
                'Transfer-Encoding': 'chunked',
                'Accept-Ranges': 'none'
            });

            const ffmpegProcess = spawn('ffmpeg', [
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5',
                '-i', directStreamUrl,
                '-f', 'mp3',
                '-acodec', 'libmp3lame',
                '-ab', '128k',
                '-ar', '44100',
                '-ac', '2',
                '-'
            ]);

            ffmpegProcess.stdout.pipe(res);

            ffmpegProcess.on('error', (err) => {
                console.error(`[FUSION MUSIC] [FFMPEG] Process error:`, err.message);
            });

            req.on('close', () => {
                console.log(`[FUSION MUSIC] [FFMPEG] Client closed stream, cleaning up FFmpeg process.`);
                ffmpegProcess.kill('SIGKILL');
            });
            
            return;
        }

        // Direct HTTP Proxy fallback (or for video format)
        let attempts = 0;
        const maxAttempts = 2;

        async function tryProxyStream(bypassCache = false) {
            attempts++;
            try {
                const videoId = extractVideoId(videoUrl);
                const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
                const cacheKey = `${cleanUrl}_${formatSpec}`;

                if (bypassCache) {
                    console.log(`[FUSION MUSIC] Bypassing cache for retry attempt ${attempts} of: ${cleanUrl}`);
                    directUrlCache.store.delete(cacheKey);
                }

                const currentStreamData = await getDirectUrl(videoUrl, formatSpec, format);
                const streamUrl = currentStreamData.url;
                const streamUserAgent = currentStreamData.userAgent || resolvedUserAgent;

                // Build the headers to pass to Google Video
                const headers = {
                    'User-Agent': streamUserAgent
                };

                if (req.headers.range) {
                    headers['Range'] = req.headers.range;
                    console.log(`[FUSION MUSIC] Proxying range request for ${format.toUpperCase()} (attempt ${attempts}): ${req.headers.range}`);
                } else {
                    console.log(`[FUSION MUSIC] Proxying full stream request for ${format.toUpperCase()} (attempt ${attempts})`);
                }

                function performRequest(currentUrl) {
                    const parsedUrl = url.parse(currentUrl);
                    const options = {
                        hostname: parsedUrl.hostname,
                        path: parsedUrl.path,
                        method: 'GET',
                        headers: headers,
                        rejectUnauthorized: false,
                        agent: httpsAgent
                    };

                    let isAbortedForRetry = false;

                    const proxyReq = https.request(options, (proxyRes) => {
                        // Handle Redirects (301, 302, 303, 307, 308)
                        if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
                            console.log(`[FUSION MUSIC] Following proxy redirect to: ${proxyRes.headers.location}`);
                            proxyRes.resume();
                            performRequest(proxyRes.headers.location);
                            return;
                        }

                        if ((proxyRes.statusCode === 403 || proxyRes.statusCode === 410) && attempts < maxAttempts) {
                            console.log(`[FUSION MUSIC] Google returned ${proxyRes.statusCode} on attempt ${attempts}. Retrying with fresh URL...`);
                            isAbortedForRetry = true;
                            proxyReq.destroy();
                            tryProxyStream(true);
                            return;
                        }

                        if (res.headersSent || res.closed) {
                            proxyReq.destroy();
                            return;
                        }

                        res.status(proxyRes.statusCode);

                        if (proxyRes.statusCode === 403 || proxyRes.statusCode === 410) {
                            directUrlCache.store.delete(cacheKey);
                        }

                        const headersToForward = [
                            'content-type',
                            'content-length',
                            'content-range',
                            'accept-ranges',
                            'content-encoding'
                        ];

                        headersToForward.forEach(header => {
                            if (proxyRes.headers[header] && !res.headersSent) {
                                res.setHeader(header, proxyRes.headers[header]);
                            }
                        });

                        proxyRes.pipe(res);
                    });

                    proxyReq.on('error', (err) => {
                        if (isAbortedForRetry) return;
                        console.error(`[FUSION MUSIC] Upstream proxy connection error on attempt ${attempts}:`, err.message);
                        if (attempts < maxAttempts && !res.headersSent && !res.closed) {
                            tryProxyStream(true);
                        } else if (!res.headersSent && !res.closed) {
                            res.status(502).send('Error connecting to YouTube servers');
                        }
                    });

                    req.on('close', () => {
                        proxyReq.destroy();
                    });

                    proxyReq.end();
                }

                performRequest(streamUrl);

            } catch (err) {
                console.error(`[FUSION MUSIC] Failed to proxy stream on attempt ${attempts}:`, err.message);
                if (attempts < maxAttempts) {
                    tryProxyStream(true);
                } else if (!res.headersSent) {
                    res.status(500).send('Streaming resolution failed');
                }
            }
        }

        tryProxyStream(false);

    } catch (err) {
        console.error(`[FUSION MUSIC] Streaming failed:`, err.message);
        if (!res.headersSent) {
            res.status(500).send('Streaming failed: ' + err.message);
        }
    }
});

const server = app.listen(PORT, () => console.log(`[FUSION MUSIC] Core backend engine running on port ${PORT}`));
