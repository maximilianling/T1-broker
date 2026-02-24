# T1 Broker Platform

Multi-asset brokerage platform with Saxo Bank and DriveWealth sub-broker integration, omnibus account management, white-label partner framework, and full compliance infrastructure.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    CLIENT LAYER                               │
│  Web App (HTML/JS) │ Mobile (React Native) │ Partner APIs     │
└────────────────────────────┬─────────────────────────────────┘
                             │ HTTPS / WSS
┌────────────────────────────┴─────────────────────────────────┐
│                    T1 BROKER CORE                             │
│                                                               │
│  Express.js REST API  │  WebSocket Server  │  Webhook Handlers│
│                                                               │
│  ┌─────────┐ ┌───────────┐ ┌─────────────┐ ┌──────────────┐ │
│  │  Auth    │ │  Order    │ │  Position   │ │  Compliance  │ │
│  │  (JWT+   │ │  Mgmt     │ │  Tracking   │ │  (Audit,KYC, │ │
│  │  MFA+    │ │  Service  │ │  & P&L      │ │  AML,Recon)  │ │
│  │  RBAC)   │ │           │ │             │ │              │ │
│  └─────────┘ └─────┬─────┘ └─────────────┘ └──────────────┘ │
│                     │                                         │
│              ┌──────┴──────┐                                  │
│              │   ROUTER    │   Routes orders to the right     │
│              │  US equity  │──→ DriveWealth                   │
│              │  Intl/FX    │──→ Saxo Bank                     │
│              └─────────────┘                                  │
│                                                               │
│  PostgreSQL  │  Redis  │  Kafka (future)  │  S3 (docs)       │
└──────────────────────────────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              │      SUB-BROKER LAYER       │
              │                              │
              │  ┌──────────┐ ┌───────────┐ │
              │  │DriveWealth│ │ Saxo Bank │ │
              │  │ US Equity │ │ OpenAPI   │ │
              │  │ Fractional│ │ FX/Intl/  │ │
              │  │ T+1       │ │ Options   │ │
              │  └──────────┘ └───────────┘ │
              └─────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/CSS/JS (production: React/Next.js) |
| API Server | Node.js + Express.js |
| Real-time | WebSocket (ws library) |
| Database | PostgreSQL 16 + Knex.js |
| Cache | Redis 7 |
| Auth | JWT + bcrypt + speakeasy (TOTP MFA) |
| Encryption | AES-256-CBC (field-level PII) |
| Sub-brokers | Saxo Bank OpenAPI, DriveWealth REST API |
| Containers | Docker + Docker Compose |
| Logging | Winston (structured JSON) |

## Quick Start

### Option 1: Docker (recommended)

```bash
# Clone and start
docker-compose up -d

# Seed test data
docker-compose exec app node database/seed.js

# Open browser
open http://localhost:3000
```

### Option 2: Local development

```bash
# Prerequisites: Node.js 20+, PostgreSQL 16+

# Install dependencies
npm install

# Create database
createdb t1broker

# Configure environment
cp .env.example .env
# Edit .env with your PostgreSQL credentials

# Run migrations
npm run db:migrate

# Seed test data
npm run db:seed

# Start server
npm run dev

# Open browser
open http://localhost:3000
```

### Test Credentials

All passwords: `T1Broker@2025!`

| Role | Email | Access |
|------|-------|--------|
| Super Admin | sarah@t1broker.com | Full platform access |
| Admin | mike@t1broker.com | Operations management |
| Compliance | lisa@t1broker.com | Audit, KYC, reports |
| Partner | ahmed@dubaibrokerage.ae | Partner dashboard |
| Client | john@email.com | Trading, portfolio |

## API Reference

Base URL: `http://localhost:3000/api/v1`

### Authentication

```
POST   /auth/login           Login (returns JWT or MFA challenge)
POST   /auth/mfa/verify      Complete MFA verification
POST   /auth/mfa/setup       Enable MFA (returns QR code)
POST   /auth/mfa/confirm     Confirm MFA setup with first code
POST   /auth/register        Register new client account
POST   /auth/refresh          Refresh access token
POST   /auth/logout           Invalidate session
```

### Orders

```
POST   /orders               Place new order
GET    /orders                List orders (filtered by role)
GET    /orders/:id            Get order details + fills
DELETE /orders/:id            Cancel order
```

### Positions

```
GET    /positions             List open positions
POST   /positions/snapshot    Create EOD position snapshot (admin)
```

### Market Data

```
GET    /market/instruments    Search tradable instruments
GET    /market/quotes/:sym    Get live quote for symbol
GET    /market/watchlist      Get user's watchlist
```

### Clients

```
GET    /clients               List clients (admin/partner)
GET    /clients/me            Get own client profile
GET    /clients/:id           Get client detail (admin)
POST   /clients               Create client (admin)
PATCH  /clients/:id           Update client (admin)
```

### Transfers

```
POST   /transfers             Create deposit/withdrawal
GET    /transfers             List transfers
```

### Partners

```
GET    /partners              List partner brokers (admin)
POST   /partners              Onboard new partner (admin)
```

### Admin

```
GET    /admin/dashboard        Platform-wide statistics
GET    /admin/audit            Query audit log
POST   /admin/audit/verify     Verify audit chain integrity
POST   /admin/transfers/:id/approve  Dual-authorize transfer
GET    /admin/reconciliation   Get reconciliation status
GET    /admin/reports/:type    Generate report
```

Report types: `trade-blotter`, `position-snapshot`, `cash-movement`, `commission`

