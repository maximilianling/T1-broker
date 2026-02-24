# ================================================================
# T1 BROKER — DIGITALOCEAN PRODUCTION DEPLOYMENT GUIDE
# ================================================================

## Architecture Overview

```
Internet
    │
    ▼
┌──────────────────┐
│  DO Cloud Firewall │ ← Only ports 80/443/22
│  + Floating IP     │
└────────┬───────────┘
         │
    ┌────▼─────┐
    │  Nginx   │ ← SSL termination, WAF, rate limiting
    │  Droplet │    (or DO App Platform)
    └────┬─────┘
         │ :3000 (internal only)
    ┌────▼──────────────┐
    │  Node.js App      │ ← T1 Broker server
    │  (PM2 / Docker)   │
    └────┬──────┬───────┘
         │      │
   ┌─────▼──┐  ┌▼─────────────┐
   │ Managed │  │ Managed Redis│
   │ PG DB   │  │              │
   │ (DO)    │  │ (DO)         │
   └─────────┘  └──────────────┘
         │
   ┌─────▼──────────┐
   │ DO Spaces      │ ← Encrypted backup storage
   │ (S3-compatible)│
   └────────────────┘
```

## 1. DigitalOcean Resources Required

| Resource | Specification | Estimated Monthly Cost |
|----------|--------------|----------------------|
| Droplet (App Server) | 4 vCPU, 8GB RAM, 160GB SSD | ~$48/mo |
| Managed PostgreSQL | 2 vCPU, 4GB RAM, 38GB SSD | ~$60/mo |
| Managed Redis | 1 vCPU, 2GB RAM | ~$15/mo |
| Spaces (Object Storage) | 250GB + CDN | ~$5/mo |
| Floating IP | Static IP | Free (attached) |
| Cloud Firewall | Inbound rules | Free |
| **Total** | | **~$128/mo** |

## 2. Create Resources

### 2.1 — Managed PostgreSQL Database
```bash
doctl databases create t1-broker-db \
  --engine pg \
  --version 16 \
  --size db-s-2vcpu-4gb \
  --region nyc3 \
  --num-nodes 1

# Get connection string
doctl databases connection t1-broker-db --format URI
# Output: postgresql://t1admin:PASSWORD@t1-broker-db-do-user-xxxxx.b.db.ondigitalocean.com:25060/t1broker?sslmode=require

# CRITICAL: SSL is enforced by default on DO Managed Databases
# Our database.js already handles this with rejectUnauthorized: true
```

### 2.2 — Managed Redis
```bash
doctl databases create t1-broker-redis \
  --engine redis \
  --version 7 \
  --size db-s-1vcpu-2gb \
  --region nyc3

# Get connection URI
doctl databases connection t1-broker-redis --format URI
# Output: rediss://default:PASSWORD@t1-broker-redis-do-user-xxxxx.b.db.ondigitalocean.com:25061
# Note: rediss:// = TLS-encrypted Redis connection
```

### 2.3 — Spaces (Backup Storage)
```bash
# Create Space (S3-compatible bucket)
doctl compute spaces create t1-broker-backups \
  --region nyc3

# Create API keys for Spaces
# Go to: https://cloud.digitalocean.com/account/api/spaces
# Generate "Spaces access key" → gives you Key + Secret
```

### 2.4 — Droplet (App Server)
```bash
doctl compute droplet create t1-broker-app \
  --image ubuntu-24-04-x64 \
  --size s-4vcpu-8gb \
  --region nyc3 \
  --ssh-keys YOUR_SSH_KEY_FINGERPRINT \
  --tag-names "t1-broker,production" \
  --vpc-uuid YOUR_VPC_UUID
```

### 2.5 — Cloud Firewall
```bash
doctl compute firewall create \
  --name t1-broker-fw \
  --droplet-ids YOUR_DROPLET_ID \
  --inbound-rules "protocol:tcp,ports:22,address:YOUR_OFFICE_IP/32 protocol:tcp,ports:80,address:0.0.0.0/0 protocol:tcp,ports:443,address:0.0.0.0/0" \
  --outbound-rules "protocol:tcp,ports:all,address:0.0.0.0/0 protocol:udp,ports:all,address:0.0.0.0/0"
```

## 3. Security Configuration

