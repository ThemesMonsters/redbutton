module.exports = {
  apps: [{
    name: "cryptobot-api",
    script: "/root/cryptobot/artifacts/api-server/dist/index.mjs",
    interpreter: "node",
    env: {
      NODE_ENV: "production",
      PORT: "8080",
    },
    env_file: "/root/cryptobot/.env",
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "400M",
    error_file: "/root/cryptobot/logs/err.log",
    out_file: "/root/cryptobot/logs/out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
  }]
};
