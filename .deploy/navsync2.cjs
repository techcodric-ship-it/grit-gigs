const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
const pages = ["feed.html", "wallet.html", "settings.html", "orders.html", "notifications.html", "buy-more.html"];
const apiPaths = ["/opt/gritgigs/server.js", "/opt/gritgigs/index.js", "/opt/gritgigs/app.js", "/opt/gritgigs/main.js"];

function extractNav(html) {
  const i = html.indexOf('<div class="icons">');
  if (i < 0) return "";
  const j = html.indexOf("</div>", i);
  if (j < 0) return "";
  return html.slice(i, j + "</div>".length);
}

function replaceNav(html, nav) {
  const i = html.indexOf('<div class="icons">');
  if (i < 0) return html;
  const j = html.indexOf("</div>", i);
  if (j < 0) return html;
  return html.slice(0, i) + nav + html.slice(j + "</div>".length);
}

c.on("ready", () => {
  c.sftp((err, sftp) => {
    if (err) { out += "[SFTP-ERR] " + err.message; return c.end(); }
    // 1) get clean nav from live feed
    sftp.readFile("/opt/gritgigs/public/feed.html", (e1, buf1) => {
      if (e1) { out += "[READ-FEED-ERR] " + e1.message; return c.end(); }
      const feed = buf1.toString("utf8");
      const nav = extractNav(feed);
      if (!nav) { out += "[NAV-EXTRACT-FAIL]"; return c.end(); }
      out += "[NAV-BYTES] " + Buffer.byteLength(nav, "utf8") + "\n";
      // 2) patch the other pages with the same nav
      let i = 0;
      const done = () => {
        if (++i < pages.length) return next();
        probeApi();
      };
      const next = () => {
        const p = pages[i];
        if (p === "feed.html") return done();
        sftp.readFile("/opt/gritgigs/public/" + p, (e, buf) => {
          if (e) { out += "[READ-" + p + "-ERR] " + e.message + "\n"; return done(); }
          let html = buf.toString("utf8");
          const before = html.slice(0, 100);
          html = replaceNav(html, nav);
          if (html.indexOf(nav) < 0) { out += p + ":SAME? no-change\n"; return done(); }
          sftp.writeFile("/opt/gritgigs/public/" + p, Buffer.from(html, "utf8"), (we) => {
            if (we) { out += "[WRITE-" + p + "-ERR] " + we.message; } else { out += p + ":NAV-REPLACED\n"; }
            done();
          });
        });
      };
      next();

      // 3) find the /api/feed handler + auth guard to fix the 401
      function probeApi() {
        let k = 0;
        const p2 = () => {
          if (++k < apiPaths.length) return nextApi();
          out += "[API-ROUTE-NOT-FOUND-IN-TRIED-LIST]\n";
          return c.end();
        };
        const nextApi = () => {
          const f = apiPaths[k];
          sftp.readFile(f, (e, buf) => {
            if (e) return p2();
            const src = buf.toString("utf8");
            const lines = src.split("\n");
            out += "===API-FILE===" + f + "===\n";
            lines.forEach((ln, idx) => {
              if (/\/api\/(feed|inbox|notifications|wallet|orders|settings|users|search)|users\/me|authorization|requireAuth|401|403/.test(ln)) {
                out += (idx + 1) + ": " + ln.trim().slice(0, 160) + "\n";
              }
            });
            out += "[API-ENDS]\n";
            c.end();
          });
        };
        nextApi();
      }
    });
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
