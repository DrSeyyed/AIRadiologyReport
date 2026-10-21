# Dockerfile.dev
FROM node:24-alpine

WORKDIR /app
COPY . .

RUN npm install
RUN npm run build
EXPOSE 5173
ENV PORT=5173
ENV BODY_SIZE_LIMIT=50M
CMD ["sh","-lc","npm run db:init && npm run db:seed && node build --host 0.0.0.0 --port ${PORT:-5173}"]