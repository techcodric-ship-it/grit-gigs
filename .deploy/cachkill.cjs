const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
c.on("ready", () => {
  c.sftp((err, sftp) => {
    if (err) { out += "[SFTP-ERR] " + err.message; return c.end(); }
    sftp.readFile("/etc/caddy/Caddyfile", (e, buf) => {
      if (e) { out += "[READ-ERR] " + e.message; return c.end(); }
      let s = buf.toString("utf8");
      out += "===CADDY-BEFORE===\n" + s.trim() + "\n";
      const anchor = "reverse_proxy 127.0.0.1:3000";
      if (s.indexOf(anchor) < 0) { out += "[ANCHOR-MISSING]"; return c.end(); }
      const noCache =
        "header Cache-Control \"no-store, no-cache, must-revalidate\"\n" +
        "header Pragma \"no-cache\"\n" +
        "header Expires \"0\"\n" +
        anchor;
      s = s.replace(anchor, noCache);
      sftp.writeFile("/etc/caddy/Caddyfile", Buffer.from(s, "utf8"), (we) => {
        if (we) { out += "[WRITE-ERR] " + we.message; return c.end(); }
        out += "===CADDY-AFTER===\n" + s.trim() + "\n";
        c.exec("caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -3; echo V-EXIT=$?; caddy reload --config /etc/caddy/Caddyfile 2>&1 | tail -3; echo R-EXIT=$?; sleep 2; echo ===PUBLIC-HEADERS===; for p in feed wallet settings orders buy-more; do printf '%s: ' $p; curl -s -I --max-time 20 https://gritandgigs.in/$p | grep -iE '^(HTTP|cache-control|pragma|expires)' | tr '\n' ' '; echo; done; echo ===NAV-REMOTE-CHECK-LIVE-FEED===; curl -s --max-time 20 https://gritandgigs.in/feed | grep -oE 'title=\"(Wallet|Orders|Settings|Feed|Home|Search|Messages|Profile)\">' | sort | uniq -c; echo DONE", (e2, stream) => {
          if (e2) { out += "[EXEC-ERR] " + e2.message; return c.end(); }
          let b = "";
          stream.on("data", d => b += d.toString());
          stream.stderr.on("data", d => b += d.toString());
          stream.on("close", () => { out += "\n" + b.trim(); c.end(); });
        });
      });
    });
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
