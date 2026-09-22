const { Client } = require("ssh2");
const fs = require("fs");
const path = require("path");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 60000 };
let out = "";
const localRoot = path.join(__dirname, "..");
const read = p => { const f = path.join(localRoot, p); return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null; };
c.on("ready", () => {
  c.sftp((err, sftp) => {
    if (err) { out += "[SFTP-ERR] " + err.message; return c.end(); }
    const localCss = read("public/feed.css");
    const localJs = read("public/feed-app.js");
    const localFeed = read("public/feed.html");
    let n = 0;
    const doNext = () => {
      cmds = [];
      if (localCss) cmds.push(["public/assets/feed.css", localCss]);
      if (localJs) cmds.push(["public/assets/feed-app.js", localJs]);
      // also keep root copies for any direct refs
      if (localCss) cmds.push(["public/feed.css", localCss]);
      if (localJs) cmds.push(["public/feed-app.js", localJs]);
      const vCss = localCss && localCss.match(/--signal:\s*#[0-9a-f]+/i) ? "PURPLE" : "CHECK";
      out += "[CSS-SIGNAL-DETECT] " + vCss + "\n";
      uploadNext(sftp, cmds, 0);
    };
    function uploadNext(sftp, files, idx) {
      if (idx >= files.length) return verify(sftp);
      const [dst, data] = files[idx];
      sftp.writeFile("/opt/gritgigs/" + dst, data, e => {
        if (e) out += "[UPLOAD-FAIL " + dst + "] " + e.message + "\n";
        else out += "[OK] " + dst + " (" + data.length + "B)\n";
        uploadNext(sftp, files, idx + 1);
      });
    }
    function verify() {
      out += "===VERIFY===\n";
      c.exec("cd /opt/gritgigs/public/assets && echo ===DISK-SIGNAL===; grep -hoE -- '--signal: ?#[0-9a-f]+' feed.css | head -2; echo ===SERVED-VIA-HTTP===; curl -s http://127.0.0.1:3000/assets/feed.css | grep -hoE -- '--signal: ?#[0-9a-f]+' | head -2; echo ===FEED-REFS===; grep -oE 'assets/feed(-app)?\\.(css|js)\\?v=[0-9]+' /opt/gritgigs/public/feed.html | sort -u; echo ===VERSION-ROLL===; sed -i -E 's/(assets/feed\\.css\\?v=)[0-9]+/\\118/; s/(assets/feed-app\\.js\\?v=)[0-9]+/\\112/' /opt/gritgigs/public/feed.html && echo ROLLED && grep -oE 'assets/feed(-app)?\\.(css|js)\\?v=[0-9]+' /opt/gritgigs/public/feed.html | sort -u; pm2 restart gritgigs >/dev/null 2>&1 && echo PM2-RESTARTED; sleep 5; echo ===LIVE-CODE===; curl -s -o /dev/null -w 'feed:%{http_code} ' http://127.0.0.1:3000/feed; curl -s -o /dev/null -w 'orders:%{http_code} ' http://127.0.0.1:3000/orders; curl -s -o /dev/null -w 'wallet:%{http_code} ' http://127.0.0.1:3000/wallet; curl -s -o /dev/null -w 'buymore:%{http_code} ' http://127.0.0.1:3000/buy-more; curl -s -o /dev/null -w 'settings:%{http_code}' http://127.0.0.1:3000/settings; echo; echo ===LIVE-SIGNAL-HEADLINE===; curl -s http://127.0.0.1:3000/assets/feed.css | grep -hoE -- '--signal: ?#[0-9a-f]+' | head -1", (err, stream) => {
        if (err) { out += "[VERIFY-EXEC-ERR] " + err.message; return c.end(); }
        let buf = "";
        stream.on("data", d => buf += d.toString());
        stream.stderr.on("data", d => buf += d.toString());
        stream.on("close", () => { out += buf.trim() + "\nVERIFY-DONE\n"; c.end(); });
      });
    }
    doNext();
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out.trim()); });
c.connect(H);
