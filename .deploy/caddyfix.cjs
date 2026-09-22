const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
c.on("ready", () => {
  const cmd = "cd /etc/caddy && cp Caddyfile Caddyfile.bak.$(date +%s) && echo ===BEFORE===; cat Caddyfile; echo; echo ===PATCH-INSIDE-SITEBLOCK===; node - <<'EOF'\nconst fs = require('fs');\nconst p = '/etc/caddy/Caddyfile';\nlet s = fs.readFileSync(p, 'utf8');\nif (s.includes('nofetch') && s.indexOf('@nofetch') < s.indexOf('gritandgigs')) { s = s.replace(/@nofetch \\{[^}]*\\}\\n?/g, ''); }\ns = s.replace(/reverse_proxy 127\\.0\\.0\\.1:3000\\n\\}/, 'reverse_proxy 127.0.0.1:3000\\n\\t@nofetch {\\n\\t\\tpath *.html /feed /orders /wallet /buy-more /settings\\n\\t}\\n\\theader @nofetch Cache-Control \"no-store, no-cache, must-revalidate\"\\n\\theader @nofetch Pragma \"no-cache\"\\n\\theader @nofetch Expires \"0\"\\n}');\nfs.writeFileSync(p, s);\nconsole.log('PATCHED');\nEOF\n; echo ===AFTER===; cat Caddyfile; echo; echo ===VALIDATE===; caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -3; caddy fmt --overwrite /etc/caddy/Caddyfile 2>&1; echo ===RELOAD===; systemctl reload caddy 2>&1; echo RELOAD-EXIT=$?; sleep 2; echo ===LIVE-HEADERS===; for p in feed feed.html orders orders.html wallet wallet.html buy-more settings settings.html feed-app.js feed.css; do printf '%-12s ' $p; curl -s -I -L --max-time 20 https://gritandgigs.in/$p | grep -iE '^HTTP/|cache-control|pragma|expires' | tr '\n' ' ' ; echo; done";
  c.exec(cmd, (err, stream) => {
    if (err) { out += "[EXEC-ERR] " + err.message; return c.end(); }
    let b = "";
    stream.on("data", d => b += d.toString());
    stream.stderr.on("data", d => b += d.toString());
    stream.on("close", () => { out += b.trim(); c.end(); });
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
