# Dockerfile.dev
FROM node:24-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY . .

RUN npm install
RUN npm run build
EXPOSE 5173
ENV PORT=5173
ENV BODY_SIZE_LIMIT=50M
CMD ["node", "scripts/start-app.mjs"]