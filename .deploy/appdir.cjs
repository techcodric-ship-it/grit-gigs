const { Client } = require("ssh2");
let out = "";
let c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 40000, keepaliveInterval: 15000 };
const cmds = [
  ["echo ===PM2DESC===; pm2 describe 0 2>/dev/null | grep -iE 'script path|exec cwd|interpreter|exec mode|watch|restarts|uptime' | head -10; echo ===PM2CONF===; cat /root/.pm2/dump.pm2 2>/dev/null | head -c 1400; echo ===GIT===; git --version 2>/dev/null || echo NO-GIT", "pm2desc"],
  ["echo ===APPFIND===; APP=$(pm2 describe 0 2>/dev/null | grep -i 'exec cwd' | awk '{print $3}'); echo APP-CWD=$APP; echo ---; ls -la $(dirname $APP 2>/dev/null || echo /) 2>/dev/null | head -25; echo ===SUBDIRS===; for d in $APP; do ls -la $d 2>/dev/null | head -25; done", "appdir"],
  ["echo ===GITSTATE===; APP=$(pm2 describe 0 2>/dev/null | grep -i 'exec cwd' | awk '{print $3}'); cd $APP 2>/dev/null && { echo PWD=$PWD; git remote -v 2>/dev/null | head -4; git log --oneline -3 2>/dev/null; git status --short 2>/dev/null | head -8; echo ---PKG---; cat package.json 2>/dev/null | grep -E '\"(name|main|start|dev|build)\"' | head -8; echo ---PUBLIC-SIZE---; du -sh public 2>/dev/null; ls public/orders.html public/wallet.html public/buy-more.html public/settings.html 2>/dev/null; echo ---BUILD-ARTIFACTS---; ls -la dist build .next 2>/dev/null | head -12; echo ---ENV-FILES---; ls -la .env* 2>/dev/null | head -6; echo ---TSX-OR-DIST---; ls src/index.ts 2>/dev/null && echo TSX-SRC; ls dist/index.js 2>/dev/null && echo DIST-BUILT; } || echo NO-CWD", "gitstate"]
];
let i = 0;
const run = () => {
  if (i >= cmds.length) { c.end(); return; }
  const [cmd, tag] = cmds[i++];
  c.exec(cmd, (err, stream) => {
    if (err) { out += "\n[EXEC-ERR] " + err.message; run(); return; }
    let buf = ""; let errbuf = "";
    stream.on("data", d => buf += d.toString());
    stream.stderr.on("data", d => errbuf += d.toString());
    stream.on("close", () => { out += "\n===== " + tag.toUpperCase() + " =====\n" + buf + errbuf; run(); });
  });
};
run();
c.on("error", e => { out += "\n[CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out); process.exit(0); });
c.connect(H);
