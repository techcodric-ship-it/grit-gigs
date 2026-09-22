const { Client } = require("../node_modules/ssh2");
const c = new Client();
let out = "";
c.on("ready", () => {
  const cmds = [
    ["echo ===PUBLIC-MISSING===; cd /opt/gritgigs/public 2>/dev/null && for f in wallet.html buy-more.html settings.html bids.html credits.html credits-bundle.html; do [ -f $f ] && echo \"$f=YES\" || echo \"$f=NO\"; done; echo ===FEED-CSS-PURPLE===; grep -o 'signal:[^;]*' /opt/gritgigs/public/assets/feed.css 2>/dev/null | head -2; echo ===LIKED-VAR===; grep -o -- '--signal:[^;]*' /opt/gritgigs/public/assets/feed.css 2>/dev/null | head -2", "PUB"],
    ["echo ===GIT-LOG-BOX===; cd /opt/gritgigs && git log --oneline -4 2>/dev/null; echo ===GIT-REMOTE-BOX===; git remote -v 2>/dev/null | head -2; echo ===GIT-STATUS-BOX===; git status --short 2>/dev/null | head -8; echo ===PM2-CWD===; pm2 describe gritgigs 2>/dev/null | grep -iE 'exec cwd|script path|script args|interpreter|restarts|status' | head -8", "GIT"],
    ["echo ===PORT3000===; ss -ltn | grep -E ':3000|:80 |:443 ' | head -4; echo ===CADDY===; ls -la /etc/caddy/Caddyfile 2>/dev/null && grep -nE 'grit|gig|reverse_proxy|:80|:443' /etc/caddy/Caddyfile 2>/dev/null | head -15; echo ===ENV-HAVE===; grep -oE '^(DATABASE_URL|PGHOST|PORT|RAZORPAY_KEY_ID|SESSION_SECRET|PUBLIC_URL|DOMAIN)=(|[^ ]*)$' /opt/gritgigs/.env 2>/dev/null | sed 's/=.*/=<set>/' | head -10", "ENV"],
    ["echo ===NODE-ASSETS-FEED===; grep -n 'like' /opt/gritgigs/public/assets/feed-app.js 2>/dev/null | grep -iE 'color|heart|signal|\\.liked' | head -6; echo ===STYLE-INPUT===; grep -n 'type=\"file\"' -r /opt/gritgigs/public/feed.html /opt/gritgigs/public/orders.html 2>/dev/null | head -6; echo ===FROM-DIR-LIST===; ls -la /opt/gritgigs 2>/dev/null | grep -E 'package.json|tsconfig|ecosystem|pm2|node_modules|public|dist|src' | head -12", "SRC"]];
  let i = 0;
  const run = () => {
    if (i >= cmds.length) { c.end(); return; }
    const [cmd, tag] = cmds[i++];
    c.exec(cmd, (err, stream) => {
      if (err) { out += "\n[" + tag + " EXEC-ERR] " + err.message; run(); return; }
      let buf = "";
      stream.on("data", d => buf += d.toString());
      stream.stderr.on("data", d => buf += d.toString());
      stream.on("close", () => { out += "\n===== " + tag + " =====\n" + buf.trim(); run(); });
    });
  };
  run();
});
c.on("error", e => { out += "\n[CONN-ERR] " + (e.code || e.message); });
c.on("close", () => { console.log(out.trim()); });
c.connect({ host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 30000 });
