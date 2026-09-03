# Grit&Gigs production image — Hetzner / Docker
# Build:  docker build -t grit-gigs .
# Run:    docker run -d --name grit-gigs --env-file .env -p 3000:5000 --restart unless-stopped grit-gigs

FROM node:22-slim

# dumb-init forwards signals so PM2/node shut down cleanly; curl for healthchecks
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install JS deps first for better layer caching
COPY package.json package-lock.json* ./
RUN npm install -g npm@11.11.0
RUN npm install

# Copy source + public assets
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY drizzle.config.js* ./

# The container only needs the runtime port; HTTPS is terminated by Caddy.
ENV NODE_ENV=production
EXPOSE 5000

# dumb-init keeps PID 1 sane; npm start runs `tsx src/index.ts`.
CMD ["dumb-init", "npm", "start"]
