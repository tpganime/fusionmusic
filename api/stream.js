import http from "http";
import https from "https";
import fs from "fs";
import { spawn } from "child_process";
import { MongoClient } from "mongodb";
import * as play from "play-dl";

const FUSION_KEY = "FusionMusicPersonalKey2026";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60_000,
});

let directUrlCache = globalThis.__fusionDirectUrlCache;
if (!directUrlCache) {
  directUrlCache = new Map();
  globalThis.__fusionDirectUrlCache = directUrlCache;
}

let mongoClientPromise = globalThis.__fusionMongoClientPromise;

async function getMongoDb() {
  if (!process.env.MONGO_URI) return null;

  if (!mongoClientPromise) {
    const client = new MongoClient(process.env.MONGO_URI, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 8_000,
    });
    mongoClientPromise = client.connect();
    globalThis.__fusionMongoClientPromise = mongoClientPromise;
  }

  const client = await mongoClientPromise;
  return client.db(process.env.MONGO_DB_NAME);
}

function setCommonHeaders(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "x-fusion-key, authorization, range, content-type, accept, user-agent"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "content-length, content-range, accept-ranges, content-type, x-fusion-stream-source"
  );
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
}

function isAuthorized(req) {
  const authHeader = req.headers.authorization || "";
  const bearerKey = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const suppliedKey =
    req.headers["x-fusion-key"] ||
    req.query?.key ||
    req.query?.fusionKey ||
    bearerKey;

  return suppliedKey === FUSION_KEY;
}

function extractVideoId(input = "") {
  const str = String(input).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) return str;

  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /shorts\/([a-zA-Z0-9_-]{11})/,
    /embed\/([a-zA-Z0-9_-]{11})/,
    /live\/([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = str.match(pattern);
    if (match) return match[1];
  }

  return "";
}

function getFormatSpec(format, quality) {
  const cleanFormat = String(format || "audio").toLowerCase();
  const cleanQuality = String(quality || "high").toLowerCase();

  if (cleanFormat === "video") {
    if (cleanQuality === "low" || cleanQuality === "normal") {
      return "18/best[height<=360][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]";
    }
    return "22/18/best[height<=720][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]";
  }

  if (cleanQuality === "low") return "139/140/ba[abr<=96]/worst/best";
  if (cleanQuality === "normal") return "140/251/ba[abr<=160]/ba/best";
  if (cleanQuality === "high") return "140/251/bestaudio[abr<=320]/bestaudio/best";
  return "140/251/bestaudio/best";
}

function cacheGet(key) {
  const item = directUrlCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    directUrlCache.delete(key);
    return null;
  }
  return item.value;
}

