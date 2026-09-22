const { Client } = require("ssh2");
const fs = require("fs");
const path = require("path");
const c = new Client();
const REMOTE = "/opt/gritgigs";
const PUB = REMOTE + "/public";
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 60000, keepaliveInterval: 20000 };
let out = "";
let failed = [];
const FILES = [
  "public/wallet.html", "public/buy-more.html", "public/settings.html",
  "public/feed.html", "public/orders.html", "public/feed-app.js",
  "public/feed.css", "public/feed.css", "public/styles.css",
  "public/settings.css", "public/assets/feed.css", "public/assets/feed-app.js",
  "public/assets/styles.css"
];
const localRoot = path.join(__dirname, "..");
function resolve(L) {
  const p = path.join(localRoot, L);
  return fs.existsSync(p) ? p : null;
}
c.on("ready", () => {
  const sftp = () => c.sftp((err, sftp) => {
    if (err) { out += "[SFTP-INIT-ERR] " + err.message + "\n"; return finish(); }
    const uploads = FILES.map(L => ({ remote: PUB + "/" + path.posix.join(...L.split(path.sep).slice(1)), local: resolve(L) }))
      .filter(f => f.local);
    out += "FILES-TO-UPLOAD=" + uploads.length + "\n";
    if (uploads.length === 0) { out += "NOTHING-TO-UPLOAD\n"; return finish(); }
    let idx = 0;
    const next = () => {
      if (idx >= uploads.length) return finish();
      const u = uploads[idx++];
      const src = fs.readFileSync(u.local);
      sftp.writeFile(u.remote, src, (e) => {
        if (e) { out += "[UPLOAD-FAIL " + u.remote + "] " + e.message + "\n"; failed.push(u.remote); }
        else out += "[OK] " + u.remote + " (" + src.length + "B)\n";
        next();
      });
    };
    next();
  });
  setTimeout(sftp, 500);
});
function finish() {
  out += "UPLOAD-FAILED=" + failed.length + "\n";
  out += "RESTARTING-PM2\n";
  c.exec("pm2 restart gritgigs 2>&1 | tail -3", (err, stream) => {
    let buf = "";
    if (err) { out += "[RESTART-EXEC-ERR] " + err.message + "\n"; return close(); }
    stream.on("data", d => buf += d.toString());
    stream.stderr.on("data", d => buf += d.toString());
    stream.on("close", () => { out += buf.trim() + "\nRESTART-DONE\n"; close(); });
  });
}
function close() {
  setTimeout(() => {
    c.exec("sleep 91; curl -s -o /dev/null -w 'FEED:%{http_code}' http://127.0.0.1:3000/feed 2>/dev/null; echo; curl -s -o /dev/null -w 'WALLET:%{http_code}' http://127.0.0.1:3000/wallet 2>/dev/null; echo; curl -s -o /dev/null -w 'BUYMORE:%{http_code}' http://127.0.0.1:3000/buy-more 2>/dev/null; echo; curl -s -o /dev/null -w 'SETTINGS:%{http_code}' http://127.0.0.1:3000/settings 2>/dev/null; echo", (err, stream) => {
      let buf = "";
      if (err) { out += "[VERIFY-EXEC-ERR]\n"; c.end(); return; }
      stream.on("data", d => buf += d.toString());
      stream.stderr.on("data", d => buf += d.toString());
      stream.on("close", () => { out += buf.trim() + "\nVERIFY-DONE\n"; c.end(); });
    });
  }, (failed.length === 0 ? 95000 : 180000));
}
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message) + "\n"; try { c.end(); } catch(_){} });
c.on("close", () => { console.log(out); process.exit(0); });
c.connect(H);
