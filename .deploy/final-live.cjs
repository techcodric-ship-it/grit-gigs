const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
c.on("ready", () => {
  const cmd = 'echo ===PUBLIC-DOMAIN-NAV-HREFS===; curl -s -L --max-time 20 https://gritandgigs.in/feed | grep -oE "href=\\"/[a-z-]+\\.html\\"" | sort -u; echo ===PUBLIC-PAGE-STATUS-ALL===; for p in feed orders wallet buy-more settings; do printf "%s=%s " $p $(curl -s -L -o /dev/null -w "%{http_code}" --max-time 20 https://gritandgigs.in/$p); done; echo';
  c.exec(cmd, (err, stream) => {
    if (err) { out += "[EXEC-ERR] " + err.message; return c.end(); }
    let b = "";
    stream.on("data", d => b += d.toString());
    stream.stderr.on("data", d => b += d.toString());
    stream.on("close", () => { out += b.trim(); c.end(); });
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
