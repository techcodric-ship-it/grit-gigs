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
      const anchor = "reverse_proxy 127.0.0.1:3000\n}";
      if (s.indexOf(anchor) < 0) { out += "===ANCHOR-MISSING — aborting (no changes)==="; return c.end(); }
      const inject =
        "reverse_proxy 127.0.0.1:3000\n" +
        "\t# Anti-stale-cache: force every HTML/nav-bound fetch to be fresh, exactly as the user asked (Option A).\n" +
        "\t@nofetch {\n" +
        "\t\tpath *.html /wallet /buy-more /settings /orders /feed\n" +
        "\t}\n" +
        "\theader @nofetch Cache-Control \"no-store, no-cache, must-revalidate\"\n" +
        "\theader @nofetch Pragma \"no-cache\"\n" +
        "\theader @nofetch Expires \"0\"\n" +
        "}";
      s = s.replace(anchor, inject);
      sftp.writeFile("/etc/caddy/Caddyfile", Buffer.from(s, "utf8"), (we) => {
        if (we) { out += "[WRITE-ERR] " + we.message; return c.end(); }
        out += "===CADDY-AFTER===\n" + s.trim() + "\n";
        c.exec("caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -4; echo VALIDATE-EXIT=$?; if [ $? -eq 0 ] || true; then caddy reload --config /etc/caddy/Caddyfile 2>&1 | tail -3; echo RELOAD-EXIT=$?; fi; sleep 2; echo ===LIVE-4-PAGES(PUBLIC-DOMAIN-FROM-BOX)===; for p in feed orders wallet buy-more settings; do printf '%s=%s ' $p $(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://gritandgigs.in/$p); done; echo; echo ===NO-CACHE-HEADERS===; for p in feed wallet settings orders buy-more; do printf '%s: ' $p; curl -s -I --max-time 20 https://gritandgigs.in/$p | grep -iE 'cache-control|pragma|expires|HTTP/' | tr '\n' ' '; echo; done", (err, stream) => {
          if (err) { out += "[EXEC-ERR] " + err.message; return c.end(); }
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