### 3.1 — Environment Variables (.env)
```bash
# ── Application ──
NODE_ENV=production
PORT=3000
API_PREFIX=/api/v1

# ── Database (from DO Managed DB connection string) ──
DB_HOST=t1-broker-db-do-user-xxxxx.b.db.ondigitalocean.com
DB_PORT=25060
DB_NAME=t1broker
DB_USER=t1admin
DB_PASSWORD=STRONG_RANDOM_PASSWORD
DB_SSL=true
DB_POOL_MIN=5
DB_POOL_MAX=20

# ── Redis (from DO Managed Redis connection string) ──
REDIS_URL=rediss://default:PASSWORD@t1-broker-redis-do-user-xxxxx.b.db.ondigitalocean.com:25061

# ── JWT (generate with: openssl rand -hex 64) ──
JWT_SECRET=GENERATE_WITH_openssl_rand_hex_64
JWT_REFRESH_SECRET=GENERATE_DIFFERENT_WITH_openssl_rand_hex_64
JWT_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

# ── Encryption (generate with: openssl rand -hex 32) ──
ENCRYPTION_KEY=GENERATE_WITH_openssl_rand_hex_32
BACKUP_ENCRYPTION_KEY=GENERATE_DIFFERENT_WITH_openssl_rand_hex_32

# ── DigitalOcean Spaces (S3-compatible) ──
DO_SPACES_KEY=YOUR_SPACES_ACCESS_KEY
DO_SPACES_SECRET=YOUR_SPACES_SECRET_KEY
DO_SPACES_ENDPOINT=nyc3.digitaloceanspaces.com
DO_SPACES_REGION=nyc3
DO_SPACES_BUCKET=t1-broker-backups
S3_BUCKET=t1-broker-backups

# ── AWS CLI config (for DO Spaces via aws s3 command) ──
AWS_ACCESS_KEY_ID=${DO_SPACES_KEY}
AWS_SECRET_ACCESS_KEY=${DO_SPACES_SECRET}
AWS_DEFAULT_REGION=us-east-1

# ── CORS ──
CORS_ORIGIN=https://t1broker.com

# ── Backup ──
BACKUP_DIR=/var/backups/t1broker
```

### 3.2 — AWS CLI Configuration for DO Spaces
```bash
# Install AWS CLI (used by backup service for S3-compatible uploads)
apt install -y awscli

# Configure for DO Spaces
aws configure set aws_access_key_id YOUR_SPACES_KEY
aws configure set aws_secret_access_key YOUR_SPACES_SECRET
aws configure set default.region us-east-1

# Test connection
aws s3 ls --endpoint-url https://nyc3.digitaloceanspaces.com
```

### 3.3 — Managed Database Trusted Sources
```bash
# CRITICAL: Restrict DB access to only the app droplet
doctl databases firewalls append t1-broker-db \
  --rule droplet:YOUR_DROPLET_ID

# This ensures the database is ONLY accessible from your app server
# NOT from the public internet
```

### 3.4 — Managed Redis Trusted Sources
```bash
doctl databases firewalls append t1-broker-redis \
  --rule droplet:YOUR_DROPLET_ID
```

## 4. Server Setup

### 4.1 — Initial Droplet Configuration
```bash
# SSH into droplet
ssh root@YOUR_DROPLET_IP

# Create non-root user
adduser t1admin
usermod -aG sudo t1admin

# Disable root SSH login
sed -i 's/PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd

# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Install PM2 (process manager)
npm install -g pm2

# Install nginx
apt install -y nginx certbot python3-certbot-nginx

# Install PostgreSQL client (for pg_dump backups)
apt install -y postgresql-client-16

# Install fail2ban (brute-force protection on SSH)
apt install -y fail2ban
systemctl enable fail2ban
```

### 4.2 — SSL Certificate
```bash
# Get Let's Encrypt cert
certbot --nginx -d t1broker.com -d www.t1broker.com

# Auto-renewal is set up automatically by certbot
# Verify: systemctl list-timers | grep certbot
```

### 4.3 — Deploy Application
```bash
# As t1admin user
su - t1admin
mkdir -p /srv/t1broker
cd /srv/t1broker

# Upload / git clone your code here
# npm install --production

# Create backup directory
sudo mkdir -p /var/backups/t1broker
sudo chown t1admin:t1admin /var/backups/t1broker

# Copy .env file
cp .env.production .env

# Run database migrations
NODE_ENV=production npx knex migrate:latest

# Start with PM2
pm2 start server/index.js --name t1-broker --env production \
  --max-memory-restart 4G \
  --instances 2 \
  --exec-mode cluster

pm2 save
pm2 startup
```

