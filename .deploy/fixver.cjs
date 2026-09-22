const { Client } = require("ssh2");
const c = new Client();
let out = "";
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 70000, keepaliveInterval: 30000 };
c.on("ready", () => {
  const cmd = "cd /opt/gritgigs/public && echo ===SET-HIGH-VERSIONS===; for f in feed orders wallet buy-more settings; do [ -f $f.html ] || continue; perl -0pi -e 's#assets/feed\\.css(?:\\?v=[0-9]+)?#assets/feed.css?v=29#g; s#assets/feed-app\\.js(?:\\?v=[0-9]+)?#assets/feed-app.js?v=28#g; s#assets/(feed\\.css\\?v=29)\\?v=[0-9]+#$1#g' $f.html; done; echo ===REF-ALL-PAGES-AFTER===; for f in feed orders wallet buy-more settings; do printf '%s: ' $f; grep -oE 'assets/(feed\\.css|feed-app\\.js)\\?v=[0-9]+' $f.html | sort -u | tr '\n' ' '; echo; done; echo ===PM2-RESTART===; pm2 restart gritgigs >/dev/null 2>&1 && echo RESTARTED; sleep 5; echo ===PUBLIC-DOMAIN-VERIFY===; for p in feed orders wallet buy-more settings; do printf '%s: ' $p; curl -s -L --max-time 25 https://gritandgigs.in/$p | grep -oE 'assets/(feed\\.css|feed-app\\.js)\\?v=[0-9]+' | sort -u | tr '\n' ' '; echo; done; echo ===PUBLIC-DOMAIN-PURPLE-CHECK===; for ref in 'https://gritandgigs.in/assets/feed.css?v=29' 'https://gritandgigs.in/assets/feed-app.js?v=28'; do printf '%s -> ' $ref; curl -s -L --max-time 25 $ref | grep -oE -- '--signal: ?#[0-9a-f]+' | head -1; done; echo ===DONE===";
  c.exec(cmd, (err, stream) => {
    if (err) { out += "[EXEC-ERR] " + err.message; return c.end(); }
    let b = "";
    stream.on("data", d => b += d.toString());
    stream.stderr.on("data", d => b += d.toString());
    stream.on("close", () => { out += b.trim(); c.end(); });
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
