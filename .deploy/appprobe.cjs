const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 30000 };
let out = "";
c.on("ready", () => {
  const cmds = [
    ["ls -la /opt/gritgigs 2>/dev/null | head -30; echo ===PKG===; grep -E '\"(start|dev|build|main)\":' /opt/gritgigs/package.json 2>/dev/null; echo ===SRC===; ls /opt/gritgigs/src 2>/dev/null | head; ls /opt/gritgigs/dist 2>/dev/null | head; echo ===PUB-LIST===; ls /opt/gritgigs/public 2>/dev/null | head -40; echo ===HTML-REAL===; for f in orders wallet buy-more settings bids credits; do echo \"$f.html: $([ -f /opt/gritgigs/public/$f.html ] && echo EXISTS || echo MISSING)\"; done", "APP"],
    ["cd /opt/gritgigs 2>/dev/null && { echo ===GITLOG===; git log --oneline -5 2>/dev/null; echo ===GITSTATUS===; git status --short 2>/dev/null | head -12; echo ===BRANCH===; git rev-parse --abbrev-ref HEAD 2>/dev/null; echo ===REMOTE===; git remote -v 2>/dev/null | head -2; echo ===HEAD-FULL===; git rev-parse HEAD 2>/dev/null; }", "GIT"],
    ["echo ===ENV-EXISTS===; ls -la /opt/gritgigs/.env* 2>/dev/null; echo ===PM2-EXEC-CWD===; pm2 describe 0 2>/dev/null | grep -iE 'exec cwd|script|interpreter|exec mode|status|restarts|pid' | head -10; echo ===STORAGE-CFG===; grep -oE 'SUPABASE_URL|SUPABASE_ANON_KEY|RAZORPAY_KEY_ID|DATABASE_URL|SESSION_SECRET' /opt/gritgigs/.env 2>/dev/null | sort -u; echo ===NODE-EXEC===; head -c 300 /opt/gritgigs/ecosystem.config.js 2>/dev/null; head -c 400 /opt/gritgigs/ecosystem.config.cjs 2>/dev/null", "ENV"]
  ];
  let i = 0;
  const run = () => {
    if (i >= cmds.length) { c.end(); return; }
    const [cmd, tag] = cmds[i++];
    c.exec(cmd, (err, stream) => {
      if (err) { out += "\n[" + tag + "-EXEC-ERR] " + err.message + "\n"; run(); return; }
      let buf = "";
      stream.on("data", d => buf += d.toString());
      stream.stderr.on("data", d => buf += d.toString());
      stream.on("close", () => { out += "\n===== " + tag + " =====\n" + buf.trim() + "\n"; run(); });
    });
  };
  run();
});
c.on("error", e => { out += "\n[CONN-ERROR] " + (e.message || e.code) + "\n"; c.end(); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
