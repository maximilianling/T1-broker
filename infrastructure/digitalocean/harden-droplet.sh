#!/bin/bash
# ================================================================
# T1 BROKER — DIGITALOCEAN DROPLET HARDENING SCRIPT
# Run as root on a fresh Ubuntu 24.04 droplet
# ================================================================
set -euo pipefail

echo "═══════════════════════════════════════"
echo "  T1 Broker — Server Hardening"
echo "═══════════════════════════════════════"

# ── 1. System Updates ──
echo "→ Updating system packages..."
apt update && apt upgrade -y

# ── 2. Create non-root user ──
echo "→ Creating t1admin user..."
if ! id "t1admin" &>/dev/null; then
  adduser --disabled-password --gecos "" t1admin
  usermod -aG sudo t1admin
  echo "t1admin ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/t1admin
  # Copy SSH keys from root
  mkdir -p /home/t1admin/.ssh
  cp /root/.ssh/authorized_keys /home/t1admin/.ssh/
  chown -R t1admin:t1admin /home/t1admin/.ssh
  chmod 700 /home/t1admin/.ssh
  chmod 600 /home/t1admin/.ssh/authorized_keys
fi

# ── 3. SSH Hardening ──
echo "→ Hardening SSH..."
cat > /etc/ssh/sshd_config.d/t1-hardening.conf << 'SSHEOF'
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
AllowUsers t1admin
Protocol 2
SSHEOF
systemctl restart sshd

# ── 4. Firewall (UFW) ──
echo "→ Configuring firewall..."
apt install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable
echo "Firewall active — only SSH, HTTP, HTTPS allowed"

# ── 5. Fail2Ban (brute-force protection) ──
echo "→ Installing fail2ban..."
apt install -y fail2ban
cat > /etc/fail2ban/jail.local << 'F2BEOF'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 3
backend = systemd

[sshd]
enabled = true
port = ssh
filter = sshd
maxretry = 3
bantime = 86400

[nginx-limit-req]
enabled = true
port = http,https
filter = nginx-limit-req
logpath = /var/log/nginx/error.log
maxretry = 10
bantime = 3600
F2BEOF
systemctl enable fail2ban
systemctl restart fail2ban

# ── 6. Unattended Security Updates ──
echo "→ Enabling automatic security updates..."
apt install -y unattended-upgrades
cat > /etc/apt/apt.conf.d/50unattended-upgrades << 'UUEOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Automatic-Reboot "false";
UUEOF
dpkg-reconfigure -plow unattended-upgrades

# ── 7. Kernel / Sysctl Hardening ──
echo "→ Applying kernel security parameters..."
cat > /etc/sysctl.d/99-t1-hardening.conf << 'SYSEOF'
# Disable IP forwarding
net.ipv4.ip_forward = 0
net.ipv6.conf.all.forwarding = 0

# SYN flood protection
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 4096

# Ignore ICMP redirects (prevent MITM)
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0

# Don't send ICMP redirects
net.ipv4.conf.all.send_redirects = 0

# Ignore broadcast pings (Smurf attack prevention)
net.ipv4.icmp_echo_ignore_broadcasts = 1

# Log Martian packets (spoofed source IPs)
net.ipv4.conf.all.log_martians = 1

# Reverse path filtering (anti-spoofing)
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Disable source routing
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0

# Increase connection tracking table
net.netfilter.nf_conntrack_max = 131072

# TCP keepalive (detect dead connections faster)
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 60
net.ipv4.tcp_keepalive_probes = 5

# Increase file descriptor limits
fs.file-max = 65536
SYSEOF
sysctl -p /etc/sysctl.d/99-t1-hardening.conf

# ── 8. File Descriptor Limits ──
echo "→ Increasing file descriptor limits..."
cat >> /etc/security/limits.conf << 'LIMEOF'
t1admin soft nofile 65536
t1admin hard nofile 65536
LIMEOF

# ── 9. Create Application Directories ──
echo "→ Creating application directories..."
mkdir -p /srv/t1broker
mkdir -p /var/backups/t1broker
mkdir -p /var/log/t1broker
chown -R t1admin:t1admin /srv/t1broker /var/backups/t1broker /var/log/t1broker

# ── 10. Install Required Software ──
echo "→ Installing Node.js, nginx, PostgreSQL client..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs nginx postgresql-client-16 awscli
npm install -g pm2

# ── 11. Install DO Monitoring Agent ──
echo "→ Installing DigitalOcean monitoring agent..."
curl -sSL https://repos.insights.digitalocean.com/install.sh | bash

# ── 12. Disable Unnecessary Services ──
echo "→ Disabling unnecessary services..."
systemctl disable --now snapd.service 2>/dev/null || true
systemctl disable --now snapd.socket 2>/dev/null || true

# ── 13. Set Timezone ──
timedatectl set-timezone UTC

echo ""
echo "═══════════════════════════════════════"
echo "  ✅ Server hardening complete!"
echo "═══════════════════════════════════════"
echo ""
echo "  Next steps:"
echo "  1. Deploy application to /srv/t1broker"
echo "  2. Configure .env with production secrets"
echo "  3. Set up nginx (copy t1broker-secure.conf)"
echo "  4. Run: certbot --nginx -d t1broker.com"
echo "  5. Start: pm2 start ecosystem.config.js --env production"
echo ""
echo "  ⚠️  SSH as root is now DISABLED."
echo "  Use: ssh t1admin@$(curl -s ifconfig.me)"
echo ""
