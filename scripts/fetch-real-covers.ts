import { resolve } from "node:path";
import sharp from "sharp";

const OUT = resolve(__dirname, "..", "public", "uploads", "demo-covers");
const UA = "SwiftExchangeCoverBot/1.0 (listing cover images; contact: support@gritandgigs.in)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Replacements for the four whose source titles were plainly wrong (a business
// card for sales charts, an 18th-c engraving for writing, a postage stamp for
// analytics, a 1977 computer for video reels). Commons skews archival, so these
// queries deliberately target modern/abstract subjects.
const QUERIES: Record<string, string[]> = {
  "p-sales-bi": ["bar chart graph", "pie chart statistics", "business infographic"],
  "b-copy-for-code": ["hand writing notebook", "writing hand pen paper"],
  "b-analytics-for-brand": ["infographic information", "line graph chart data"],
  "b-reels-for-sql": ["video editing", "video camera filming", "television studio"],
};

async function fetchCommons(query: string): Promise<any | null> {
  const url =
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search` +
    `&gsrsearch=${encodeURIComponent(`filetype:bitmap ${query}`)}&gsrnamespace=6&gsrlimit=15` +
    `&prop=imageinfo&iiprop=url%7Csize%7Cextmetadata&iiurlwidth=1400`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (res.status === 429 || res.status === 503) {
      await sleep(4000 * (attempt + 1));
      continue;
    }
    return res.ok ? (await res.json()) : null;
  }
  return null;
}

async function main() {
  for (const [key, queries] of Object.entries(QUERIES)) {
    let saved = false;
    for (const q of queries) {
      if (saved) break;
      await sleep(2500);
      const json = await fetchCommons(q);
      const pages: any = json?.query?.pages ?? {};
      const cands = Object.values(pages)
        .map((p: any) => ({ p, ii: p?.imageinfo?.[0] }))
        .filter(({ ii }: any) => ii?.thumburl && ii.width >= 800)
        .filter(({ ii }: any) => ii.width / (ii.height || 1) >= 1.25)
        .sort((a: any, b: any) => a.p.index - b.p.index);
      for (const { p, ii } of cands as any[]) {
        await sleep(2500);
        try {
          const img = await fetch(ii.thumburl, { headers: { "User-Agent": UA } });
          if (!img.ok) continue;
          await sharp(Buffer.from(await img.arrayBuffer()))
            .rotate()
            .resize(1200, 630, { fit: "cover", position: "attention" })
            .jpeg({ quality: 84, mozjpeg: true })
            .toFile(resolve(OUT, `${key}.jpg`));
          const lic = ii.extmetadata?.LicenseShortName?.value ?? "?";
          console.log(`OK   ${key.padEnd(21)} [${lic}] ${String(p.title).replace("File:", "").slice(0, 60)}`);
          saved = true;
          break;
        } catch {}
      }
    }
    if (!saved) console.log(`MISS ${key}`);
  }
}
main();