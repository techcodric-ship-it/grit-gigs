const { Client } = require("ssh2");
const c = new Client();
let out = "";
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000 };
c.on("ready", () => {
  const cmd = 'echo ===SW-ROUTE-IN-CODE===; grep -nE "sw\\.js|serviceWorker|service-worker|/sw\\b|precache|workbox|caches\\.open|skipWaiting|version" /opt/gritgigs/src/app.ts /opt/gritgigs/src/index.ts 2>/dev/null | head -16; echo ===SERVED-REGISTRATION-ALL-PAGES===; for p in feed orders wallet settings buy-more; do printf "%s: " $p; curl -s http://127.0.0.1:3000/$p | grep -oE "navigator\\.serviceWorker\\.register\\('[^']+'\\)" | head -1; done; echo ===FETCH-SW-JS===; curl -s -i http://127.0.0.1:3000/sw.js 2>/dev/null | head -4; echo ===SW-JS-CONTENT===; curl -s http://127.0.0.1:3000/sw.js 2>/dev/null | head -c 1400; echo; echo ===CACHE-NAME-IN-SW===; curl -s http://127.0.0.1:3000/sw.js 2>/dev/null | grep -oE "[\x27\"][-A-Za-z0-9:_. /]+v?[0-9]*[\x27\"]|CACHE_VERSION|CACHE_NAME|cacheName" | sort -u | head -10';
  c.exec(cmd, (err, stream) => {
    if (err) { out += "[EXEC-ERR] " + err.message; return c.end(); }
    let buf = "";
    stream.on("data", d => buf += d.toString());
    stream.stderr.on("data", d => buf += d.toString());
    stream.on("close", () => { out += buf.trim(); c.end(); });
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