### WebSocket

Connect to `ws://localhost:3000/ws`

```json
// Authenticate
{ "type": "auth", "token": "your_jwt_token" }

// Subscribe to market data
{ "type": "subscribe", "channels": ["market:AAPL", "market:BTC/USD"] }

// Subscribe to admin events
{ "type": "subscribe", "channels": ["admin"] }
```

Inbound message types: `market_data`, `order_update`, `notification`, `admin_event`

### Webhooks

```
POST   /webhooks/drivewealth   DriveWealth order fill notifications
POST   /webhooks/saxo          Saxo Bank order status updates
```

## Database Schema

### Core Tables

- **users** — Authentication, roles, MFA
- **clients** — Client profiles, KYC, risk scoring
- **partners** — White-label partner configuration
- **instruments** — Tradeable instruments with broker mappings
- **orders** — Full order lifecycle with broker routing
- **order_fills** — Individual fill records
- **positions** — Live position tracking per broker
- **accounts** — Cash balances per client per broker
- **cash_transactions** — Deposits, withdrawals with dual-auth

### Compliance Tables

- **audit_log** — Immutable, hash-chained audit trail
- **client_documents** — KYC document management
- **reconciliation_runs** — Daily T1↔broker matching
- **reconciliation_breaks** — Unresolved discrepancies

### Features

- UUID primary keys
- Row-Level Security (RLS) policies
- Hash-chained audit log (SHA-512)
- Field-level encryption for PII (AES-256-CBC)
- Auto-generated order references (ORD-XXXXX)
- Trigger-based updated_at timestamps
- Comprehensive indexing strategy

## Security Architecture

### Authentication & Access
- JWT with 15-minute expiry + refresh tokens
- TOTP-based MFA (Google Authenticator / Authy)
- RBAC with 9 distinct roles
- Session tracking with single-session enforcement
- Account lockout after 5 failed attempts (30 min)
- IP whitelisting for admin access

### Data Protection
- TLS 1.3 in transit (configure at load balancer)
- AES-256-CBC encryption for PII fields
- bcrypt (cost=12) for password hashing
- SHA-256 for token storage
- SHA-512 for audit event hashing

### Transaction Security
- Dual authorization (maker-checker) for withdrawals >$10K
- 48-hour cooling-off period for new bank accounts
- Idempotency keys on all order/transfer endpoints
- Rate limiting (100 req/15min general, 10/15min auth)

### Audit & Compliance
- Append-only audit log with hash chain
- Chain integrity verification endpoint
- Configurable data retention
- Full request logging with correlation IDs

## Order Routing Logic

```
Instrument received
    │
    ├── US Equity (NASDAQ/NYSE/AMEX) ──→ DriveWealth
    │     • Fractional shares supported
    │     • T+1 settlement
    │
    ├── FX / Options / Bonds ──→ Saxo Bank OpenAPI
    │     • Multi-asset coverage
    │     • International markets
    │
    └── Crypto ──→ Saxo Bank (or configurable)
```

## Project Structure

```
t1-platform/
├── server/
│   ├── index.js              # Express app entry point
│   ├── config/
│   │   ├── index.js          # Environment configuration
│   │   └── database.js       # PostgreSQL connection pool
│   ├── middleware/
│   │   ├── auth.js           # JWT, RBAC, MFA, IP whitelist
│   │   └── validation.js     # Joi request validation schemas
│   ├── routes/
│   │   ├── auth.js           # Login, register, MFA, refresh
│   │   ├── orders.js         # Order CRUD + placement
│   │   ├── clients.js        # Client management + KYC
│   │   ├── positions.js      # Position tracking + snapshots
│   │   └── api.js            # Market, transfers, partners, admin
│   ├── services/
│   │   ├── saxo.js           # Saxo Bank OpenAPI integration
│   │   ├── drivewealth.js    # DriveWealth API integration
│   │   ├── orders.js         # Order routing & lifecycle
│   │   ├── reconciliation.js # Daily position/cash matching
│   │   └── websocket.js      # Real-time market data & events
│   └── utils/
│       ├── logger.js         # Winston structured logging
│       ├── encryption.js     # AES-256 field encryption
│       └── audit.js          # Immutable audit trail service
├── client/
│   └── public/
│       ├── index.html        # Full interactive frontend
│       └── api-client.js     # API client + WebSocket layer
├── database/
│   ├── schema.sql            # Complete PostgreSQL DDL
│   ├── knexfile.js           # Knex configuration
│   ├── migrate.js            # Migration runner
│   └── seed.js               # Test data seeder
├── docker-compose.yml        # Full stack orchestration
├── Dockerfile                # Production container
├── package.json
├── .env.example
└── README.md
```

## Production Deployment Checklist

- [ ] Replace all secrets in .env with cryptographically random values
- [ ] Enable TLS termination at load balancer
- [ ] Configure Saxo Bank production API credentials
- [ ] Configure DriveWealth production API credentials
- [ ] Set up VPN / Cloudflare Access for admin routes
- [ ] Enable PostgreSQL SSL
- [ ] Configure WAF rules (AWS WAF / Cloudflare)
- [ ] Set up SIEM integration (Datadog / Splunk)
- [ ] Enable database backups (hourly snapshots)
- [ ] Configure log shipping to centralized logging
- [ ] Set up PagerDuty / Slack alerts for critical audit events
- [ ] Run penetration test
- [ ] Regulatory review of compliance workflows
- [ ] Load test order submission pipeline

## License

Proprietary — T1 Broker Platform
