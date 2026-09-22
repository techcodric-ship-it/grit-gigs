const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 60000 };
let out = "";
c.on("ready", () => {
  const cmd = "cd /opt/gritgigs && sed -i -E 's#(assets/feed\\.css\\?v=)[0-9]+#\\19#; s#(assets/feed-app\\.js\\?v=)[0-9]+#\\18#' public/feed.html && echo ===BUMPED-REFS=== && grep -oE 'assets/(feed\\.css|feed-app\\.js)\\?v=[0-9]+' public/feed.html | sort -u && pm2 restart gritgigs >/dev/null 2>&1 && sleep 5 && echo ===PM2-OK=== && echo ===SERVED-HTML-REF=== && curl -s http://127.0.0.1:3000/feed | grep -oE 'assets/(feed\\.css|feed-app\\.js)\\?v=[0-9]+' | sort -u && echo ===SERVED-ASSETS-SIGNAL=== && curl -s http://127.0.0.1:3000/assets/feed.css?_=9 | grep -oE -- '--signal:[[:space:]]*#[0-9a-f]+' | head -1 && echo ===SERVED-STATUS=== && for p in feed orders wallet buy-more settings; do printf '%s=%s ' $p $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/$p); done; echo; echo ===DONE===";
  c.exec(cmd, (err, stream) => {
    if (err) { out += "[EXEC-ERR] " + err.message; return c.end(); }
    let buf = "";
    stream.on("data", d => buf += d.toString());
    stream.stderr.on("data", d => buf += d.toString());
    stream.on("close", () => { out += buf; c.end(); });
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
