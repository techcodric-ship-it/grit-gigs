const { Client } = require("ssh2");
const fs = require("fs");
const path = require("path");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 120000, keepaliveInterval: 30000 };
let out = "";
const localRoot = path.join(__dirname, "..", "..");
const readLocal = rel => { const p = path.join(localRoot, rel); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; };
c.on("ready", () => {
  c.sftp((err, sftp) => {
    if (err) { out += "[SFTP-ERR] " + err.message; return c.end(); }
    const pairs = [
      ["public/assets/feed.css", "public/assets/feed.css"],
      ["public/assets/feed-app.js", "public/assets/feed-app.js"],
      ["public/feed.html", "public/feed.html"]
    ];
    let i = 0;
    const next = () => {
      if (i >= pairs.length) return postProcess(sftp);
      const [src, dst] = pairs[i++];
      const buf = readLocal(src);
      if (buf === null) { out += "[SKIP-MISSING] " + src + "\n"; return next(); }
      sftp.writeFile("/opt/gritgigs/" + dst, buf, e => {
        if (e) out += "[UPLOAD-FAIL " + dst + "] " + e.message + "\n";
        else out += "[OK] " + dst + " (" + buf.length + "B)\n";
        next();
      });
    };
    next();
    function postProcess() {
      c.exec("cd /opt/gritgigs/public && echo ===ASSETS-PRESENT===; ls -la assets/feed.css assets/feed-app.js 2>/dev/null; echo ===BOXA-PURPLE===; grep -oE -- '--signal:[^;]*' assets/feed.css | head -1; echo ===BUMP-VERSIONS===; sed -i -E \"s#(assets/feed\\.css\\?v=)[0-9]+#\\12#;s#(assets/feed-app\\.js\\?v=)[0-9]+#\\13#\" feed.html && grep -oE 'assets/(feed\\.css|feed-app\\.js)\\?v=[0-9]+' feed.html; pm2 restart gritgigs >/dev/null 2>&1 && echo PM2-RESTARTED; sleep 6; echo ===SERVED-ASSET===; curl -s http://127.0.0.1:3000/assets/feed.css | grep -oE -- '--signal:\\s*#[0-9a-f]+' | head -1; echo ===SERVED-LIKE-TEXT===; curl -s http://127.0.0.1:3000/feed | grep -oE 'class=\"[^\"]*like[^\"]*\"|♥' | head -3; echo ===SERVED-REF-VER===; curl -s http://127.0.0.1:3000/feed | grep -oE 'assets/(feed\\.css|feed-app\\.js)\\?v=[0-9]+' | head -2", (err, stream) => {
        let buf = "";
        if (err) { out += "[POST-EXEC-ERR] " + err.message; return c.end(); }
        stream.on("data", d => buf += d.toString());
        stream.stderr.on("data", d => buf += d.toString());
        stream.on("close", () => { out += buf; c.end(); });
      });
    }
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message) + "\n"; try { c.end(); } catch(_){} });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
