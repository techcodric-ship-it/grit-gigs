const { Client } = require("ssh2");
const c = new Client();
let out = "";
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 60000 };
c.on("ready", () => {
  const cmds = [
    ["echo ===LIVE-FEED-STATIC-REFS===; curl -s http://127.0.0.1:3000/feed 2>/dev/null | grep -oE '<link[^>]*feed[^>]*>|<script[^>]*feed[^>]*>|<link[^>]*css[^>]*>' | head -10; echo ===LIVE-FEED-HEADER-LINKS===; curl -s http://127.0.0.1:3000/feed 2>/dev/null | grep -oiE 'href=\"[^\"]*(wallet|orders|settings|buy-more|explore|feed)[^\"]*\"' | sort -u | head -12", "LIVE1"],
    ["echo ===LIVE-CSS-VERSION===; curl -s -o /dev/null -w '%{http_code} %{size_download}B url=%{url_effective}\\n' http://127.0.0.1:3000/assets/feed.css 2>/dev/null; curl -s -o /dev/null -w '%{http_code} %{size_download}B url=%{url_effective}\\n' http://127.0.0.1:3000/feed.css 2>/dev/null; echo ===DISK-CSS-SIGNAL-ALL===; grep -oE -- '--signal: ?[^;]*' /opt/gritgigs/public/feed.css /opt/gritgigs/public/assets/feed.css /opt/gritgigs/public/assets/*.css 2>/dev/null | head -8", "CSS"],
    ["echo ===DIST-?-SERVE-ROOT===; ls -la /opt/gritgigs/dist 2>/dev/null | head -6; echo ===EXPRESS-STATIC===; grep -rnE 'express.static|sendFile|\.html|APP_DIR|__dirname|serveStatic' /opt/gritgigs/src/index.ts /opt/gritgigs/src/app.ts /opt/gritgigs/src/*.ts 2>/dev/null | grep -ivE 'console|//' | head -14; echo ===PUBLIC-IN-SRC===; grep -rnE \"'public'|\\\"public\\\"|/public\" /opt/gritgigs/src/app.ts /opt/gritgigs/src/index.ts 2>/dev/null | head -8", "SERVE"]
  ];
  let i = 0;
  const run = () => {
    if (i >= cmds.length) { c.end(); return; }
    const [cmd, tag] = cmds[i++];
    c.exec(cmd, (err, stream) => {
      if (err) { out += "\n[" + tag + "-EXEC-ERR] " + err.message; run(); return; }
      let buf = "";
      stream.on("data", d => buf += d.toString());
      stream.stderr.on("data", d => buf += d.toString());
      stream.on("close", () => { out += "\n===== " + tag + " =====\n" + buf.trim(); run(); });
    });
  };
  run();
});
c.on("error", e => { out += "\n[CONN-ERR] " + (e.code || e.message); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
