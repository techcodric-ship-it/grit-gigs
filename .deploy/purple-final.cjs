const { Client } = require("ssh2");
const fs = require("fs");
const path = require("path");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 60000 };
let out = "";
const LOCAL = {
  "public/assets/feed.css": path.join(__dirname, "..", "public", "assets", "feed.css"),
  "public/assets/feed-app.js": path.join(__dirname, "..", "public", "assets", "feed-app.js"),
  "public/feed.css": path.join(__dirname, "..", "public", "feed.css"),
  "public/feed-app.js": path.join(__dirname, "..", "public", "feed-app.js"),
  "public/feed.html": path.join(__dirname, "..", "public", "feed.html")
};
const read = p => fs.existsSync(p) ? fs.readFileSync(p) : null;
c.on("ready", () => {
  c.sftp((err, sftp) => {
    if (err) { out += "[SFTP-ERR] " + err.message; return c.end(); }
    const files = Object.keys(LOCAL).map(dst => ({ dst, data: read(LOCAL[dst]) }));
    let i = 0;
    const next = () => {
      if (i >= files.length) return bumpAndVerify(sftp);
      const f = files[i++];
      if (f.data === null) { out += "[SKIP-MISSING] " + f.dst + "\n"; return next(); }
      sftp.writeFile("/opt/gritgigs/" + f.dst, f.data, e => {
        if (e) out += "[UPLOAD-FAIL " + f.dst + "] " + e.message + "\n";
        else out += "[OK] " + f.dst + " (" + f.data.length + "B)\n";
        next();
      });
    };
    next();
    function bumpAndVerify(sftp) {
      const cmd = "cd /opt/gritgigs && echo ===ON-BOX-PURPLE===; grep -hoE -- '--signal: ?#[0-9a-f]+' public/assets/feed.css public/feed.css 2>/dev/null | sort -u; echo ===BEFORE-REFS===; grep -oE 'assets/(feed\\.css|feed-app\\.js)\\?v=[0-9]+' public/feed.html | sort -u; echo ===BUMP-UP===; sed -i -E 's#(assets/feed\\.css\\?v=)[0-9]+#\\114#; s#(assets/feed-app\\.js\\?v=)[0-9]+#\\113#' public/feed.html && grep -oE 'assets/(feed\\.css|feed-app\\.js)\\?v=[0-9]+' public/feed.html | sort -u; echo ===RESTART===; pm2 restart gritgigs >/dev/null 2>&1 && echo PM2-RESTARTED; sleep 6; echo ===SERVED-ASSET-PURPLE===; curl -s http://127.0.0.1:3000/assets/feed.css | grep -oE -- '--signal: ?#[0-9a-f]+' | head -1; echo ===SERVED-ROOT-PURPLE===; curl -s http://127.0.0.1:3000/feed.css | grep -oE -- '--signal: ?#[0-9a-f]+' | head -1; echo ===SERVED-HTML-REFS===; curl -s http://127.0.0.1:3000/feed | grep -oE 'assets/(feed\\.css|feed-app\\.js)\\?v=[0-9]+' | sort -u; echo ===STATUSES===; for p in feed orders wallet buy-more settings; do printf '%s=%%s ' $p $(curl -s -o /dev/null -w '%%{http_code}' http://127.0.0.1:3000/$p); done; echo";
      c.exec(cmd, (err, stream) => {
        if (err) { out += "[EXEC-ERR] " + err.message; return c.end(); }
        let buf = "";
        stream.on("data", d => buf += d.toString());
        stream.stderr.on("data", d => buf += d.toString());
        stream.on("close", () => { out += buf; c.end(); });
      });
    }
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
