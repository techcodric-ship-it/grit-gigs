const { Client } = require("ssh2");
const fs = require("fs");
const path = require("path");
const localRoot = path.join(__dirname, "..");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 60000 };
let out = "";
const LOCAL_FILES = ["feed.css", "feed-app.js", "feed.html"];
const files = [
  ["public/assets/feed.css", "public/feed.css"],
  ["public/assets/feed-app.js", "public/feed-app.js"],
  ["public/feed.html", "public/feed.html"],
  ["public/wallet.html", "public/wallet.html"],
  ["public/buy-more.html", "public/buy-more.html"],
  ["public/settings.html", "public/settings.html"],
  ["public/orders.html", "public/orders.html"]
];
const RESOLVE = L => { const p = path.join(localRoot, L); return fs.existsSync(p) ? fs.readFileSync(p) : null; };
c.on("ready", () => {
  c.sftp((err, sftp) => {
    if (err) { out += "[SFTP-ERR] " + err.message; return done(false); }
    let idx = 0;
    const next = () => {
      if (idx >= files.length) return done(true);
      const [src, dst] = files[idx++];
      const data = RESOLVE(src);
      if (data === null) { out += "[SKIP-MISSING] " + src + "\n"; return next(); }
      sftp.writeFile("/opt/gritgigs/" + dst, data, e => {
        if (e) { out += "[UPLOAD-FAIL " + dst + "] " + e.message + "\n"; } else { out += "[OK] " + dst + " (" + data.length + "B)\n"; }
        next();
      });
    };
    next();
  });
  function done(restart) {
    const bump = (buf) => buf.replace(/(assets\/feed\.css\?v=)\d+/, "$1" + (7 + Math.floor(Math.random() * 10)))
                            .replace(/(assets\/feed-app\.js\?v=)\d+/, "$1" + (6 + Math.floor(Math.random() * 10)));
    if (!restart) { c.end(); return; }
    out += "===BUMP+VERIFY===\n";
    const check = "cd /opt/gritgigs && echo ===ASSETS-CSS-PURPLE===; grep -oE -- '--signal: ?#[0-9a-f]+' public/assets/feed.css | head -3; echo ===ASSETS+ROOT-CSS-SIGNAL===; grep -oE -- '--signal: ?#[0-9a-f]+' public/feed.css public/assets/feed.css 2>/dev/null; echo ===FEED-REFS-AFTER===; grep -oE 'assets/feed(-app)?\\.(css|js)\\?v=[0-9]+' public/feed.html | head -6; echo ===PM2-RESTART===; pm2 restart gritgigs >/dev/null 2>&1 && echo RESTARTED; sleep 4; echo ===LIVE-VERIFY===; for p in feed orders wallet buy-more settings; do printf '%s:%%s\n' $p $(curl -s -o /dev/null -w '%%{http_code}' http://127.0.0.1:3000/$p); done; echo ===LIVE-SERVED-CSS-SIGNAL===; curl -s http://127.0.0.1:3000/assets/feed.css | grep -oE -- '--signal: ?#[0-9a-f]+' | head -3; echo ===LIVE-SERVED-LIKE-TXT===; curl -s http://127.0.0.1:3000/feed | grep -oE 'assets/feed(-app)?\\.(css|js)\\?v=[0-9]+' | head -4";
    c.exec(check, (err, stream) => {
      let buf = "";
      if (err) { out += "[VERIFY-EXEC-ERR] " + err.message; return c.end(); }
      stream.on("data", d => buf += d.toString());
      stream.stderr.on("data", d => buf += d.toString());
      stream.on("close", () => { out += buf + "\nVERIFY-DONE\n"; c.end(); });
    });
  }
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message) + "\n"; try { c.end(); } catch(_){} });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
