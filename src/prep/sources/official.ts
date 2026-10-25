// Official-site adapter: fetches the company's own website and careers page
// (label OFFICIAL). Every URL goes through the SSRF/denylist/robots checks.

import { checkSourceUrl, defaultResolve, fetchRobots, isPathDisallowed, type UrlCheckOptions } from "./urls";
import { defaultFetch, fetchPage, type FetchLike } from "./fetcher";
import type { SourceAdapter, SourceAdapterResult, SourceDocument } from "./types";

export const CAREERS_PATHS = ["/careers", "/careers/", "/jobs", "/join-us", "/life-at-us"];
/** Whole-adapter wall-clock budget: a cold report must never minutes-stall. */
export const OFFICIAL_BUDGET_MS = 8000;

export interface OfficialAdapterOptions {
  fetchImpl?: FetchLike;
  urlOptions?: UrlCheckOptions;
  maxDocs?: number;
}

// Tokens too generic to seed a domain from ("Tata Services Ltd" must not
// become services.com). Checked against every word of the company name.
const GENERIC_NAME_TOKENS = new Set([
  "the", "and", "for", "with", "of", "in", "at", "a", "an",
  "pvt", "ltd", "limited", "inc", "co", "company", "private", "proprietary",
  "llp", "llc", "group", "holdings", "enterprise", "enterprises",
  "services", "service", "solutions", "solution", "systems", "system",
  "technologies", "technology", "tech", "labs", "lab",
  "digital", "global", "india", "indian", "international",
]);

/**
 * Candidate official domains derived from the company name — used ONLY when
 * the database has no website/domain yet. Candidates are never trusted as-is:
 * the adapter fetches each one and the page must actually mention the company
 * name before it can appear in a report as OFFICIAL (see pageMentionsCompany).
 */
export function guessWebsiteCandidates(name: string): string[] {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !GENERIC_NAME_TOKENS.has(w));
  if (!words.length) return [];
  const first = words[0]!;
  const out = [`https://${first}.com`, `https://${first}.in`];
  if (words.length > 1) {
    const joined = words.join("");
    if (joined.length <= 30) out.push(`https://${joined}.com`);
  } else {
    out.push(`https://${first}.co.in`);
  }
  return [...new Set(out)];
}

/** True when the fetched page text/title actually mentions the company name
 * (as the full name or at least its first word of 3+ letters). A guessed
 * domain that fails this check is discarded — never presented as official. */
export function pageMentionsCompany(pageText: string, name: string): boolean {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return false;
  const hay = " " + pageText.toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  if (hay.includes(` ${words.join(" ")} `)) return true;
  const first = words[0]!;
  return first.length >= 3 && hay.includes(` ${first} `);
}

function candidateUrls(website: string | null, domain: string | null): string[] {
  const out: string[] = [];
  if (website) {
    const base = website.includes("://") ? website : `https://${website}`;
    out.push(base);
  } else if (domain) {
    out.push(`https://${domain}`);
  }
  // De-dupe, keep order.
  return [...new Set(out)];
}

export function makeOfficialAdapter(opts: OfficialAdapterOptions = {}): SourceAdapter {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const maxDocs = opts.maxDocs ?? 3;
  return {
    name: "official",
    async collect(company): Promise<SourceAdapterResult> {
      const startedAt = Date.now();
      const documents: SourceDocument[] = [];
      const errors: string[] = [];
      const knownBases = candidateUrls(company.website, company.domain);
      // No website in the database yet (every search-created company starts
      // this way): guess candidate domains from the name and verify each one
      // live. A guess is only accepted when the fetched page mentions the
      // company name, so an unrelated parked domain never becomes "official".
      const guessing = knownBases.length === 0;
      const bases = guessing ? guessWebsiteCandidates(company.name) : knownBases;
      if (!bases.length) {
        return { documents, errors: ["no-website-known"] };
      }
      const origins = new Set<string>();
      for (const base of bases) {
        if (Date.now() - startedAt > OFFICIAL_BUDGET_MS) {
          errors.push("official:time-budget");
          break;
        }
        let checked;
        try {
          checked = await checkSourceUrl(base, opts.urlOptions ?? { resolve: defaultResolve });
        } catch (err) {
          errors.push(`check-failed:${(err as Error).message}`);
          continue;
        }
        if (!checked.ok) {
          errors.push(`${base}:${checked.reason}`);
          continue;
        }
        const page = await fetchBounded(checked.url.href, fetchImpl, errors);
        if (page) {
          if (guessing && !pageMentionsCompany(`${page.title} ${page.text.slice(0, 3000)}`, company.name)) {
            errors.push(`${base}:guess-name-mismatch`);
            continue;
          }
          origins.add(checked.url.origin);
          documents.push({
            url: checked.url.href,
            title: page.title || company.name,
            publisher: company.name,
            label: "OFFICIAL",
            fetchedAt: new Date().toISOString(),
            text: page.text,
          });
          // With guesses, the first verified domain wins — do not list every
          // TLD variant as a separate "official site".
          if (guessing) break;
        }
        if (documents.length >= maxDocs) break;
      }
      // Careers pages, only on already-validated origins. Robots is fetched
      // ONCE per origin and the origin host was already DNS-checked above —
      // re-resolving and re-fetching robots per candidate path used to turn a
      // cold report into a multi-minute wait on slow resolvers.
      for (const origin of origins) {
        if (documents.length >= maxDocs) break;
        if (Date.now() - startedAt > OFFICIAL_BUDGET_MS) {
          errors.push("official:time-budget");
          break;
        }
        const robots = await fetchRobots(origin, fetchImpl);
        for (const path of CAREERS_PATHS) {
          if (documents.length >= maxDocs) break;
          if (Date.now() - startedAt > OFFICIAL_BUDGET_MS) {
            errors.push("official:time-budget");
            break;
          }
          const careersUrl = new URL(path, origin).href;
          if (robots && isPathDisallowed(new URL(careersUrl).pathname, robots.disallows)) {
            errors.push(`${careersUrl}:robots-disallowed`);
            continue;
          }
          const page = await fetchBounded(careersUrl, fetchImpl, errors);
          if (page && page.text.length > 80) {
            documents.push({
              url: careersUrl,
              title: page.title || `${company.name} careers`,
              publisher: company.name,
              label: "OFFICIAL",
              fetchedAt: new Date().toISOString(),
              text: page.text,
            });
          }
        }
      }
      return { documents, errors };
    },
  };
}

async function fetchBounded(url: string, fetchImpl: FetchLike, errors: string[]) {
  try {
    const page = await fetchPage(url, fetchImpl);
    if (page.status >= 400) {
      errors.push(`${url}:http-${page.status}`);
      return null;
    }
    return page;
  } catch (err) {
    errors.push(`${url}:fetch-failed:${(err as Error).message?.slice(0, 80)}`);
    return null;
  }
}
