import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// The barter protection guard itself must work: locked files byte-compared
// against the committed-blob baseline, and any diff touching a locked path
// rejected even if the attacker also updates the baseline. These tests run the
// real scripts/prep-guard.mjs against a throwaway git repo so the actual
// barter files are never touched, not even transiently.

const GUARD_SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "scripts", "prep-guard.mjs",
);

let repo: string;
let lockPath: string;

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const runGuard = (extraArgs: string[] = []) => {
  try {
    const out = execFileSync("node", ["scripts/prep-guard.mjs", ...extraArgs], {
      cwd: repo,
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

const blobHash = (file: string) =>
  createHash("sha256")
    .update(execFileSync("git", ["show", `HEAD:${file}`], { cwd: repo }))
    .digest("hex");

const writeLock = () =>
  writeFileSync(
    lockPath,
    JSON.stringify({ files: { "src/barterish.ts": blobHash("src/barterish.ts") } }),
  );

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "prep-guard-"));
  mkdirSync(join(repo, "scripts"));
  mkdirSync(join(repo, "docs"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "scripts", "prep-guard.mjs"), readFileSync(GUARD_SRC, "utf8"));
  writeFileSync(join(repo, "src", "barterish.ts"), "export const ok = 1;\n");
  lockPath = join(repo, "docs", "prep-barter-lock.json");
  git("init");
  git("config", "user.email", "guard@test");
  git("config", "user.name", "guard");
  // Keep working bytes identical to committed bytes so hash assertions are
  // exact regardless of the host OS line-ending settings.
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git("commit", "-m", "base file");
  writeLock();
  git("add", ".");
  git("commit", "-m", "lock");
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("prep-guard (barter protection CI script)", () => {
  it("passes when locked files are byte-identical and untouched", () => {
    const r = runGuard();
    expect(r.out).toContain("prep-guard: OK");
    expect(r.code).toBe(0);
  });

  it("fails when a locked file is edited in the working tree", () => {
    const target = join(repo, "src", "barterish.ts");
    const original = readFileSync(target);
    try {
      writeFileSync(target, "export const ok = 2;\n");
      const r = runGuard();
      expect(r.code).toBe(1);
      expect(r.out).toContain("BARTER PATH TOUCHED BY DIFF");
    } finally {
      writeFileSync(target, original);
    }
    expect(runGuard().code).toBe(0);
  });

  it("fails when a locked file is deleted from the working tree", () => {
    const target = join(repo, "src", "barterish.ts");
    const original = readFileSync(target);
    try {
      rmSync(target);
      const r = runGuard();
      expect(r.code).toBe(1);
      expect(r.out).toContain("BARTER PATH TOUCHED BY DIFF");
    } finally {
      writeFileSync(target, original);
    }
    expect(runGuard().code).toBe(0);
  });

  it("fails when a commit changes a locked file's bytes (baseline not updated)", () => {
    const before = git("rev-parse", "HEAD").trim();
    try {
      writeFileSync(join(repo, "src", "barterish.ts"), "export const ok = 3;\n");
      git("add", ".");
      git("commit", "-m", "edit locked file");
      const r = runGuard();
      expect(r.code).toBe(1);
      expect(r.out).toContain("HASH MISMATCH");
    } finally {
      execFileSync("git", ["reset", "--hard", before], { cwd: repo });
    }
    expect(runGuard().code).toBe(0);
  });

  it("fails when the diff range touches a locked path, even with an updated baseline", () => {
    const before = git("rev-parse", "HEAD").trim();
    try {
      // Edit the locked file AND refresh the lock baseline in one commit:
      // the hash check passes, but the range diff check must still reject it.
      writeFileSync(join(repo, "src", "barterish.ts"), "export const ok = 4;\n");
      git("add", ".");
      git("commit", "-m", "edit locked file");
      writeLock();
      git("add", ".");
      git("commit", "-m", "update baseline");
      const r = runGuard([`${before}..HEAD`]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("BARTER PATH TOUCHED BY DIFF");
      expect(r.out).toContain("src/barterish.ts");
    } finally {
      execFileSync("git", ["reset", "--hard", before], { cwd: repo });
    }
    expect(runGuard().code).toBe(0);
  });
});
