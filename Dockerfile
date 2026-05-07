FROM node:20-alpine

RUN apk add --no-cache tzdata
ENV TZ=Asia/Seoul

RUN apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg \
    curl

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

RUN yt-dlp --version

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

RUN npm prune --production

RUN rm -rf src/ node_modules/@types/ *.md tsconfig.json

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=40s \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "dist/src/main.js"]
