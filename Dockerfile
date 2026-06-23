FROM node:20-slim

# Install Python and ffmpeg (required for yt-dlp audio extraction)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Download and install the latest yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install

# Fixed into a single line
COPY . .

# Changed to match your server.js port 3000
EXPOSE 3000
ENV PORT=3000

CMD ["node", "server.js"]
