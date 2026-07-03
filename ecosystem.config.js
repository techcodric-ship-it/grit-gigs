module.exports = {
  apps: [{
    name: "swiftexchange",
    script: "src/index.ts",
    interpreter: "node_modules/.bin/tsx",
    instances: "max",
    exec_mode: "cluster",
    env: {
      NODE_ENV: "production",
    },
    max_memory_restart: "1G",
    error_file: "logs/err.log",
    out_file: "logs/out.log",
    merge_logs: true,
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
  }],
};
