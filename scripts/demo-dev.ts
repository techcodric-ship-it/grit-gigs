import { spawn } from "node:child_process";

/**
 * Run the app against the local demo database.
 *
 * Start scripts/demo-db.ts and scripts/demo-setup.ts first. Points
 * DATABASE_URL at the throwaway PGlite instance so a stray `npm run dev` cannot
 * write demo traffic into production.
 */

const DEMO_URL = process.env.DEMO_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5433/postgres";
const PORT = process.env.DEMO_APP_PORT ?? "5050";

console.log(`app -> ${DEMO_URL} on http://127.0.0.1:${PORT}`);
console.log("feed:    http://127.0.0.1:" + PORT + "/feed.html");
console.log("explore: http://127.0.0.1:" + PORT + "/explore.html\n");

const p = spawn("npx", ["tsx", "src/index.ts"], {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    DATABASE_URL: DEMO_URL,
    NODE_ENV: "development",
    DEMO_MODE: "1",
    PORT,
  },
});
p.on("close", (code) => process.exit(code ?? 0));