function cacheSet(key, value, ttlMs = 3 * 60 * 60 * 1000) {
  directUrlCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

async function resolveWithPlayDl(videoUrl, formatSpec) {
  const videoId = extractVideoId(videoUrl);
  const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const videoInfo = await play.video_info(cleanUrl);
  const isVideo =
    formatSpec.includes("height") ||
    formatSpec.startsWith("22/") ||
    formatSpec.startsWith("18/");

  let selectedFormat;
  const requestedItags = formatSpec
    .split("/")
    .map((part) => parseInt(part, 10))
    .filter((itag) => !Number.isNaN(itag));

  for (const itag of requestedItags) {
    selectedFormat = videoInfo.format.find((format) => format.itag === itag);
    if (selectedFormat?.url) break;
  }

  if (!selectedFormat) {
    selectedFormat = isVideo
      ? videoInfo.format.find((format) => format.hasVideo && format.hasAudio && format.container === "mp4")
      : videoInfo.format.find((format) => format.mimeType?.startsWith("audio/"));
  }

  if (!selectedFormat?.url) {
    throw new Error("play-dl resolved video info but returned no playable stream URL");
  }

  return {
    url: selectedFormat.url,
    userAgent: DEFAULT_USER_AGENT,
    contentType: selectedFormat.mimeType?.split(";")[0] || (isVideo ? "video/mp4" : "audio/mp4"),
  };
}

function getCookieArgs() {
  const args = [];
  const cookieFile = process.env.YOUTUBE_COOKIES_FILE || "/tmp/cookies.txt";
  const cookieText = process.env.YOUTUBE_COOKIES_TXT || process.env.YOUTUBE_COOKIES || "";
  const cookieBase64 = process.env.YOUTUBE_COOKIES_BASE64 || "";

  try {
    if (cookieText.trim()) {
      fs.writeFileSync(cookieFile, cookieText.replace(/\\n/g, "\n"));
      args.push("--cookies", cookieFile);
    } else if (cookieBase64.trim()) {
      fs.writeFileSync(cookieFile, Buffer.from(cookieBase64.trim(), "base64").toString("utf8"));
      args.push("--cookies", cookieFile);
    }
  } catch {
    // Ignore cookie materialization failures; yt-dlp will surface the real extractor error.
  }

  return args;
}

function resolveWithYtdlp(videoUrl, formatSpec) {
  return new Promise((resolve, reject) => {
    const videoId = extractVideoId(videoUrl);
    const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const args = [
      "-f",
      formatSpec,
      "-j",
      "--no-config",
      "--no-playlist",
      "--no-check-certificate",
      "--no-warnings",
      "--no-cache-dir",
      "--no-check-formats",
      "--force-ipv4",
      "--socket-timeout",
      "15",
      "--extractor-args",
      "youtube:player_client=android,ios,web",
      ...getCookieArgs(),
      cleanUrl,
    ];

    const child = spawn("yt-dlp", args);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new Error(`yt-dlp spawn failed: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0 || !stdout.trim()) {
        reject(new Error(`yt-dlp failed: ${stderr.trim() || `exit code ${code}`}`));
        return;
      }

      try {
        const metadata = JSON.parse(stdout.trim());
        if (!metadata.url) throw new Error("yt-dlp metadata has no url");
        resolve({
          url: metadata.url,
          userAgent:
            metadata.http_headers?.["User-Agent"] ||
            metadata.http_headers?.["user-agent"] ||
            DEFAULT_USER_AGENT,
          contentType: metadata.mime_type || metadata.ext || "audio/mp4",
        });
      } catch (error) {
        reject(new Error(`yt-dlp JSON parse failed: ${error.message}`));
      }
    });
  });
}

async function getDirectUrl(videoUrl, formatSpec, format) {
  const videoId = extractVideoId(videoUrl);
  const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const cacheKey = `${cleanUrl}_${formatSpec}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let resolved;
  if (String(format).toLowerCase() === "video") {
    try {
      resolved = await resolveWithPlayDl(cleanUrl, formatSpec);
    } catch {
      resolved = await resolveWithYtdlp(cleanUrl, formatSpec);
    }
  } else {
    try {
      resolved = await resolveWithPlayDl(cleanUrl, formatSpec);
    } catch {
      resolved = await resolveWithYtdlp(cleanUrl, formatSpec);
    }
  }

  cacheSet(cacheKey, resolved);
  return resolved;
}

function proxyMediaUrl(req, res, mediaUrl, userAgent, fallbackContentType) {
  const parsedUrl = new URL(mediaUrl);
  const transport = parsedUrl.protocol === "http:" ? http : https;
  const headers = {
    "User-Agent": userAgent || DEFAULT_USER_AGENT,
    Accept: "*/*",
    Connection: "keep-alive",
  };

  if (req.headers.range) headers.Range = req.headers.range;

  const proxyReq = transport.request(
    {
      hostname: parsedUrl.hostname,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: "GET",
      headers,
      rejectUnauthorized: false,
      agent: parsedUrl.protocol === "https:" ? httpsAgent : undefined,
    },
    (proxyRes) => {
      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        proxyRes.resume();
        proxyMediaUrl(req, res, proxyRes.headers.location, userAgent, fallbackContentType);
        return;
      }

      res.statusCode = proxyRes.statusCode || 200;
      res.setHeader("Content-Type", proxyRes.headers["content-type"] || fallbackContentType || "audio/mp4");

      ["content-length", "content-range", "accept-ranges", "content-encoding", "etag", "last-modified"].forEach(
        (header) => {
          if (proxyRes.headers[header]) res.setHeader(header, proxyRes.headers[header]);
        }
      );

      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (error) => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end(`Stream proxy failed: ${error.message}`);
    } else {
      res.end();
    }
  });

  req.on("close", () => {
    if (!res.writableEnded) proxyReq.destroy();
  });

  proxyReq.end();
}

async function recordStreamRequest(req, videoId, format, quality) {
  try {
    const db = await getMongoDb();
    if (!db) return;

    await db.collection(process.env.MONGO_STREAM_COLLECTION || "stream_requests").insertOne({
      videoId,
      format,
      quality,
      ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "",
      createdAt: new Date(),
    });
  } catch {
    // Never break playback because analytics logging failed.
  }
}

export default async function handler(req, res) {
  setCommonHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const route = req.query?.route || "";
  if (route === "health" || req.url?.startsWith("/health")) {
    const db = await getMongoDb().catch(() => null);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        service: "fusion-music-vercel",
        hasMongo: Boolean(db),
        hasMongoUri: Boolean(process.env.MONGO_URI),
      })
    );
    return;
  }

  const requireFusionKey = String(process.env.REQUIRE_FUSION_KEY || "").toLowerCase() === "true";
  if (requireFusionKey && !isAuthorized(req)) {
    res.statusCode = 403;
    res.end("Unauthorized: Invalid Fusion Connect Key");
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const rawUrl = req.query?.url || body.url;
  const format = String(req.query?.format || body.format || "audio").toLowerCase();
  const quality = String(req.query?.quality || body.quality || "high").toLowerCase();

  if (!rawUrl) {
    res.statusCode = 400;
    res.end("Missing url parameter");
    return;
  }

  const videoId = extractVideoId(rawUrl);
  if (!videoId) {
    res.statusCode = 400;
    res.end("Invalid YouTube url parameter");
    return;
  }

  try {
    await recordStreamRequest(req, videoId, format, quality);

    const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const formatSpec = getFormatSpec(format, quality);
    const streamData = await getDirectUrl(cleanUrl, formatSpec, format);

    res.setHeader("X-Fusion-Stream-Source", "vercel-direct");
    proxyMediaUrl(
      req,
      res,
      streamData.url,
      streamData.userAgent,
      streamData.contentType || (format === "video" ? "video/mp4" : "audio/mp4")
    );
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(`Streaming failed: ${error.message}`);
    } else {
      res.end();
    }
  }
}
