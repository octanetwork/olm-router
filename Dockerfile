FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source and config
COPY . .

# Ensure data directory exists
RUN mkdir -p /app/data

EXPOSE 8045 51121

ENV NODE_ENV=production
ENV PORT=8045
ENV HOST=0.0.0.0

CMD ["node", "src/server.mjs"]
