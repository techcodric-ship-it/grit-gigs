const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
c.on("ready", () => {
  c.exec("echo ===ROUTES-FILES==="; ls /opt/gritgigs/routes/ 2>/dev/null; echo ===API-FEED-DEF==="; grep -rn --include='*.js' -E 'api/feed|/feed|feedList|getFeed' /opt/gritgigs/routes/*.js /opt/gritgigs/*.js 2>/dev/null | head -8; echo ===AUTH-GUARDS==="; grep -rn --include='*.js' -E 'requireAuth|authRequired|isAuthed|verifyToken|401|Authorization|bearer' /opt/gritgigs/routes/feed*.js /opt/gritgigs/middleware/*.js 2>/dev/null | head -10; echo ===FEED-ROUTE-FILE-IF-EXISTS==="; find /opt/gritgigs -iname '*feed*' -name '*.js' 2>/dev/null | head; echo DONE", (e, s) => {
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
