// Bounded HTTP fetching for source adapters: timeout, byte cap, HTML->text
// stripping. Uses the global fetch (Node 18+); tests inject a stub.

export const FETCH_TIMEOUT_MS = 8000;
export const MAX_BYTES = 500_000; // 500 KB per document
export const MAX_TEXT_CHARS = 20_000; // chars handed to the model

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string>; redirect?: "follow" | "error" | "manual" },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export const SOURCE_UA = "GritAndGigs-PrepBot/1.0 (+https://www.gritandgigs.in)";

export interface FetchedPage {
  url: string; // final URL after redirects
  status: number;
  contentType: string;
  text: string; // bounded plain text
  title: string;
}

/** Strip tags/scripts and collapse whitespace. Not a parser — bounded input only. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
  return s.replace(/\s+/g, " ").trim();
}

export function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m || !m[1]) return "";
  return htmlToText(m[1]).slice(0, 300);
}

export async function fetchPage(
  rawUrl: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<FetchedPage> {
  const res = await fetchImpl(rawUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "user-agent": SOURCE_UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8",
    },
    redirect: "follow",
  });
  const contentType = res.headers.get("content-type") ?? "";
  const buf = await res.arrayBuffer();
  const bytes = buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf;
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const isHtml = contentType.includes("html") || /^\s*<!doctype html|<html/i.test(raw);
  const text = isHtml ? htmlToText(raw) : raw.replace(/\s+/g, " ").trim();
  return {
    url: rawUrl,
    status: res.status,
    contentType,
    text: text.slice(0, MAX_TEXT_CHARS),
    title: isHtml ? extractTitle(raw) : "",
  };
}
