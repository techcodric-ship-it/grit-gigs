const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
c.on("ready", () => {
  c.exec("F=$(find /opt/gritgigs -maxdepth 2 -name 'server.js' -o -name 'app.js' -o -name 'index.js' 2>/dev/null | head -1); echo SERVER=$F; grep -nE 'api/feed|/feed|feedList|users/me/posts|apiFeed|/api/posts' $F 2>/dev/null | head -12; echo ===AUTHGUARD===; grep -nE 'authGuard|requireAuth|verifyToken|checkAuth|Authorization|401|bearer' $F 2>/dev/null | head -12; echo DONE", (e, s) => {
    if (e) { out += "[EXEC-ERR] " + e.message; return c.end(); }
    let b = "";
    s.on("data", d => b += d.toString());
    s.stderr.on("data", d => b += d.toString());
    s.on("close", () => { out += b.trim(); c.end(); });
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
