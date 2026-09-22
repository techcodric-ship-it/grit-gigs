const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
c.on("ready", () => c.sftp((err, sftp) => {
  if (err) { out += "[SFTP-ERR] " + err.message; return c.end(); }
  const base = "/opt/gritgigs/public";
  sftp.readFile(base + "/feed.html", (e, buf) => {
    if (e) { out += "[FEED-READ-ERR] " + e.message; return c.end(); }
    const feed = buf.toString("utf8");
    const m = feed.match(/<div class="icons">[\s\S]*?<\/div>/);
    if (!m) { out += "[NO-ICONS-CONTAINER]"; return c.end(); }
    const NAV = m[0];
    out += "[NAV-BYTE-LEN] " + Buffer.byteLength(NAV, "utf8") + "\n";
    const targets = ["settings", "wallet", "orders", "notifications", "search", "inbox", "buy-more"].map(x => base + "/" + x + ".html");
    let pending = targets.length;
    const done = () => { if (--pending <= 0) verify(); };
    function writeFileAt(i) {
      if (i >= targets.length) return;
      const f = targets[i];
      sftp.readFile(f, (e2, b2) => {
        if (e2) { out += "[READ-" + f + "] " + e2.message + "\n"; return writeFileAt(i + 1); }
        let s = b2.toString("utf8");
        const old = s.match(/<div class="icons">[\s\S]*?<\/div>/);
        if (old && old[0] === NAV) { out += "[SAME] " + f + "\n"; return writeFileAt(i + 1); }
        if (old) s = s.replace(/<div class="icons">[\s\S]*?<\/div>/, NAV);
        else { out += "[NO-CONTAINER] " + f + "\n"; return writeFileAt(i + 1); }
        sftp.writeFile(f, Buffer.from(s, "utf8"), (we) => {
          if (we) { out += "[WRITE-ERR " + f + "] " + we.message + "\n"; }
          else out += "[NAV-SYNCED] " + f + "\n";
          writeFileAt(i + 1);
        });
      });
    }
    function verify() {
      writeFileAt(0); // runs writes then: 
      // after all writes, restart pm2 feed not needed (static). just curl.
      c.exec("sleep 1; echo ===PUBLIC-NAV-ALL-PAGES===; for p in settings wallet orders notifications search inbox buy-more feed; do printf '%s: ' $p; curl -s --max-time 20 https://gritandgigs.in/$p | grep -oE 'title=\"(Home|Search|Inbox|Notifications|Orders|Wallet|Profile)\"' | sort -u | tr '\n' ' '; echo; done; echo ===VERSIONS===; for p in feed settings wallet orders; do printf '%s: ' $p; curl -s --max-time 20 https://gritandgigs.in/$p | grep -oE '(feed|feed-app|wallet|settings|orders)[^\"]*\.(css|js)\?v=[0-9]+' | sort -u | tr '\n' ' '; echo; done; echo DONE", (e3, st) => {
        if (e3) { out += "[EXEC-ERR] " + e3.message; return c.end(); }
        let b = "";
        st.on("data", d => b += d.toString());
        st.stderr.on("data", d => b += d.toString());
        st.on("close", () => { out += b.trim(); c.end(); });
      });
    }
    verify();
  });
}));
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
