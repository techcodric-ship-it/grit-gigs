const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 60000 };
const { Client } = require("../.deploy/node_modules/ssh2");
const c = new Client();
let out = "";
c.on("ready", () => {
  const cmds = [
    ["pm2 describe 0 2>/dev/null | grep -iE 'exec cwd|script|interpreter|node|watch|restarts|uptime|pid' | head -14", "PM2"],
    ["echo ---LSROOT---; ls -la /root 2>/dev/null | head -16; echo ---LS-SRV---; ls -la /srv 2>/dev/null; echo ---LS-VARWWW---; ls -la /var/www 2>/dev/null; echo ---FIND-PKG---; find /root /srv /var/www /opt /home -maxdepth 4 -name package.json 2>/dev/null | grep -v node_modules | head -12", "DIRS"],
    ["echo ---GIT-WORKTREES---; for d in /root /srv /var/www /opt/*; do [ -d \"$d/.git\" ] && echo \"GIT: $d\" && git -C $d log --oneline -1 2>/dev/null; done; echo ---DISK---; df -h / | tail -1", "GIT"]
  ];
  let i = 0;
  function run() {
    if (i >= cmds.length) { c.end(); return; }
    let [cmd, tag] = cmds[i++];
    c.exec(cmd, (err, stream) => {
      let buf = "";
      if (err) { out += "\n[" + tag + " EXEC-ERR] " + err.message + "\n"; run(); return; }
      stream.on("data", (d) => buf += d.toString());
      stream.stderr.on("data", (d) => buf += d.toString());
      stream.stderr.on("close", () => { if (stream.exitCode !== 0 && !buf.trim()) buf += "[exit=" + stream.exitCode + "]"; });
      stream.on("close", () => {
        out += "\n===== " + tag + " =====\n" + buf.trim() + "\n";
        run();
      });
    });
  }
  run();
});
c.on("error", (e) => { out += "\n[CONN-ERR] " + (e.code || e.message) + "\n"; });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
