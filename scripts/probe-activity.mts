// Loads the admin activity endpoint against the real database and prints the
// merged feed. Read-only: hits GET /admin/activity only.
import "dotenv/config";
import express from "express";
import adminRouter from "../src/routes/admin";

function unwrap(mod: any): any {
  let r = mod?.default ?? mod;
  while (r && typeof r !== "function" && r.default) r = r.default;
  if (typeof r !== "function") throw new Error("could not unwrap router");
  return r;
}

const router = unwrap(await import("../src/routes/admin"));

const app = express();
app.use(express.json());
app.use("/api", router);

const server = app.listen(0, async () => {
  const port = (server.address() as any).port;
  const key = process.env.ADMIN_API_KEY;
  const res = await fetch(`http://127.0.0.1:${port}/api/admin/activity?limit=20`, {
    headers: { "X-Admin-Key": key },
  });
  const body = await res.json() as any;
  console.log("HTTP", res.status, "success:", body.success);
  if (!body.success) { console.log("message:", body.message); server.close(); process.exit(1); }

  const d = body.data;
  console.log("source counts:", JSON.stringify(d.counts));
  console.log("failed sources:", JSON.stringify(d.errors));
  console.log("merged items:", d.items.length);
  console.log("---");
  for (const it of d.items.slice(0, 18)) {
    const amt = it.amount == null ? "" : "  ₹" + Number(it.amount).toLocaleString("en-IN");
    const t = new Date(it.at).toLocaleString("en-IN");
    console.log(
      `${it.type.padEnd(7)} ${(it.status || "").padEnd(10)} ${(it.actor.name || "").padEnd(22)} ${String(it.title).slice(0, 58).padEnd(60)}${amt}  ${t}`,
    );
  }
  server.close();
});