const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
function err(s){ out += s + "\n"; c.end(); }

function fixNav(s) {
  // Remove stray '">' artifacts left between link attrs and the svg icon:
  //   title="Wallet">"><svg  ->  title="Wallet"><svg
  //   /wallet.html" title="Wallet">">  ->  /wallet.html" title="Wallet">
  s = s.replace(/(title="(?:Wallet|Orders|Settings|Feed|Buy more|Add money)")\s*">(?="|<\/?)/g, "$1>");
  s = s.replace(/(title="(?:Wallet|Orders|Settings|Feed|Buy more|Add money)"><svg)/g, "s>$1".replace("s>","") );
  s = s.replace(/title="(Wallet|Orders|Settings|Feed|Buy more|Add money)">""><svg/g, 'title="$1"><svg');
  s = s.replace(/title="(Wallet|Orders|Settings|Feed|Buy more|Add money)">"<svg/g, 'title="$1"><svg');
  return s;
}

function fixMojibake(s) {
  const RUPEE = "\u20B9";
  const maps = [
    ["\u00E2\u201A\u00B9", RUPEE],   // â‚¹  (mojibake of ₹)
    ["\u00E2\u201E\u0093", "\u2713"], // â€“? (â€œ = “)
  ];
  s = s.split("â‚¹").join(RUPEE);
  s = s.split("â€œ").join("\u201C");
  s = s.split("â€\u201D").join("\u201D");
  s = s.split("â€“").join("\u2013");
  s = s.split("â€\u0093").join("\u201C");
  s = s.split("â€\").join("\u201C");
  s = s.split("¬").join("");
  s = s.replace(/â‚¹/g, RUPEE);
  return s;
}

c.on("ready", () => {
  c.sftp((err, sftp) => {
    if (err) return err("SFTP:" + err.message);
    const files = ["feed", "wallet", "settings", "orders", "buy-more"];
    let pending = files.length * 2; // read+write each
    const done = () => { if (--pending === 0) final(); };
    const changed = {};
    files.forEach((f) => {
      sftp.readFile("/opt/gritgigs/public/" + f + ".html", (e, buf) => {
        if (e) { out += f + ":READ-ERR " + e.message + "\n"; return done(); }
        let s = buf.toString("utf8");
        const before = s;
        s = fixNav(s);
        s = fixMojibake(s);
        changed[f] = buf.toString("utf8") !== s ? "yes" : "no";
        if (changed[f] === "yes") {
          sftp.writeFile("/opt/gritgigs/public/" + f + ".html", Buffer.from(s, "utf8"), (we) => {
            if (we) out += f + ":WRITE-ERR " + we.message + "\n"; else out += f + ":OK\n";
            done();
          });
        } else { done(); }
      });
    });
  });
});

function final() {
  out += "===CHANGES===\n" + JSON.stringify(changed) + "\n";
  c.exec("cd /opt/gritgigs && pm2 restart gritgigs >/dev/null 2>&1 && echo PM2-OK; sleep 1; echo ===PUBLIC-200===; for p in feed wallet settings orders buy-more; do printf '%s=%s ' $p $(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://gritandgigs.in/$p); done; echo; echo ===NAV-CHECK===; for p in feed wallet settings orders buy-more; do printf '%s:' $p; curl -s --max-time 20 https://gritandgigs.in/$p | grep -oE 'title=\"Wallet\">\"?\"?<svg' | tr '\n' ' '; echo; done; echo DONE", (e, stream) => {
    if (e) { out += "EXEC:" + e.message; return c.end(); }
    let b = "";
    stream.on("data", d => b += d.toString());
    stream.stderr.on("data", d => b += d.toString());
    stream.on("close", () => { out += b.trim(); c.end(); });
  });
}

c.on("error", e => out += "CONN:" + (e.code || e.message) + "\n" + (((c.connect ?? 0)) ? "" : c.end && c.end()));
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
