const { Client } = require("ssh2");
const c = new Client();
let out = "";
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 30000, keepaliveInterval: 15000 };

c.on("ready", () => {
  const cmds = [
    ["uname -srm; echo ---; cat /etc/os-release 2>/dev/null | head -4; echo ---NODE---; command -v node && node -v || echo NO-NODE; command -v npm && npm -v || echo NO-NPM; echo ---PM2---; command -v pm2 pm2-runtime || echo NO-PM2; echo ---DD---; command -v docker && docker ps 2>/dev/null | head -6 || echo NO-DOCKER; echo ---SVC---; systemctl list-units --type=service --no-pager 2>/dev/null | grep -Ei 'node|grit|gig|pm2|nginx|apache|caddy' | head -12", "recon", false, 60000],
    ["echo ---WWW-166.19.81.122---; ls -la /var/www 2>/dev/null | head; ls -la /root 2>/dev/null | head -25; ls -la /home 2>/dev/null | head; echo ---SRV-DIRS---; ls -la /srv 2>/dev/null | head; find / -maxdepth 3 -type d -iname '*grit*' 2>/dev/null | head; find / -maxdepth 3 -type d -iname '*gig*' 2>/dev/null | head", "dirs", false, 60000],
    ["echo ---PORTS---; ss -ltnp 2>/dev/null | head -25; echo ---DISK---; df -h / /tmp 2>/dev/null; echo ---MEM---; free -m | head -3", "ports", false, 45000]
  ];
  let i = 0;
  const run = () => {
    if (i >= cmds.length) { c.end(); return; }
    const [cmd, tag] = cmds[i++];
    c.exec(cmd, (err, stream) => {
      if (err) { out += "\n[" + tag + "] EXEC-ERR: " + err.message + "\n"; run(); return; }
      let buf = "";
      stream.on("data", d => buf += d.toString());
      stream.stderr.on("data", d => buf += d.toString());
      stream.on("close", () => { out += "\n===== " + tag.toUpperCase() + " =====\n" + buf; run(); });
    });
  };
  run();
});
c.on("error", e => { out += "\n[CONN-ERROR] " + e.code + " " + e.message + "\n"; try { c.end(); } catch(_){} });
c.on("close", () => { console.log(out); process.exit(0); });
c.connect(H);
