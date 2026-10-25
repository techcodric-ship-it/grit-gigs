// Company name normalization, slug and domain helpers, and the prep_companies
// resolution/creation logic. Pure functions are exported for unit tests; the
// DB-backed functions take the drizzle db instance so tests can stub them.

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { prepCompaniesTable, type PrepCompany } from "./schema";

// Legal suffixes dropped from the END of a normalized name so "Infosys
// Limited" and "infosys" compare equal. Multi-word suffixes are checked
// before single words. Order matters: longest first.
const LEGAL_SUFFIXES = [
  "private limited",
  "proprietary limited",
  "pvt ltd",
  "pvt limited",
  "p limited",
  "ltd",
  "limited",
  "incorporated",
  "inc",
  "llp",
  "llc",
  "co",
  "company",
];

export function normalizeCompanyName(raw: string): string {
  let s = String(raw || "").toLowerCase().trim();
  if (!s) return "";
  // "&" reads as "and" in company names (HUL & Co).
  s = s.replace(/&/g, " and ");
  // Drop anything that is not a letter, digit, space, dot or hyphen.
  s = s.replace(/[^a-z0-9 .-]+/g, " ");
  // Collapse whitespace and tidy separators.
  s = s.replace(/\s+/g, " ").replace(/[.\-]+/g, " ").trim();
  // Strip trailing legal suffixes, longest match first, repeatedly.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (s.length > suffix.length + 1 && s.endsWith(" " + suffix)) {
        s = s.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }
  return s.replace(/\s+/g, " ").trim();
}

export function slugifyCompanyName(raw: string): string {
  const norm = normalizeCompanyName(raw);
  if (!norm) return "";
  return norm
    .split(" ")
    .filter(Boolean)
    .join("-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Hostname of a website URL, lowercased, without "www." or a trailing dot. */
export function domainFromWebsite(website: string | null | undefined): string | null {
  if (!website) return null;
  const raw = String(website).trim();
  if (!raw) return null;
  let host = "";
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  return host || null;
}

/**
 * Deterministic match scoring against a normalized query.
 * 3 = exact normalized name or alias match, 2 = name starts with the query
 * (or vice versa), 1 = query is contained in the name (prefix-word match),
 * 0 = no match. Callers treat any score > 0 as a candidate.
 */
export function scoreCompany(
  company: Pick<PrepCompany, "name" | "aliases">,
  queryNorm: string,
): number {
  if (!queryNorm) return 0;
  const nameNorm = normalizeCompanyName(company.name);
  const aliasNorms = (company.aliases || []).map((a) => normalizeCompanyName(a)).filter(Boolean);
  if (nameNorm === queryNorm || aliasNorms.includes(queryNorm)) return 3;
  if (nameNorm.startsWith(queryNorm + " ") || queryNorm.startsWith(nameNorm + " ")) return 2;
  // Word-boundary containment either way ("Infosys BPM" for query "infosys bpm").
  if (nameNorm.startsWith(queryNorm) || aliasNorms.some((a) => a.startsWith(queryNorm))) return 2;
  if (nameNorm.includes(" " + queryNorm) || nameNorm.includes(queryNorm + " ")) return 1;
  return 0;
}

export interface CompanyCandidate {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  status: string;
  score: number;
}

/** Rank and filter pre-fetched rows against the query. Pure for testing. */
export function pickCandidates(rows: PrepCompany[], rawQuery: string): CompanyCandidate[] {
  const queryNorm = normalizeCompanyName(rawQuery);
  if (!queryNorm) return [];
  const scored = rows
    .map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      domain: row.domain,
      status: row.status,
      score: scoreCompany(row, queryNorm),
    }))
    .filter((c) => c.score > 0);
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored;
}

// The live drizzle instance from src/db, typed structurally so tests can
// pass any compatible object.
import type { db as liveDb } from "../db";
type Db = typeof liveDb;

/**
 * Resolve a typed company name against prep_companies. Returns ranked
 * candidates; empty means "no match — caller may create a pending record".
 */
