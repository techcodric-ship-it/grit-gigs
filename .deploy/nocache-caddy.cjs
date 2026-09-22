const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 60000 };
let out = "";
c.on("ready", () => {
  const cmd = "echo ===CADDY-BEFORE===; tail -10 /etc/caddy/Caddyfile; echo ===APPENDING-HEADERS===; printf '%s\n' '' '@nofetch {' '    path *.html /wallet /buy-more /settings /orders /feed' '}' 'header @nofetch Cache-Control \"no-store, no-cache, must-revalidate\"' 'header @nofetch Pragma \"no-cache\"' 'header @nofetch Expires \"0\"' >> /etc/caddy/Caddyfile && echo APPENDED; echo ===CADDY-AFTER===; tail -10 /etc/caddy/Caddyfile; echo ===RELOADING===; caddy reload --config /etc/caddy/Caddyfile 2>&1 | head -3 && echo CADDY-RELOADED || systemctl reload caddy 2>&1 | head -3 && echo SYS-RELOADED; sleep 3; echo ===PUBLIC-HEADERS-VERIFY===; for p in feed orders wallet buy-more settings feed.html orders.html; do printf '%s: ' $p; curl -s -I --max-time 20 https://gritandgigs.in/$p 2>/dev/null | grep -iE '^HTTP/|^cache-control|^pragma|^expires' | tr '\n' ' '; echo; done; echo ===STATUS-CODES===; for p in feed wallet settings orders buy-more; do printf '%s=%s ' $p $(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://gritandgigs.in/$p); done; echo; echo ===ALL-DONE===";
  c.exec(cmd, (err, stream) => {
    if (err) { out += "[EXEC-ERR] " + err.message; return c.end(); }
    let buf = "";
    stream.on("data", d => buf += d.toString());
    stream.stderr.on("data", d => buf += d.toString());
    stream.on("close", () => { out += buf.trim(); c.end(); });
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
