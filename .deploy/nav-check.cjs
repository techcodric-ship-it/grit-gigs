const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 60000 };
let out = "";
const cmds = [
  ["echo ===SERVED-NAV-LINKS===; curl -s http://127.0.0.1:3000/feed | grep -oE 'href=\"[^\"]+\"' | sort -u | grep -vE '^\\.|#|assets|http' | head -20; echo ===ALL-SERVED-PAGES-STATUS===; for p in feed orders wallet buy-more settings explore profile notifications messages; do printf '%s=%%s ' $p $(curl -s -o /dev/null -w '%%{http_code}' http://127.0.0.1:3000/$p); done; echo; echo ===FEED.html-TOP-TITLE===; curl -s http://127.0.0.1:3000/feed | grep -oE '<title>[^<]*</title>'; echo ===WALLET-ONBOX-HEADING===; grep -oE '<h1[^>]*>[^<]*</h1>' /opt/gritgigs/public/wallet.html | head -2; echo ===BUYMORE-ONBOX-HEADING===; grep -oE '<h1[^>]*>[^<]*</h1>' /opt/gritgigs/public/buy-more.html | head -2; echo ===SETTINGS-ONBOX-HEADING===; grep -oE '<h1[^>]*>[^<]*</h1>' /opt/gritgigs/public/settings.html | head -2; echo ===ORDERS-ONBOX-HEADING===; grep -oE '<h1[^>]*>[^<]*</h1>' /opt/gritgigs/public/orders.html | head -2", "NAV"],
  ["echo ===GIT-LOG-LOCAL-FILES-ONBOX===; cd /opt/gritgigs && ls -la public/wallet.html public/buy-more.html public/settings.html public/orders.html 2>&1; echo ===ASSETS-PURPLE-SERVED-STILL===; curl -s http://127.0.0.1:3000/assets/feed.css | grep -oE -- '--signal: ?#[0-9a-f]+' | head -1", "FILES"]
];
let i = 0;
const run = () => {
  if (i >= cmds.length) { c.end(); return; }
  const [cmd, tag] = cmds[i++];
  c.exec(cmd, (err, stream) => {
    if (err) { out += "\n[EXEC-ERR] " + err.message; return run(); }
    let buf = "";
    stream.on("data", d => buf += d.toString());
    stream.stderr.on("data", d => buf += d.toString());
    stream.on("close", () => { out += "\n===== " + tag + " =====\n" + buf.trim(); run(); });
  });
};
c.on("error", e => { out += "\n[CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
