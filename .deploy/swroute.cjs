const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000 };
let out = "";
c.on("ready", () => {
  const q = "navigator.serviceWorker && navigator.serviceWorker.register('/sw.js')";
  const cntl = "navigator.serviceWorker.controller";
  const cmd =
    "echo ===SWUREG-COUNT-IN-PAGES===; for p in feed orders wallet buy-more settings; do printf '%s: ' $p; curl -s http://127.0.0.1:3000/$p | grep -oE \"serviceWorker\\.register\\('[^']+'\" | head -1; done;" +
    " echo ===SWJS-SERVED-STATUS===; curl -s -o /dev/null -w '%{http_code} %{size_download}B' http://127.0.0.1:3000/sw.js; echo;" +
    " echo ===SWJS-CONTENT-SNIPPET===; curl -s http://127.0.0.1:3000/sw.js | head -c 1200; echo; echo ===SWJS-LINES===; curl -s http://127.0.0.1:3000/sw.js | wc -l";
  c.exec(cmd, (err, stream) => {
    if (err) { out += "[EXEC-ERR] " + err.message; return c.end(); }
    let b = "";
    stream.on("data", d => b += d.toString());
    stream.stderr.on("data", d => b += d.toString());
    stream.on("close", () => { out += b.trim(); c.end(); });
  });
});
c.on("error", e => { out += "[CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