### 4.4 — Nginx Configuration
```bash
# Copy the provided nginx config
sudo cp infrastructure/nginx/t1broker-secure.conf /etc/nginx/sites-available/t1broker
sudo cp infrastructure/nginx/proxy_params_t1.conf /etc/nginx/proxy_params_t1.conf
sudo ln -s /etc/nginx/sites-available/t1broker /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default

# Update SSL cert paths in config to match Let's Encrypt
sudo sed -i 's|/etc/ssl/certs/t1broker.crt|/etc/letsencrypt/live/t1broker.com/fullchain.pem|' /etc/nginx/sites-available/t1broker
sudo sed -i 's|/etc/ssl/private/t1broker.key|/etc/letsencrypt/live/t1broker.com/privkey.pem|' /etc/nginx/sites-available/t1broker

# Test and reload
sudo nginx -t && sudo systemctl reload nginx
```

## 5. Backup Security on DigitalOcean

### 5.1 — Daily Encrypted Backups Flow
```
pg_dump → .sql.gz → AES-256-GCM encrypt → .sql.gz.enc → DO Spaces upload
                                                              │
                                                    Private bucket
                                                    (no public access)
                                                    Server-side encryption
```

### 5.2 — Spaces Bucket Policy (private)
```bash
# Ensure bucket is PRIVATE (no public read)
# DO Spaces are private by default
# Verify via: Control Panel → Spaces → t1-broker-backups → Settings
# "File Listing" should be OFF
```

### 5.3 — Spaces Lifecycle Policy
```json
{
  "Rules": [
    {
      "ID": "expire-old-backups",
      "Status": "Enabled",
      "Prefix": "backups/",
      "Expiration": { "Days": 90 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 30 }
    }
  ]
}
```

### 5.4 — Enable Platform Settings for Backups
In the admin UI (Platform Settings → System), configure:
- `system.backup_enabled` = `true`
- `system.backup_s3_enabled` = `true`
- `system.backup_s3_bucket` = `t1-broker-backups`
- `system.backup_encryption_enabled` = `true`
- `system.backup_retention_days` = `90`

## 6. Monitoring & Alerts

### 6.1 — DO Monitoring Agent
```bash
curl -sSL https://repos.insights.digitalocean.com/install.sh | bash
```

### 6.2 — PM2 Monitoring
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 7
```

### 6.3 — Database Monitoring
DO Managed Databases include built-in monitoring:
- CPU / Memory / Disk usage
- Active connections
- Slow query logging (enable in DB settings)
- Automated daily backups (DO provides these automatically)

## 7. DO-Specific Security Compatibility Notes

| Feature | DO Compatibility | Notes |
|---------|-----------------|-------|
| Managed DB SSL | ✅ Native | SSL enforced by default, our config handles this |
| Managed Redis TLS | ✅ Native | Uses `rediss://` protocol |
| Spaces encryption | ✅ Server-side | AES-256 at rest on DO infrastructure |
| Cloud Firewall | ✅ | Replaces iptables for droplet-level filtering |
| VPC (Private Network) | ✅ | DB/Redis communicate over private network |
| Nginx rate limiting | ✅ | Full compatibility |
| Let's Encrypt SSL | ✅ | Certbot works normally |
| fail2ban | ✅ | SSH brute-force protection |
| pg_dump backups | ✅ | Connect via SSL to managed DB |
| Node.js cluster mode | ✅ | PM2 handles this |
| Helmet.js headers | ✅ | Full compatibility |
| Our WAF / API Firewall | ✅ | Application-level, platform-independent |
| Backup AES-256 encryption | ✅ | Our code, no DO dependency |

## 8. Security Checklist Before Going Live

- [ ] All `.env` secrets generated with `openssl rand -hex 64`
- [ ] DB/Redis firewall rules restrict to app droplet only
- [ ] Cloud Firewall allows only ports 22 (office IP), 80, 443
- [ ] SSL certificate installed and auto-renewing
- [ ] Root SSH login disabled
- [ ] fail2ban enabled
- [ ] Nginx config deployed with WAF rules
- [ ] PM2 running in cluster mode
- [ ] Backup encryption verified (test backup + download + decrypt)
- [ ] Spaces bucket is private (no public access)
- [ ] Admin security dashboard accessible and showing all-green
- [ ] Platform settings configured via admin UI
- [ ] pg-hardening.sql executed on managed database
- [ ] DO Monitoring agent installed
