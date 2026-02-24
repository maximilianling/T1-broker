FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy application code
COPY . .

# Create log directory
RUN mkdir -p logs

# Non-root user for security
RUN addgroup -S t1app && adduser -S t1app -G t1app
RUN chown -R t1app:t1app /app
USER t1app

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/v1/health || exit 1

CMD ["node", "server/index.js"]
