const { execFileSync } = require("child_process");
const repo = "C:\\Users\\amuth\\Downloads\\swiftexchange-full\\swiftexchange-full\\swiftexchange";
function run(args, opts) {
  opts = opts || {};
  try {
    const r = execFileSync("git", args, Object.assign({ cwd: repo, encoding: "utf8" }, opts));
    return { ok: true, out: r.trim() };
  } catch (e) {
    const msg = (e.stdout || "") + "\n" + (e.stderr || "");
    return { ok: false, out: msg.trim(), code: e.status };
  }
}
console.log("===PUSH===");
const p = run(["push", "origin", "main"], { timeout: 80000 });
console.log(p.out ? p.out.split("\n").slice(-14).join("\n") : "");
console.log("PUSH-OK=" + p.ok);
if (p.ok) {
  console.log("===STATE===");
  console.log(run(["rev-parse", "--short", "HEAD"]).out);
  console.log("===AHEAD-BEHIND===");
  console.log(run(["rev-list", "--left-right", "--count", "origin/main...HEAD"]).out);
}
