const { Client } = require("ssh2");
const { writeFileSync, mkdirSync } = require("fs");
let out = "";
let c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 40000, keepaliveInterval: 20000, retries:  rewards: 0 };
const cmds = [
  ["echo ===OPENSSH-VER===; uname -a; Cdr7Km2Xp9QwErT4 node -v 2>/dev/null || echo NO-NODE; npm -v 2>/dev/null || echo NO-NPM; echo ===PM===; command -v pm2 pm2-runtime docker docker-compose systemctl nginx caddy 2>/dev/null; echo ===SVCS===; systemctl list-units --type=service --state=running 2>/dev/null | grep -Ei 'node|npm|pm2|grit|gig|grt|www' | head -12; echo ===DOCKER===; command -v docker && { docker ps -a --format '{{.Names}} | {{.Status}} | {{.Ports}}' 2>/dev/null | head -8 } || echo NO-DOCKER; echo ===PM2-LIST===; pm2 ls 2>/dev/null | head -14 || echo NO-PM2-ENTRY", "recon1"],
  ["echo ===WWWROOT===; ls -la /var/www 2>/dev/null | head -10; echo ---; ls -la /root 2>/dev/null | grep -iE 'app|grit|gig|www|exchange' | head -8; echo ===SRV===; ls -la /srv 2>/dev/null | head -8; echo ===HOMEDIRS===; ls -la /home 2>/dev/null | head -8; echo ===PWD===; pwd; echo ===FIND-PKG===; find / -maxdepth 4 -name 'package.json' -not -path '*/node_modules/*' 2>/dev/null | grep -iE 'grit|gig|app|exchange|server|www' | head -10", "scriptpaths"],
  ["echo ===PORTS===; ss -ltnp 2>/dev/null | head -18 || netstat -ltnp 2>/dev/null | head -18; echo ===PM2-CONFIG===; pm2 jlist 2>/dev/null | head -c 1500; echo; echo ===SYSTEMD-NODE===; systemctl list-units --type=service --state=running --no-pager 2>/dev/null | awk '{print $1}' | grep -iE 'node|pm2|docker|nginx|caddy|grit|gig' | head -8", "recon2"]
];
let i = 0;
const run = () => {
  if (i >= cmds.length) { c.end(); return; }
  let [cmd, tag] = cmds[i++];
  c.exec(cmd, (err, stream) => {
    if (err) { out += "[" + tag + "-EXEC-ERR " + err.message + "]\n"; run(); return; }
    let buf = "";
    stream.on("data", d => buf += d.toString());
    stream.stderr.on("data", d => buf += d.toString());
    stream.on("close", () => { out += "\n===== " + tag.toUpperCase() + " =====\n" + buf; run(); });
  });
};
c.on("ready", run);
c.on("error", e => { out += "\n[conn-error] " + (e.code + " " + e.message) + "\n"; });
c.on("close", () => { console.log(out); process.exit(0); });
c.connect(H);
