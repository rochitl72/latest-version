# ─────────────────────────────────────────────────────────────────────
# Frontend image — two stages
#   1) build : compile the React/Vite app to static files
#   2) serve : hand those files to nginx, which also reverse-proxies /api and
#              /health to the backend container, so the browser only ever
#              talks to one origin (no CORS, no second host to configure).
# ─────────────────────────────────────────────────────────────────────

# ─── Stage 1: build ──────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies from the lockfile first (cached unless deps change).
COPY package.json package-lock.json ./
RUN npm ci

# Optional: point the built frontend at a backend on a DIFFERENT host/port
# instead of the default same-origin nginx-proxy setup. Vite only reads
# VITE_-prefixed vars at build time, so it must be a build ARG, not a
# container-start ENV. Pass it with:
#   docker build --build-arg VITE_API_BASE_URL=http://192.168.1.50:8000 .
# or via docker-compose.yml's `build.args:` (see docker-compose.external-db.yml).
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

# Build the production bundle into /app/dist.
COPY . .
RUN npm run build

# ─── Stage 2: serve ──────────────────────────────────────────────────
FROM nginx:1.27-alpine

# SPA + reverse-proxy config (routes /api and /health to the backend service).
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Only the compiled assets ship in the final image — no Node, no source.
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
