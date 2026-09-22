const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
const NAV_FEED =
  '<div class="icons">' +
  '<a href="/wallet.html" title="Wallet"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="15" rx="2.5"/><path d="M3 10h18"/><circle cx="16" cy="15" r="1.6"/></svg></a>' +
  '<a href="/orders.html" title="Orders"><svg viewBox="0 0 24 24"><path d="M4 6h16l-1.5 13.5a2 2 0 0 1-2 1.8H7.5a2 2 0 0 1-2-1.8Z"/><path d="M4 6h16"/><path d="M9 10v4a3 3 0 0 0 6 0v-4"/></svg></a>' +
  '<a href="/settings.html" title="Settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></svg></a>' +
  '<a href="/feed" class="on" title="Feed"><svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.7V21h14V9.7"/></svg></a>' +
  "</div>";
c.on("ready", () => {
  c.sftp((err, sftp) => {
    if (err) { out += "[SFTP-ERR] " + err.message; return c.end(); }
    sftp.readFile("/opt/gritgigs/public/feed.html", (e, buf) => {
      if (e) { out += "[READ-ERR] " + e.message; return c.end(); }
      let s = buf.toString("utf8");
      const old = s.slice(0, s.indexOf("</header>") >= 0 ? s.indexOf("</header>") : 0);
      const headStart = s.indexOf("<header");
      if (headStart < 0) { out += "[NO-HEADER]"; return c.end(); }
      // capture the brand line inside header
      const headerTagEnd = s.indexOf(">", headStart);
      const brandMatch = s.slice(headerTagEnd + 1, s.indexOf("</header>")).match(/<a[^>]*class="brand"[^>]*>[\s\S]*?<\/a>/);
      // Replace whole header body content with brand + new nav
      const replacement = (brandMatch ? brandMatch[0] : '<a class="brand" href="/feed">Grit<b>&amp;Gigs</b></a>') + "\n" + NAV_FEED + "\n";
      const headerOpen = s.slice(headStart, headerTagEnd + 1);
      const newS = s.slice(0, headStart) + headerOpen + "\n" + replacement + "</header>" + s.slice(s.indexOf("</header>") + "</header>".length);
      sftp.writeFile("/opt/gritgigs/public/feed.html", Buffer.from(newS, "utf8"), (we) => {
        if (we) { out += "[WRITE-ERR] " + we.message; return c.end(); }
        out += "[PATCHED]\n";
        c.exec("echo ===FEED-NAV-NOW===; curl -s --max-time 20 http://127.0.0.1:3000/feed | grep -oE 'title=\"(Wallet|Orders|Settings|Feed)\"><svg' | sed -E 's/title=\"([^\"]+)\"/\\1/' ; echo ===MUST-NOT-CONTAIN===; curl -s --max-time 20 http://127.0.0.1:3000/feed | grep -cE 'title=\"(Home|Search|Message|Profile|Explore)\"'; echo 0=clean 1=old-remains; echo ===PUBLIC-FEED-NAV===; curl -s --max-time 25 https://gritandgigs.in/feed | grep -oE 'title=\"(Wallet|Orders|Settings|Feed|Home|Search|Message|Profile|Explore)\"' | sort -u; echo DONE", (e2, stream) => {
          if (e2) { out += "[EXEC-ERR] " + e2.message; return c.end(); }
          let b = "";
          stream.on("data", d => b += d.toString());
          stream.stderr.on("data", d => b += d.toString());
          stream.on("close", () => { out += b.trim(); c.end(); });
        });
      });
    });
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
