const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 60000 };
let out = "";
c.on("ready", () => {
  const cmd = "echo ===PM2-NOW===; pm2 status gritgigs 2>/dev/null | tail -3; echo ===PORT3000===; ss -ltn | grep -E ':3000 ' || echo NO-PORT-3000; echo ===PM2-ERRLOG-TAIL===; tail -n 40 /root/.pm2/logs/gritgigs-error.log 2>/dev/null; echo ===PM2-OUTLOG-TAIL===; tail -n 20 /root/.pm2/logs/gritgigs-out.log 2>/dev/null; echo ===MANUAL-START-PROBE===; cd /opt/gritgigs && timeout 6 npx tsx src/index.ts 2>&1 | head -25; echo ===TRY-MANUAL-EXIT=$?.===; echo ===CANARY-WITHOUT-PM2===; pm2 kill >/dev/null 2>&1; sleep 1; (cd /opt/gritgigs && nohup npx tsx src/index.ts > /root/gritgigs-manual.log 2>&1 &); sleep 9; echo ===MANUAL-PORT===; ss -ltn | grep -E ':3000 ' && echo MANUAL-UP || (echo MANUAL-DOWN; tail -n 30 /root/gritgigs-manual.log 2>/dev/null); echo ===MANUAL-CURL===; curl -s -o /dev/null -w 'feed:%{http_code}\n' http://127.0.0.1:3000/feed 2>/dev/null; echo ===DONE===";
  c.exec(cmd, (err, stream) => {
    if (err) { out += "[EXEC-ERR] " + err.message; return c.end(); }
    let buf = "";
    stream.on("data", d => buf += d.toString());
    stream.stderr.on("data", d => buf += d.toString());
    stream.on("close", () => { out += buf; c.end(); });
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
