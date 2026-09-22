const { Client } = require("./node_modules/ssh2");
const c = new Client();
let out = "";
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 30000, keepaliveInterval: 15000 };

c.on("ready", () => {
  const cmds = [
    ["uname -srm; echo ---DISTRO---; cat /etc/os-release 2>/dev/null | head -5; echo ---NODE---; command -v node && node -v || echo NO-NODE; command -v npm && npm -v || echo NO-NPM; echo ---PM2---; command -v pm2 pm2-runtime || echo NO-PM2", "recon1"],
    ["echo ---PROC-QUERY---; pm2 ls 2>/dev/null | head -15 || echo no-pm2; echo ---DOCKER---; command -v docker && docker ps --format '{{.Names}} {{.Image}} {{.Ports}}' 2>/dev/null | head || echo NO-DOCKER; echo ---SYSTEMD-APP---; systemctl list-units --type=service --no-pager 2>/dev/null | grep -Ei 'node|grit|gig|grit-gigs|gritand' | head -8", "recon2"],
    ["echo ---WWW-ROOTS---; ls -la /var/www 2>/dev/null | head; echo ---APPS-ROOT---; ls -la /root 2>/dev/null | head -30; echo ---SRV---; ls -la /srv 2>/dev/null | head; echo ---HOME---; ls -la /home 2>/dev/null | head", "recon3"],
    ["echo ---PORTS---; ss -ltnp 2>/dev/null | head -25; echo ---DISK---; df -h / 2>/dev/null; echo ---MEM---; free -h 2>/dev/null | head -2; echo ---CPU---; nproc", "recon4"]
  ];
  let i = 0;
  const run = () => {
    if (i >= cmds.length) { c.end(); return; }
    const [cmd, tag] = cmds[i++];
    c.exec(cmd, (err, stream) => {
      if (err) { out += "\n[" + tag + "] EXECFAIL: " + err.message + "\n"; run(); return; }
      let buf = "";
      stream.on("data", d => buf += d.toString());
      stream.stderr.on("data", d => buf += d.toString());
      stream.on("close", () => { out += "\n===== " + tag.toUpperCase() + " =====\n" + buf.trim() + "\n"; run(); });
    });
  };
  run();
});
c.on("error", e => out += "\n[CONN-ERROR] " + (e.code || e.message) + "\n");
c.on("close", () => { console.log(out); process.exit(0); });
c.connect(H);