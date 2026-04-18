# Shared Dockerfile. docker-compose passes SERVICE=<dir under services/>.
FROM node:20-alpine

ARG SERVICE
ENV NODE_ENV=production

WORKDIR /app

# Copy shared package and install it
COPY shared /app/shared
RUN cd /app/shared && npm install --omit=dev --no-audit --no-fund

# Copy service package.json and fix the shared dependency path
COPY services/${SERVICE}/package.json /app/service/package.json

WORKDIR /app/service
RUN sed -i 's|file:../../shared|file:/app/shared|g' package.json && \
    npm install --omit=dev --no-audit --no-fund

COPY services/${SERVICE} /app/service

EXPOSE 80
CMD ["npm", "start"]
