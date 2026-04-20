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

# Copy service code (exclude node_modules to preserve correct symlinks)
COPY services/${SERVICE} /tmp/service_src
RUN cp -a /tmp/service_src/. /app/service/ 2>/dev/null; \
    rm -rf /app/service/node_modules /tmp/service_src && \
    sed -i 's|file:../../shared|file:/app/shared|g' package.json && \
    npm install --omit=dev --no-audit --no-fund

# Gateway needs db/migrations for provisionOrg
COPY db /app/db

EXPOSE 80
CMD ["npm", "start"]
