// Phase 0 barter protection guard.
//
// Fails (exit 1) when either:
//   (a) a barter-locked file's committed bytes (git blob at HEAD) differ from
//       the SHA-256 baseline in docs/prep-barter-lock.json, or
//   (b) the diff under test touches a barter-locked path (working tree,
//       staged, or an explicit git range).
//
// Hashing the committed blob (not the working tree) keeps the check stable on
// Windows checkouts where autocrlf rewrites line endings; any real edit still
// fails either the blob check (if committed) or the diff check (if not).
//
// Usage:
//   node scripts/prep-guard.mjs                 # blob check + working diffs
//   node scripts/prep-guard.mjs <a>..<b>        # additionally check a git range
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = resolve(root, "docs", "prep-barter-lock.json");

if (!existsSync(lockPath)) {
  console.error("prep-guard: docs/prep-barter-lock.json is missing");
  process.exit(1);
}
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const locked = lock.files || {};

let failures = 0;

const git = (args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const gitBuffer = (args) =>
  execFileSync("git", args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });

// (a) committed-blob hash check.
for (const [file, want] of Object.entries(locked)) {
  let blob;
  try {
    blob = gitBuffer(["show", `HEAD:${file}`]);
  } catch {
    console.error(`prep-guard: LOCKED FILE MISSING FROM HEAD: ${file}`);
    failures++;
    continue;
  }
  const got = createHash("sha256").update(blob).digest("hex");
  if (got !== want) {
    console.error(`prep-guard: HASH MISMATCH: ${file}`);
    console.error(`  baseline: ${want}`);
    console.error(`  current:  ${got}`);
    failures++;
  }
}

// (b) diff check — no commit or working-tree change may touch a locked path.
const changed = new Set();
const collect = (out) => {
  for (const line of out.split("\n")) {
    const f = line.trim().replace(/^["']|["']$/g, "");
    if (!f) continue;
    // Renames are reported as "old -> new"; both sides are checked.
    for (const part of f.split(" -> ")) if (locked[part]) changed.add(part);
  }
};

try { collect(git(["diff", "--name-only", "HEAD"])); } catch { /* no HEAD yet */ }
try { collect(git(["diff", "--name-only", "--cached", "HEAD"])); } catch { /* nothing staged */ }

const range = process.argv[2] || process.env["PREP_GUARD_RANGE"] || "";
if (range) {
  try { collect(git(["diff", "--name-only", range])); } catch (e) {
    console.error(`prep-guard: could not diff range ${range}: ${e.message}`);
    failures++;
  }
}

for (const f of changed) {
  console.error(`prep-guard: BARTER PATH TOUCHED BY DIFF: ${f}`);
  failures++;
}

if (failures > 0) {
  console.error(`prep-guard: FAILED with ${failures} violation(s). Barter files are READ-ONLY (docs/prep-audit.md §1).`);
  process.exit(1);
}
console.log(`prep-guard: OK (${Object.keys(locked).length} barter files byte-identical, no barter path in diff)`);
