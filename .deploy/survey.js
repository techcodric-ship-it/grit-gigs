const { Client } = require("ssh2");
const c = new Client();
let out = "";
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 30000, keepaliveInterval: 15000 };

c.on("ready", () => {
  const cmds = [
    ["echo ===OS===; uname -srm; grep -E '^(NAME|VERSION)=' /etc/os-release 2>/dev/null; echo ===NODE===; (command -v node && node -v) || echo NO-NODE; (command -v npm && npm -v) || echo NO-NPM; echo ===PM===; (command -v pm2 pm2-runtime) || echo NO-PM2; (command -v docker) && docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | head || echo NO-DOCKER; echo ===SVCS===; systemctl list-units --type=service --state=running 2>/dev/null | grep -Ei 'grit|gig|node|www' | head; echo ===WWW===; ls -la /var/www 2>/dev/null | head -12; ls -la /root 2>/dev/null | head -20; echo ===PORTS===; ss -ltnp 2>/dev/null | head -15; echo ===DISK===; df -h / | tail -1; free -m | head -2", "a"],
    ["echo ===DIRS===; find / -maxdepth 3 -type d \( -iname '*grit*' -o -iname '*gigs*' -o -iname '*exchange*' -o -iname '*node_app*' \) 2>/dev/null | head; echo ===APPFILES===; find /root /var /srv /opt /home -maxdepth 4 -name 'package.json' 2>/dev/null | head -12; echo ===CRON===; crontab -l 2>/dev/null | head", "b"]
  ];
  let i = 0;
  const run = () => {
    if (i >= cmds.length) { c.end(); return; }
    const [cmd] = cmds[i++];
    c.exec(cmd, (err, stream) => {
      if (err) { out += "\n[ERR] " + err.message; run(); return; }
      let buf = "";
      stream.on("data", d => buf += d.toString());
      stream.stderr.on("data", d => buf += d.toString());
      stream.on("close", () => { out += buf; run(); });
    });
  };
  run();
});
c.on("error", e => { console.error("[CONN] " + (e.code || e.message)); process.exit(1); });
c.on("close", () => { console.log(out); process.exit(0); });
c.connect(H);