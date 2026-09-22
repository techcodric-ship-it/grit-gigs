const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
const CACHE = "app.use(function (req, res, next) { res.set({ 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' }); next(); });";
c.on("ready", () => {
  c.exec("pm2 jlist | grep -iE '\"name\"|pm_exec_path|script_desc|exec_interpreter|cwd' | head -20; echo ===PRINT-LINES===; ls -la /opt/gritgigs/*.js 2>/dev/null | head; echo ===GREP-STATIC===; for f in /opt/gritgigs/*.js; do echo ---$f; grep -nE 'express\.static|createServer|app\.(get|use|listen)|listen\(' "$f" 2>/dev/null | head -8; done; echo DONE", (e, stream) => {
    if (e) return c.end();
    let b = "";
    stream.on("data", d => b += d.toString());
    stream.stderr.on("data", d => b += d.toString());
    stream.on("close", () => { out = b.trim(); c.end(); });
  });
});
c.on("error", e => { out = "[CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
