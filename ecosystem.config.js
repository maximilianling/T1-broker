// ================================================================
// T1 BROKER — PM2 ECOSYSTEM CONFIG
// Production process management with cluster mode
// ================================================================
module.exports = {
  apps: [{
    name: 't1-broker',
    script: 'server/index.js',
    instances: 2,                    // 2 workers (adjust based on vCPUs)
    exec_mode: 'cluster',
    max_memory_restart: '4G',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,

    // Environment
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000,
    },

    // Logging
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: '/var/log/t1broker/error.log',
    out_file: '/var/log/t1broker/out.log',
    merge_logs: true,
    log_type: 'json',

    // Graceful shutdown
    kill_timeout: 30000,
    listen_timeout: 10000,
    shutdown_with_message: true,

    // Health check
    min_uptime: 10000,
    max_restarts: 15,
  }],
};
