const { Client } = require("ssh2");
const fs = require("fs");
const path = require("path");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 70000, keepaliveInterval: 25000 };
let out = "";
const files = ["feed.html","wallet.html","buy-more.html","settings.html","orders.html"];
const localRoot = path.join(__dirname, "..");
c.on("ready", () => {
  c.sftp((err, sftp) => {
    if (err) { out += "[SFTP-ERR] " + err.message; return c.end(); }
    let i = 0;
    const next = () => {
      if (i >= files.length) return verify(sftp);
      const name = files[i++];
      const lp = path.join(localRoot, "public", name);
      if (!fs.existsSync(lp)) { out += "[SKIP-MISSING] " + name + "\n"; return next(); }
      const data = fs.readFileSync(lp);
      sftp.writeFile("/opt/gritgigs/public/" + name, data, e => {
        if (e) out += "[UPLOAD-FAIL " + name + "] " + e.message + "\n";
        else out += "[OK] " + name + " (" + data.length + "B)\n";
        next();
      });
    };
    next();
    function verify(sftp) {
      const cmd = "grep -c 'href=\"/buy-more.html\"' /opt/gritgigs/public/{feed,wallet,buy-more,settings,orders}.html; echo ===NAV-PRESENT-SVG===; grep -l 'svg viewBox=\"0 0 24 24\"' /opt/gritgigs/public/{feed,wallet,buy-more,settings,orders}.html | wc -l; echo ===EMOJI-NAV-LEFT===; grep -lE 'title=\"(Wallet|Buy more|Orders|Settings|Feed)\"[[:space:]]*>[%₹➕📦⚙🏠]' /opt/gritgigs/public/*.html 2>/dev/null | wc -l; echo ===RESTART===; pm2 restart gritgigs >/dev/null 2>&1 && echo PM2-OK; sleep 5; echo ===LIVE-CHECK===; for p in feed wallet buy-more settings orders; do printf '%s=%s ' $p $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/$p); done; echo; echo ===LIVE-NAV-BUYMORE-REFS===; for p in feed wallet settings orders; do printf '%s:' $p; curl -s http://127.0.0.1:3000/$p | grep -o 'href=\"/buy-more.html\"' | wc -l; done; echo ===LIVE-FEED-NAV-EMOJI-COUNT===; curl -s http://127.0.0.1:3000/feed | grep -oE 'title=\"[A-Za-z ]+\"[^>]*>[^<]{1,2}' | head -6";
      c.exec(cmd, (err, stream) => {
        let buf = "";
        if (err) { out += "[VERIFY-ERR] " + err.message; return c.end(); }
        stream.on("data", d => buf += d.toString());
        stream.stderr.on("data", d => buf += d.toString());
        stream.on("close", () => { out += buf.trim(); c.end(); });
      });
    }
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message) + "\n"; });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
