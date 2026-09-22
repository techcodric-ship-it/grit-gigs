const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
c.on("ready", () => {
  const cmd = "echo ===PUBLIC-URLS===; for p in '' feed orders wallet buy-more settings; do code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -L \"https://gritandgigs.in/$p\" 2>/dev/null); size=$(curl -s -L --max-time 20 \"https://gritandgigs.in/$p\" 2>/dev/null | wc -c); printf 'gritandgigs.in/%s  -> %s (%sB)\n' \"$p\" \"$code\" \"$size\"; done; echo ===TITLE-CHECK===; curl -s -L --max-time 20 https://gritandgigs.in/wallet 2>/dev/null | grep -oE '<title>[^<]*</title>' ; curl -s -L --max-time 20 https://gritandgigs.in/buy-more 2>/dev/null | grep -oE '<title>[^<]*</title>'; curl -s -L --max-time 20 https://gritandgigs.in/settings 2>/dev/null | grep -oE '<title>[^<]*</title>'; echo ===DONE===";
  c.exec(cmd, (err, stream) => {
    if (err) { out += "[EXEC-ERR] " + err.message; return c.end(); }
    let b = "";
    stream.on("data", d => b += d.toString());
    stream.stderr.on("data", d => b += d.toString());
    stream.on("close", () => { out += b; c.end(); });
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); try { c.end(); } catch(_){} });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