export async function resolveCompany(db: Db, rawQuery: string): Promise<CompanyCandidate[]> {
  const queryNorm = normalizeCompanyName(rawQuery);
  if (!queryNorm) return [];
  // Fetch a bounded candidate set from the DB, then rank in JS so the same
  // normalization used by tests applies in production.
  const rows = await db
    .select()
    .from(prepCompaniesTable)
    .where(sql`LOWER(${prepCompaniesTable.name}) LIKE ${"%" + queryNorm.toLowerCase() + "%"}
       OR LOWER(${prepCompaniesTable.slug}) LIKE ${"%" + queryNorm.toLowerCase() + "%"}
       OR EXISTS (SELECT 1 FROM unnest(${prepCompaniesTable.aliases}) a WHERE LOWER(a) LIKE ${"%" + queryNorm.toLowerCase() + "%"})`)
    .limit(25);
  return pickCandidates(rows as PrepCompany[], rawQuery);
}

export async function createPendingCompany(
  db: Db,
  input: { name: string; website?: string | null; domain?: string | null; createdBy?: string | null },
): Promise<PrepCompany> {
  const name = input.name.trim();
  if (!name) throw new Error("Company name is required");
  let slug = slugifyCompanyName(name);
  if (!slug) slug = "company";
  const domain = (input.domain ? String(input.domain).trim() : null) || domainFromWebsite(input.website);
  // Unique slug: append -2, -3… on conflict (pending records must not collide).
  let finalSlug = slug;
  for (let i = 2; i < 100; i++) {
    const clash = await db
      .select({ id: prepCompaniesTable.id })
      .from(prepCompaniesTable)
      .where(eq(prepCompaniesTable.slug, finalSlug))
      .limit(1);
    if (!clash.length) break;
    finalSlug = `${slug}-${i}`;
  }
  const inserted = await db
    .insert(prepCompaniesTable)
    .values({
      slug: finalSlug,
      name: name.slice(0, 200),
      aliases: [],
      domain: domain ? domain.slice(0, 200) : null,
      website: input.website ? String(input.website).slice(0, 500) : null,
      status: "PENDING",
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return inserted[0] as PrepCompany;
}

/** Admin: companies created from member submissions awaiting a decision. */
export async function listPendingCompanies(db: Db): Promise<PrepCompany[]> {
  return db
    .select()
    .from(prepCompaniesTable)
    .where(eq(prepCompaniesTable.status, "PENDING"))
    .orderBy(prepCompaniesTable.createdAt);
}

/** Admin: PENDING -> ACTIVE. Returns null when the row is not pending. */
export async function approvePendingCompany(db: Db, id: string): Promise<PrepCompany | null> {
  const rows = await db
    .update(prepCompaniesTable)
    .set({ status: "ACTIVE" })
    .where(and(eq(prepCompaniesTable.id, id), eq(prepCompaniesTable.status, "PENDING")))
    .returning();
  return (rows[0] as PrepCompany) ?? null;
}

/**
 * Persist a live-verified official website onto a company row that had none
 * (search-created companies start with website=null; the official adapter
 * guesses + fetch-verifyies a domain, and the router calls this so the guess
 * runs at most once per company). Refuses to overwrite an existing website.
 */
export async function markCompanyWebsiteVerified(db: Db, id: string, website: string): Promise<PrepCompany | null> {
  const domain = domainFromWebsite(website);
  const rows = await db
    .update(prepCompaniesTable)
    .set({
      website: website.slice(0, 500),
      ...(domain ? { domain: domain.slice(0, 200) } : {}),
    })
    .where(and(eq(prepCompaniesTable.id, id), or(isNull(prepCompaniesTable.website), eq(prepCompaniesTable.website, ""))))
    .returning();
  return (rows[0] as PrepCompany) ?? null;
}

/**
 * Admin: delete a PENDING company that nothing references yet. Returns false
 * when the row is not pending — the router owns the orphan check.
 */
export async function deletePendingCompany(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(prepCompaniesTable)
    .where(and(eq(prepCompaniesTable.id, id), eq(prepCompaniesTable.status, "PENDING")))
    .returning({ id: prepCompaniesTable.id });
  return rows.length > 0;
}
