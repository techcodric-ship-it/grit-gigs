const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 60000 };
let out = "";
c.on("ready", () => {
  const cmd = "echo ===LIVE-NAV-HREFS===; curl -s --max-time 20 https://gritandgigs.in/feed | grep -oE 'href=\"[^\"]+\"' | grep -vE 'assets|css|js\\?|#|http' | sort -u | head -24; echo ===LIVE-PROFILE-DROPDOWN===; curl -s --max-time 20 https://gritandgigs.in/feed | grep -oE 'nav[^>]*dropdown|profile[^>]*menu|<a[^>]*(wallet|buy-more|settings|orders)[^>]*>' | head -10";
  c.exec(cmd, (err, stream) => {
    if (err) { out += "[EXEC-ERR] " + err.message; return c.end(); }
    let b = "";
    stream.on("data", d => b += d.toString());
    stream.stderr.on("data", d => b += d.toString());
    stream.on("close", () => { out += b; c.end(); });
  });
});
c.on("error", e => out += "[CONN-ERR] " + (e.code || e.message) + "\n");
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
