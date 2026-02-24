#!/bin/bash
# ================================================================
# T1 BROKER — PRODUCTION SETUP SCRIPT
# Usage: ./scripts/setup.sh [local|docker|k8s]
# ================================================================
set -euo pipefail

MODE=${1:-local}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[T1]${NC} $1"; }
warn() { echo -e "${YELLOW}[T1]${NC} $1"; }
error() { echo -e "${RED}[T1]${NC} $1"; exit 1; }

# ================================================================
# CHECK PREREQUISITES
# ================================================================
check_prereqs() {
  log "Checking prerequisites..."

  command -v node >/dev/null 2>&1 || error "Node.js is required (v20+)"
  NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  [ "$NODE_VER" -ge 20 ] || error "Node.js v20+ required (found v$NODE_VER)"
  log "  ✓ Node.js $(node -v)"

  command -v npm >/dev/null 2>&1 || error "npm is required"
  log "  ✓ npm $(npm -v)"

  if [ "$MODE" = "docker" ] || [ "$MODE" = "k8s" ]; then
    command -v docker >/dev/null 2>&1 || error "Docker is required"
    log "  ✓ Docker $(docker --version | cut -d' ' -f3)"
  fi

  if [ "$MODE" = "k8s" ]; then
    command -v kubectl >/dev/null 2>&1 || error "kubectl is required"
    log "  ✓ kubectl $(kubectl version --client --short 2>/dev/null)"
  fi
}

# ================================================================
# GENERATE SECRETS
# ================================================================
generate_secrets() {
  log "Generating secure secrets..."

  JWT_SECRET=$(openssl rand -hex 32)
  JWT_REFRESH_SECRET=$(openssl rand -hex 32)
  ENCRYPTION_KEY=$(openssl rand -hex 32)
  DB_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)
  REDIS_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)

  cat > "$PROJECT_DIR/.env" <<EOF
NODE_ENV=production
PORT=3000
API_PREFIX=/api/v1

DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-5432}
DB_NAME=${DB_NAME:-t1broker}
DB_USER=${DB_USER:-t1admin}
DB_PASSWORD=${DB_PASSWORD}
DB_SSL=${DB_SSL:-false}
DB_POOL_MIN=5
DB_POOL_MAX=30

JWT_SECRET=${JWT_SECRET}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
JWT_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

ENCRYPTION_KEY=${ENCRYPTION_KEY}

REDIS_HOST=${REDIS_HOST:-localhost}
REDIS_PORT=${REDIS_PORT:-6379}
REDIS_PASSWORD=${REDIS_PASSWORD}

SAXO_BASE_URL=https://gateway.saxobank.com/openapi
SAXO_APP_KEY=${SAXO_APP_KEY:-}
SAXO_APP_SECRET=${SAXO_APP_SECRET:-}

DW_BASE_URL=https://bo-api.drivewealth.io/back-office
DW_API_KEY=${DW_API_KEY:-}
DW_API_SECRET=${DW_API_SECRET:-}

EMAIL_PROVIDER=${EMAIL_PROVIDER:-console}
EMAIL_FROM=noreply@t1broker.com

RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=200

CORS_ORIGIN=${CORS_ORIGIN:-http://localhost:3000}
MFA_ISSUER=T1Broker
LOG_LEVEL=info

S3_BUCKET=${S3_BUCKET:-t1-broker-documents}
AWS_REGION=${AWS_REGION:-us-east-1}
UPLOAD_PATH=uploads/
EOF

  log "  ✓ .env file generated with secure random secrets"
  warn "  ⚠ Add your Saxo Bank and DriveWealth API keys to .env"
}

# ================================================================
# LOCAL SETUP
# ================================================================
setup_local() {
  log "Setting up for local development..."

  cd "$PROJECT_DIR"
  log "Installing dependencies..."
  npm ci

  generate_secrets

  # Check if PostgreSQL is running
  if command -v psql >/dev/null 2>&1; then
    log "Creating database..."
    createdb t1broker 2>/dev/null || warn "Database 't1broker' may already exist"

    log "Running migrations..."
    npm run db:migrate

    log "Seeding test data..."
    npm run db:seed
  else
    warn "PostgreSQL CLI not found — please run migrations manually:"
    warn "  npm run db:migrate && npm run db:seed"
  fi

  log ""
  log "✅ Local setup complete!"
  log "   Start with: npm run dev"
  log "   Open: http://localhost:3000"
}

# ================================================================
# DOCKER SETUP
# ================================================================
setup_docker() {
  log "Setting up with Docker..."

  cd "$PROJECT_DIR"
  generate_secrets

  # Override DB/Redis hosts for Docker networking
  sed -i 's/DB_HOST=localhost/DB_HOST=postgres/' .env
  sed -i 's/REDIS_HOST=localhost/REDIS_HOST=redis/' .env

  log "Building and starting containers..."
  docker-compose up -d --build

  log "Waiting for database to be ready..."
  sleep 10

  log "Seeding test data..."
  docker-compose exec -T app node database/seed.js

  log ""
  log "✅ Docker setup complete!"
  log "   App:      http://localhost:3000"
  log "   Postgres: localhost:5432"
  log "   Redis:    localhost:6379"
}

# ================================================================
# KUBERNETES SETUP
# ================================================================
setup_k8s() {
  log "Setting up for Kubernetes..."

  cd "$PROJECT_DIR"

  log "Building Docker image..."
  docker build -t ghcr.io/t1-broker/platform:latest .

  log "Applying Kubernetes manifests..."
  kubectl apply -f k8s/deployment.yml

  warn "Remember to:"
  warn "  1. Update secrets in k8s/deployment.yml with real values"
  warn "  2. Set up TLS certificates (cert-manager)"
  warn "  3. Configure external PostgreSQL and Redis"
  warn "  4. Push Docker image to your registry"

  log ""
  log "✅ Kubernetes setup initiated!"
}

# ================================================================
# MAIN
# ================================================================
log "T1 Broker Platform — Setup ($MODE)"
log "=================================="
check_prereqs

case $MODE in
  local)  setup_local  ;;
  docker) setup_docker ;;
  k8s)    setup_k8s    ;;
  *)      error "Usage: $0 [local|docker|k8s]" ;;
esac
