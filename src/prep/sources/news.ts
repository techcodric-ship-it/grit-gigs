// News adapter: Google News RSS (news.google.com/rss/search) — free, no API
// key, and not on the scraping denylist. Items carry publisher + date so every
// claim can be cited. Bounded to a handful of recent items.

import { checkSourceUrl, defaultResolve, type UrlCheckOptions } from "./urls";
import { defaultFetch, fetchPage, type FetchLike } from "./fetcher";
import type { SourceAdapter, SourceAdapterResult, SourceDocument } from "./types";

export const MAX_NEWS_ITEMS = 5;

export interface NewsItem {
  title: string;
  url: string;
  publishedAt?: string;
  sourceName: string;
}

/** Parse a Google News RSS 2.0 document into bounded items. Regex parse — input is bounded XML. */
export function parseNewsRss(xml: string, limit = MAX_NEWS_ITEMS): NewsItem[] {
  const items: NewsItem[] = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const m of itemMatches) {
    if (items.length >= limit) break;
    const block = m[1] ?? "";
    const title = decodeXml(firstTag(block, "title"));
    const url = decodeXml(firstTag(block, "link"));
    const pubDate = firstTag(block, "pubDate");
    // <source url="...">Name</source>
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    const sourceName = sourceMatch ? decodeXml(sourceMatch[1] ?? "") : "Google News";
    // Defence in depth: only http(s) links ever reach provenance/href sinks.
    if (!title || !url || !/^https?:\/\//i.test(url)) continue;
    items.push({
      title: title.slice(0, 300),
      url: url.slice(0, 2000),
      publishedAt: toIsoDate(pubDate),
      sourceName: sourceName.slice(0, 120) || "Google News",
    });
  }
  return items;
}

/** ISO date or undefined — never throws on hostile/garbage pubDate values. */
function toIsoDate(pubDate: string): string | undefined {
  if (!pubDate) return undefined;
  const t = new Date(pubDate).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function firstTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return (m?.[1] ?? "").trim();
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export function newsSearchUrl(query: string): string {
  const q = `${query} company`.slice(0, 200);
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
}

export interface NewsAdapterOptions {
  fetchImpl?: FetchLike;
  urlOptions?: UrlCheckOptions;
  limit?: number;
}

export function makeNewsAdapter(opts: NewsAdapterOptions = {}): SourceAdapter {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const limit = opts.limit ?? MAX_NEWS_ITEMS;
  return {
    name: "news",
    async collect(company): Promise<SourceAdapterResult> {
      const documents: SourceDocument[] = [];
      const errors: string[] = [];
      const searchUrl = newsSearchUrl(company.name);
      // The RSS host is fixed and public; still route through the checker so
      // protocol and denylist rules apply uniformly.
      const checked = await checkSourceUrl(searchUrl, opts.urlOptions ?? { resolve: defaultResolve });
      if (!checked.ok) {
        errors.push(`${searchUrl}:${checked.reason}`);
        return { documents, errors };
      }
      let xml: string;
      try {
        const page = await fetchPage(checked.url.href, fetchImpl);
        if (page.status >= 400) {
          errors.push(`${checked.url.href}:http-${page.status}`);
          return { documents, errors };
        }
        xml = page.text;
      } catch (err) {
        errors.push(`news-fetch-failed:${(err as Error).message?.slice(0, 80)}`);
        return { documents, errors };
      }
      const items = parseNewsRss(xml, limit);
      const now = new Date().toISOString();
      for (const item of items) {
        const itemChecked = await checkSourceUrl(item.url, opts.urlOptions ?? { resolve: defaultResolve });
        if (!itemChecked.ok) {
          errors.push(`news-item:${item.url}:${itemChecked.reason}`);
          continue;
        }
        documents.push({
          url: item.url,
          title: item.title,
          publisher: item.sourceName,
          label: "NEWS",
          fetchedAt: now,
          publishedAt: item.publishedAt,
          text: item.title, // headline is the bounded text; full articles are not scraped
        });
      }
      return { documents, errors };
    },
  };
}
