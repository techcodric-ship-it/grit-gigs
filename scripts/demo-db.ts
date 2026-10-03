import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

/**
 * Local demo database for development.
 *
 * This machine has no local Postgres, no Docker, and the only reachable
 * database is production - so development happens against PGlite, which is
 * real Postgres compiled to WebAssembly, exposed over a TCP socket that the
 * app's existing node-postgres driver connects to unchanged.
 *
 * Data lives in .demo-db/ and is disposable. Nothing here can reach production:
 * the bind address is loopback and the seed script refuses any remote target.
 *
 * Usage:
 *   npm run demo:db          # terminal 1 - leave running
 *   npm run demo:setup       # terminal 2 - create schema + load demo data
 *   npm run demo:dev         # terminal 2 - run the app against it
 */

const PORT = Number(process.env.DEMO_DB_PORT ?? 5433);
const DATA_DIR = process.env.DEMO_DB_DIR ?? ".demo-db";
const URL = `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`;

async function main() {
  const db = await PGlite.create({ dataDir: DATA_DIR });
  const server = new PGLiteSocketServer({
    db,
    port: PORT,
    host: "127.0.0.1",
    maxConnections: 10,
  });
  await server.start();

  console.log(`demo database listening on ${server.getServerConn()}`);
  console.log(`DATABASE_URL=${URL}`);
  console.log(`data dir: ${DATA_DIR}`);
  console.log("\nleave this running, then:");
  console.log("  npm run demo:setup   # schema + demo data");
  console.log("  npm run demo:dev     # app on http://localhost:3000\n");

  const shutdown = async () => {
    await server.stop().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Hold the process open.
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});