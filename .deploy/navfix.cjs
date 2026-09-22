const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
const files = ["/opt/gritgigs/public/feed.html","/opt/gritgigs/public/wallet.html","/opt/gritgigs/public/settings.html","/opt/gritgigs/public/orders.html","/opt/gritgigs/public/buy-more.html"];
const RE = [
  [ /title="(Wallet|Settings|Orders|Feed)">">/g, 'title="$1">' ],        // stray `">` between attr and svg
  [ /<\/a><\/a>/g, "</a>" ],                                              // double-close anchors
  [ /â‚¹/g, "\u20B9" ],   [ /âœ“/g, "\u2713" ],   [ /â€“/g, "\u2013" ],
  [ /â€œ/g, "\u201C" ],   [ /â€/g, "\u201D" ],
  [ /\u00E2\u201A\u00B9/g, "\u20B9" ],
];
let pending = files.length * 2;
const done = () => { if (--pending === 0) verify(); };
function verify() {
  c.exec("echo ===NAV-NO-STRAY==='; for p in feed wallet settings orders buy-more; do printf '%s: stray=' $p; curl -s --max-time 20 http://127.0.0.1:3000/$p | grep -cE 'title=\"(Wallet|Settings|Orders|Feed)\">\"' || true; done; echo ===NAV-OK-SVG='; for p in feed wallet settings orders buy-more; do printf '%s: ' $p; curl -s --max-time 20 http://127.0.0.1:3000/$p | grep -oE 'title=\"(Wallet|Settings|Orders|Feed)\"><svg' | wc -l; done; echo ===PUBLIC='; for p in feed wallet settings; do printf '%s=%s ' $p $(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://gritandgigs.in/$p); done; echo; echo BOX-DONE", (e, st) => {
    if (e) { out += "[EXEC-ERR] " + e.message; return c.end(); }
    let b = "";
    st.on("data", d => b += d.toString());
    st.stderr.on("data", d => b += d.toString());
    st.on("close", () => { out += b.trim() + "\n"; c.end(); });
  });
}
c.on("ready", () => c.sftp((err, sftp) => {
  if (err) { out += "[SFTP-ERR] " + err.message; return c.end(); }
  files.forEach(f => sftp.readFile(f, (e, buf) => {
    if (e) { out += f + ":READ-ERR " + e.message + "\n"; return done(); }
    let s = buf.toString("utf8"), n = 0, t = s;
    RE.forEach(([re, rp]) => { s = s.replace(re, rp); });
    if (s === t) { out += f + ":NO-CHANGE\n"; return done(); }
    const numRep = (t.length - s.length); // bytes removed
    out += f + ":PATCHED (-" + numRep + " bytes)\n";
    sftp.writeFile(f, Buffer.from(s, "utf8"), (we) => {
      if (we) { out += f + ":WRITE-ERR " + we.message; } 
      done();
    });
  }));
}));
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
