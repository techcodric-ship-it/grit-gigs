const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
c.on("ready", () => {
  c.exec("echo ===FIND-FEED-API==="; grep -rn --include='*.js' -E 'api/feed|/feed|feedList|users/me/posts|/api/posts|requireAuth|authGuard|verifyToken|401' /opt/gritgigs/*.js /opt/gritgigs/server/*.js /opt/gritgigs/routes/*.js 2>/dev/null | head -30; echo ===SERVER-FILES===; ls -la /opt/gritgigs/*.js /opt/gritgigs/server/*.js /opt/gritgigs/routes/*.js 2>/dev/null; echo ===PM2-APP===; pm2 jlist 2>/dev/null | grep -oE '\"name\":\"[^\"]+\"|\"pm_exec_path\":\"[^\"]+\"' | head -6; echo DONE", (e, s) => {
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
