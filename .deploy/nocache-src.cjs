// One-shot box op: find express app entry, inject a no-store middleware so the
// browser cache can never serve the stale (pre-purple, no-wallet) build again.
// Reads the file, patches the FIRST occurrence of the express.static() call or
// `app.use(` line by inserting a cache-buster middleware just above it.
const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
function die(m){ out += m; c.end(); }
const CACHE = "app.use(function (req, res, next) { res.set({ 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' }); next(); });";

c.on("ready", () => {
  c.sftp((err, sftp) => {
    if (err) return die("[SFTP-ERR] " + err.message);
    // discover entry files
    const cand = ["/opt/gritgigs/server.js", "/opt/gritgigs/index.js", "/opt/gritgigs/app.js", "/opt/gritgigs/main.js"];
    let fi = 0;
    (function readNext() {
      if (fi >= cand.length) { out += "[NO-ENTRY-FOUND] tried " + cand.join(" "); return c.end(); }
      const p = cand[fi++];
      sftp.readFile(p, (e, buf) => {
        if (e) return readNext();
        let src = buf.toString("utf8");
        if (src.indexOf(CACHE) >= 0) { out += "[ALREADY-PATCHED] " + p; return c.end(); }
        // anchors: express.static( ... ) line, or 'app.use(' line, or 'const app = express('
        const reStatic = /.*express\.static\([^)]*\).*/;
        const m = src.split("\n");
        let idx = -1;
        for (let i = 0; i < m.length; i++) {
          if (reStatic.test(m[i])) { idx = i; break; }
        }
        if (idx < 0) {
          // fallback: insert right after app init
          for (let i = 0; i < m.length; i++) {
            if (/express\(\s*\)/.test(m[i]) || /const app\s*=\s*express/.test(m[i])) { idx = i + 1; break; }
          }
        }
        if (idx < 0) { out += "[NO-ANCHOR-IN] " + p; return c.end(); }
        m.splice(idx, 0, CACHE);
        sftp.writeFile(p, Buffer.from(m.join("\n"), "utf8"), (we) => {
          if (we) { out += "[WRITE-ERR] " + p + ": " + we.message; return c.end(); }
          out += "[PATCHED] " + p + " @line+" + idx;
          c.exec("pm2 restart gritgigs >/dev/null 2>&1 && echo PM2-OK; sleep 2; echo ===CACHE-HEADERS===; for p in feed wallet settings orders buy-more; do printf '%s: ' $p; curl -sI --max-time 20 https://gritandgigs.in/$p | grep -iE '^HTTP|cache-control|pragma' | tr '\n' ' '; echo; done; echo DONE", (e2, stream) => {
            if (e2) return die("[EXEC-ERR] " + e2.message);
            let b = "";
            stream.on("data", d => b += d.toString());
            stream.stderr.on("data", d => b += d.toString());
            stream.on("close", () => { out += "\n" + b.trim(); c.end(); });
          });
        });
      });
    })();
  });
});
c.on("error", e => die("[CONN-ERR] " + (e.code || e.message)));
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
