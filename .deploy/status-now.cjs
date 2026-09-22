const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 45000 };
let out = "";
c.on("ready", () => {
  const cmd = "echo ===PM2===; pm2 status gritgigs 2>/dev/null | tail -2; echo ===PORT3000===; ss -ltn 2>/dev/null | grep ':3000 ' || echo NO-3000; echo ===CURL-LOCAL===; for p in feed orders wallet buy-more settings; do curl -s -o /dev/null -w \"$p=%{http_code} \" http://127.0.0.1:3000/$p; done; echo; echo ===CURL-DOMAIN===; curl -s -o /dev/null -w 'home=%{http_code} ' https://gritandgigs.in/; curl -s -o /dev/null -w 'feed=%{http_code} ' https://gritandgigs.in/feed; echo; echo ===ERRLOG-TAIL===; tail -n 12 /root/.pm2/logs/gritgigs-error.log 2>/dev/null; echo ===ERRLOG-COUNT===; wc -l < /root/.pm2/logs/gritgigs-error.log 2>/dev/null";
  c.exec(cmd, (err, s) => {
    if (err) { out += "[ERR] " + err.message + "\n"; return c.end(); }
    let b = "";
    s.on("data", d => b += d.toString());
    s.stderr.on("data", d => b += d.toString());
    s.on("close", () => { out += b; c.end(); });
  });
});
c.on("error", e => { out += "[CONN] " + (e.code || e.message) + "\n"; });
c.on("close", () => { console.log(out.trim()); });
c.connect(H);
