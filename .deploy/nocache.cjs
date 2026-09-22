const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
c.on("ready", () => {
  const cmd = "cd /opt/gritgigs && echo ===APP-TS-HEADERS-BEFORE===; grep -nE 'setHeader|Cache-Control|no-cache|no-store|must-revalidate|max-age|expires' src/app.ts src/index.ts 2>/dev/null | head -12; echo ===PATCH-NO-CACHE===; node - <<'EOF'
const fs = require("fs");
const p = "src/app.ts";
let s = fs.readFileSync(p, "utf8");
const anchor = "app.use((req, res, next) => {";
const inj = "app.use((req, res, next) => {\n  if (req.path.endsWith(\".html\") || req.path === \"/feed\" || req.path === \"/\" ) {\n    res.setHeader(\"Cache-Control\", \"no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0\");\n    res.setHeader(\"Pragma\", \"no-cache\");\n    res.setHeader(\"Expires\", \"0\");\n  }\n";
if (s.includes(inj)) { console.log("ALREADY-PATCHED"); process.exit(0); }
if (s.includes(anchor)) { s = s.replace(anchor, inj); fs.writeFileSync(p, s); console.log("PATCHED-VIA-ANCHOR"); process.exit(0); }
console.log("ANCHOR-NOT-FOUND — injecting before first app.use");
const m = s.match(/^app\.use\\(/m);
if (!m) { console.log("NO-APP-USE-FOUND"); process.exit(1); }
s = s.replace(/^app\.use\(/m, inj + "\napp.use(");
fs.writeFileSync(p, s);
console.log("PATCHED-VIA-REGEX");
EOF
echo ===APP-TS-HEADERS-AFTER===; grep -nE 'Cache-Control|no-store|no-cache|must-revalidate|Pragma|Expires' src/app.ts | head -10; echo ===TS-CHECK===; cd /opt/gritgigs && (npx tsc --noEmit 2>&1 | head -12 || true); echo ===PM2-RESTART===; pm2 restart gritgigs >/dev/null 2>&1 && echo RESTARTED; sleep 6; echo ===VERIFY-HEADERS-LOCAL===; curl -s -I http://127.0.0.1:3000/feed | grep -iE 'cache-control|pragma|expires|HTTP/'; echo ===HTTP-CODES-PUBLIC-DOMAIN===; for p in feed wallet settings orders buy-more; do printf '%s=%s ' $p $(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://gritandgigs.in/$p); done; echo; echo ===VERIFY-HEADERS-PUBLIC===; for p in wallet settings; do echo ---$p---; curl -s -I --max-time 20 https://gritandgigs.in/$p | grep -iE 'cache-control|HTTP/'; done; echo ===ALL-DONE===";
  c.exec(cmd, (err, stream) => {
    if (err) { out += "[EXEC-ERR] " + err.message; return c.end(); }
    let b = "";
    stream.on("data", d => b += d.toString());
    stream.stderr.on("data", d => b += d.toString());
    stream.on("close", () => { out += b.trim(); c.end(); });
  });
});
c.on("error", e => out += "[CONN-ERR] " + (e.code || e.message));
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
