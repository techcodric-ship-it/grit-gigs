const { Client } = require("ssh2");
const c = new Client();
let out = "";
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000 };
c.on("ready", () => {
  const cmd = "for p in feed wallet buy-more settings orders; do echo ====$p====; echo ---CSS-REF---; curl -s http://127.0.0.1:3000/$p | grep -oE 'href=\"/[^\"]*\\.css[^\"]*\"' | sort -u; echo ---NAV-HREFS-LIMIT---; curl -s http://127.0.0.1:3000/$p | grep -oE '<a href=\"/(wallet|orders|settings|buy-more|profile|feed)[^\"]*\"' | sort -u | head -8; done; echo ====ROOT-CSS-SIGNAL-ON-BOX-DISK====; grep -hE -- '--signal: ?#[0-9a-f]+' /opt/gritgigs/public/feed.css /opt/gritgigs/public/settings.html 2>/dev/null | head -2";
  let b = "";
  c.exec(cmd, (err, stream) => {
    if (err) { out += "[EXEC-ERR] " + err.message; return c.end(); }
    stream.on("data", d => b += d.toString());
    stream.stderr.on("data", d => b += d.toString());
    stream.on("close", () => { out += b; c.end(); });
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
