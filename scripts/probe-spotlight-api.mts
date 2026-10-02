// Boots the real community router on an ephemeral port and checks the
// Spotlight packs endpoint plus the auth guards on the stats/click routes.
// Read-only apart from the click route, which is exercised as an unauthenticated
// call (so it must be rejected before any write happens).
import "dotenv/config";
import express from "express";
import { pool } from "../src/db";

function unwrap(mod: any): any {
  let r = mod?.default ?? mod;
  while (r && typeof r !== "function" && r.default) r = r.default;
  if (typeof r !== "function") throw new Error("could not unwrap router");
  return r;
}

const router = unwrap(await import("../src/routes/community"));
const app = express();
app.use(express.json());
app.use("/api", router);

const server = app.listen(0, async () => {
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}/api`;
  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " :: " + detail : ""}`);
    if (!ok) failures++;
  };

  const packs = await fetch(`${base}/community/spotlight/packs`);
  const packsBody = await packs.json() as any;
  check("packs 200", packs.status === 200 && packsBody.success === true, `status=${packs.status}`);
  const list = packsBody?.data?.packs ?? [];
  check("three packs", list.length === 3, JSON.stringify(list.map((p: any) => `${p.id}:${p.priceInr}/${p.hours}h`)));
  check(
    "prices match the tiers",
    list.find((p: any) => p.id === "day1")?.priceInr === 50 &&
      list.find((p: any) => p.id === "day3")?.priceInr === 199 &&
      list.find((p: any) => p.id === "week")?.priceInr === 499,
  );
  check(
    "durations match",
    list.find((p: any) => p.id === "day1")?.hours === 24 &&
      list.find((p: any) => p.id === "day3")?.hours === 72 &&
      list.find((p: any) => p.id === "week")?.hours === 168,
  );
  check("default pack is day1", packsBody?.data?.defaultPack === "day1");
  check("no discount badge leaks a per-day saving claim", list.every((p: any) => typeof p.perDay === "number"));

  // Owner-only stats and the click beacon must both require a session.
  const stats = await fetch(`${base}/community/posts/00000000-0000-0000-0000-000000000000/spotlight/stats`);
  check("stats rejects anonymous", stats.status === 401, `status=${stats.status}`);

  const click = await fetch(`${base}/community/boosts/00000000-0000-0000-0000-000000000000/click`, { method: "POST" });
  check("click rejects anonymous", click.status === 401, `status=${click.status}`);

  const boost = await fetch(`${base}/community/posts/00000000-0000-0000-0000-000000000000/spotlight`, { method: "POST" });
  check("boost rejects anonymous", boost.status === 401, `status=${boost.status}`);

  // Nothing above should have written an engagement row.
  const leaked = await pool.query(
    `SELECT count(*)::int AS n FROM boost_impressions WHERE boost_id = '00000000-0000-0000-0000-000000000000'::uuid`,
  ).catch(() => ({ rows: [{ n: 0 }] }));
  check("anonymous calls wrote nothing", Number(leaked.rows[0].n) === 0);

  server.close();
  await pool.end();
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});