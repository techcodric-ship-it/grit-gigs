const { Client } = require("ssh2");
const c = new Client();
let out = "";
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 40000 };
const navLine = '<a href="/orders.html" title="Orders"><svg viewBox="0 0 24 24"><path d="M21 8.2 12 3 3 8.2v7.6L12 21l9-5.2Z"/><path d="M3.3 8.3 12. 13.3l8.7-5"/><path d="M12 13.3V21"/></svg></a>';
const walletA = '<a href="/wallet.html" title="Wallet"><svg viewBox="0 0 24 24"><path d="M4 6h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M16 13h4"/></svg></a>';
const buymoreA = '<a href="/buy-more.html" title="Buy more"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></a>';
const settingsA = '<a href="/settings.html" title="Settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.5l1.8 2.6 3.2-.5 1 3.1 3 .2-. accepting 1.6 2 2.8-1.9 2.1.3 3. cleaning 3-1.6  spare"/></svg></a>';
const insert = "  " + walletA + "\n    " + buymoreA + "\n    " + settingsA + "\n  ";
const cmd = "cd /opt/gritgigs && for f in public/feed.html public/feed-hub.html public/feed-lite.html; do if [ -f $f ]; then if grep -q 'href=\"/wallet.html\"' $f; then echo \"$f HAS-WALLET\"; else perl -0pi -e 's#<a href=\"/orders\\.html\" title=\"Orders\">#<a href=\"/wallet.html\" title=\"Wallet\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 6h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z\"/></svg></a>\n    <a href=\"/buy-more.html\" title=\"Buy more\"><svg viewBox=\"0 0 24 24\"><path d=\"M12 5v14M5 12h14\"/></svg></a>\n    <a href=\"/settings.html\" title=\"Settings\"><svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"3\"/></svg></a>\n    <a href=\"/orders.html\" title=\"Orders\">#; ' $f && echo \"$f PATCHED\"; fi; fi; done; echo ===VERIFY-NAV===; for f in public/feed.html public/feed-hub.html public/feed-lite.html; do [ -f $f ] && printf '%s: %s %s %s\n' $f $(grep -c 'href=\"/wallet.html\"' $f) $(grep -c 'href=\"/buy-more.html\"' $f) $(grep -c 'href=\"/settings.html\"' $f); done; pm2 restart gritgigs >/dev/null 2>&1 && echo PM2-RESTARTED; sleep 1";
c.on("ready", () => {
  c.exec(cmd, (err, stream) => {
    if (err) return c.end();
    let buf = "";
    stream.on("data", d => buf += d.toString());
    stream.stderr.on("data", d => buf += d.toString());
    stream.on("close", () => { out += buf.trim(); c.end(); });
  });
});
c.on("error", e => { out += "[ERR] " + (e.code || e.message); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
