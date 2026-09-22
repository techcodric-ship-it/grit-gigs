const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
c.on("ready", () => {
  const cmd = 'echo ===DOMAIN-PAGE-CONTENT===; for p in wallet buy-more settings orders; do echo ---$p---; curl -s -L --max-time 20 https://gritandgigs.in/$p | grep -oE "<title>[^<]*</title>" | head -1; curl -s -L --max-time 20 https://gritandgigs.in/$p | grep -oE "Razorpay|razorpay|QUOTA|quota|wallet|credits|R\\u20b9|[0-9][0-9]%25|end-user|add money|Tier" | sort | uniq -c | sort -rn | head -6; done; echo ===FEED-SERVED-PURPLE-FINAL===; curl -s -L --max-time 20 https://gritandgigs.in/assets/feed.css | grep -oE -- "--signal: ?#[0-9a-f]+" | head -1; echo ===ALL-DONE===";
  c.exec(cmd, (err, stream) => {
    if (err) { out += "[EXEC-ERR] " + err.message; return c.end(); }
    let b = "";
    stream.on("data", d => b += d.toString());
    stream.stderr.on("data", d => b += d.toString());
    stream.on("close", () => { out += b.trim(); c.end(); });
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
