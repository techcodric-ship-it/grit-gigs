// Official-site adapter: fetches the company's own website and careers page
// (label OFFICIAL). Every URL goes through the SSRF/denylist/robots checks.

import { checkSourceUrl, defaultResolve, fetchRobots, isPathDisallowed, type UrlCheckOptions } from "./urls";
import { defaultFetch, fetchPage, type FetchLike } from "./fetcher";
import type { SourceAdapter, SourceAdapterResult, SourceDocument } from "./types";

export const CAREERS_PATHS = ["/careers", "/careers/", "/jobs", "/join-us", "/life-at-us"];

export interface OfficialAdapterOptions {
  fetchImpl?: FetchLike;
  urlOptions?: UrlCheckOptions;
  maxDocs?: number;
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
      const documents: SourceDocument[] = [];
      const errors: string[] = [];
      const bases = candidateUrls(company.website, company.domain);
      if (!bases.length) {
        return { documents, errors: ["no-website-known"] };
      }
      const origins = new Set<string>();
      for (const base of bases) {
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
        origins.add(checked.url.origin);
        const page = await fetchBounded(checked.url.href, fetchImpl, errors);
        if (page) {
          documents.push({
            url: checked.url.href,
            title: page.title || company.name,
            publisher: company.name,
            label: "OFFICIAL",
            fetchedAt: new Date().toISOString(),
            text: page.text,
          });
        }
        if (documents.length >= maxDocs) break;
      }
      // Careers pages, only on already-validated origins.
      for (const origin of origins) {
        if (documents.length >= maxDocs) break;
        for (const path of CAREERS_PATHS) {
          if (documents.length >= maxDocs) break;
          const careersUrl = new URL(path, origin).href;
          const checked = await checkSourceUrl(careersUrl, opts.urlOptions ?? { resolve: defaultResolve });
          if (!checked.ok) {
            errors.push(`${careersUrl}:${checked.reason}`);
            continue;
          }
          const robots = await fetchRobots(origin, fetchImpl);
          if (robots && isPathDisallowed(checked.url.pathname, robots.disallows)) {
            errors.push(`${careersUrl}:robots-disallowed`);
            continue;
          }
          const page = await fetchBounded(checked.url.href, fetchImpl, errors);
          if (page && page.text.length > 80) {
            documents.push({
              url: checked.url.href,
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
