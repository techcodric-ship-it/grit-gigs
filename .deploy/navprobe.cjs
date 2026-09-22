const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 60000 };
let out = "";
const cmds = [
  ["echo ===BOX-TITLES===; for p in wallet buy-more settings orders; do f=/opt/gritgigs/public/$p.html; printf '%s: ' $p; grep -oE '<h1[^>]*>[^<]*</h1>' $f 2>/dev/null | head -1 | sed -E 's/<[^>]+>//g'; done; echo ===BOX-WALLET-HAS-PURPLE-REF===; grep -oE 'assets/feed\\.css\\?v=[0-9]+' /opt/gritgigs/public/wallet.html /opt/gritgigs/public/buy-more.html /opt/gritgigs/public/settings.html /opt/gritgigs/public/orders.html 2>/dev/null", "TITLES"],
  ["echo ===SERVED-NAV-LINKS(href sorted)==; curl -s --max-time 8 http://127.0.0.1:3000/feed | grep -oE 'href=\"[^\"]+\"' | sort -u", "NAV"]
];
let i = 0;
const run = () => {
  if (i >= cmds.length) return c.end();
  const [cmd, tag] = cmds[i++];
  c.exec(cmd, (err, stream) => {
    if (err) { out += "\n[EXEC-ERR " + tag + "] " + err.message; return run(); }
    let b = "";
    stream.on("data", d => b += d.toString());
    stream.stderr.on("data", d => b += d.toString());
    stream.on("close", () => { out += "\n===== " + tag + " =====\n" + b.trim(); run(); });
  });
};
c.on("error", e => { out += "\n[CONN-ERR] " + (e.code || e.message) + "\n"; try { c.end(); } catch(_){} });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
