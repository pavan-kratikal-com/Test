# Shared Dockerfile. docker-compose passes SERVICE=<dir under services/>.
FROM node:20-alpine

ARG SERVICE
ENV NODE_ENV=production

WORKDIR /app

# Shared package first so the install step caches across services.
COPY shared /app/shared
COPY services/${SERVICE}/package.json /app/service/package.json

# Install with the relative file: link to /app/shared.
WORKDIR /app/service
RUN npm install --omit=dev --no-audit --no-fund

COPY services/${SERVICE} /app/service

EXPOSE 80
CMD ["npm", "start"]
