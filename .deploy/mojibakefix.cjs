const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
const RE = [
  [/title="(Wallet|Orders|Settings|Feed)">">/g, 'title="$1">'],
  [/\)">">/g, ')">'],
  [/\]">">/g, ']">'],
  [/\);">">/g, ');">'],
  [/">"><svg/g, '"><svg'],
  [/\u00E2\u201A\u00B9/g, "\u20B9"],
  [/\u00E2\u2018/g, ""],
  [/\u00E2\u20AC\u201C/g, "\u201C"],
  [/\u00E2\u20AC\u201D/g, "\u201D"],
  [/\u00E2\u20AC\u201A/g, "\u2018"],
  [/\u00E2\u20AC\u2122/g, "\u2019"],
  [/\u00E2\u20AC\u2013/g, "\u2013"],
  [/\u00E2\u20AC\u2019/g, "\u2014"],
  [/\u00E2\u153\u201C/g, "\u201C"],
  [/\u00E2\u153\u201D/g, "\u201D"],
  [/\u00E2\u153\u00B9/g, "\u20B9"],
];
const files = [
  "/opt/gritgigs/public/feed.html",
  "/opt/gritgigs/public/settings.html",
  "/opt/gritgigs/public/wallet.html",
  "/opt/gritgigs/public/orders.html",
  "/opt/gritgigs/public/buy-more.html",
];
let pending = files.length;
function done() { if (--pending === 0) verify(); }
function verify() {
  out += "\n===SERVED-NAV-TITLES===\n";
  c.exec("for p in feed settings wallet orders buy-more; do printf '%s: ' $p; curl -s --max-time 20 https://gritandgigs.in/$p | grep -oE 'title=\"[A-Za-z]+\"><svg' | sort -u | tr '\\n' ' '; echo; done; echo DONE", (e, st) => {
    if (e) { out += "[EXEC-ERR] " + e.message; return c.end(); }
    let b = "";
    st.on("data", d => b += d.toString());
    st.stderr.on("data", d => b += d.toString());
    st.on("close", () => { out += b.trim(); c.end(); });
  });
}
c.on("ready", () => {
  c.sftp((err, sftp) => {
    if (err) { out += "[SFTP-ERR] " + err.message; return c.end(); }
    let i = 0;
    (function next() {
      if (i >= files.length) return done();
      const f = files[i++];
      sftp.readFile(f, (e, buf) => {
        if (e) { out += "[READ-ERR " + f + "] " + e.message + "\n"; return done(); }
        let s = buf.toString("utf8");
        const t = s;
        RE.forEach(([re, rp]) => { s = s.replace(re, rp); });
        if (s === t) { out += "[NO-CHANGE] " + f + "\n"; return done(); }
        sftp.writeFile(f, Buffer.from(s, "utf8"), (we) => {
          if (we) { out += "[WRITE-ERR " + f + "] " + we.message; } else { out += "[PATCHED] " + f + " (-" + (t.length - s.length) + " bytes)\n"; }
          return done();
        });
      });
    })();
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
