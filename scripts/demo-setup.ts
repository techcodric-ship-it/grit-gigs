import { spawn } from "node:child_process";

/**
 * Prepare the local demo database: create the schema, then load demo data.
 *
 * Sets DATABASE_URL to the throwaway PGlite instance, so it cannot inherit the
 * production URL by accident. Run scripts/demo-db.ts first.
 */

const DEMO_URL = process.env.DEMO_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5433/postgres";

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, ...env },
    });
    p.on("error", reject);
    p.on("close", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const env = { DATABASE_URL: DEMO_URL, NODE_ENV: "development", DEMO_MODE: "1" };

  console.log("target:", DEMO_URL, "\n");
  console.log("> creating schema");
  const push = await run(
    "npx",
    ["drizzle-kit push --config=drizzle.config.js --force"],
    env,
  );
  if (push !== 0) {
    console.error("\nschema push failed. Is the demo database running? Start it with: npm run demo:db");
    process.exit(push);
  }

  console.log("\n> loading demo data");
  const seed = await run("npx", ["tsx scripts/seed-demo.ts"], env);
  if (seed !== 0) {
    console.error("\nseed failed");
    process.exit(seed);
  }

  console.log("\nready. Start the app with:  npm run demo:dev");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});