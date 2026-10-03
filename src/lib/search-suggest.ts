/**
 * Matching rules for the nav search typeahead.
 *
 * Kept separate from the route so the behaviour that matters can be unit
 * tested without a database, and so the client and server agree on what a
 * partial query means.
 */

/**
 * Escapes the LIKE metacharacters so a search for "100%" or "a_b" looks for
 * that literal text.
 *
 * Without this, "%" matches every row and "_" matches any single character, so
 * typing one percent sign silently returns the entire feed.
 */
export function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/**
 * How well a candidate term answers what was typed. Lower sorts first.
 *
 * Ranking matters more than raw matching: typing "web" against a term list
 * containing "web design", "website" and "responsive web" should surface the
 * ones that start with "web" first, not whichever row the database returned.
 * An exact match outranks everything, even a more popular longer term,
 * because someone who typed "web" and sees "website" has not been answered yet.
 */
export function suggestRank(term: string, q: string): number {
  const t = term.toLowerCase().trim();
  const needle = q.toLowerCase().trim();
  if (!needle) return 4;
  if (t === needle) return 0;
  if (t.startsWith(needle)) return 1;
  // Start of a word: "web" in "web development" but not in "network".
  const wordStart = new RegExp(`(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  if (wordStart.test(t)) return 2;
  if (t.indexOf(needle) > -1) return 3;
  return 4;
}

/** Terms that do not match the query at all, for filtering a raw candidate list. */
export function matchesTerm(term: string, q: string): boolean {
  return term.toLowerCase().indexOf(q.toLowerCase()) > -1;
}

/**
 * Orders suggestions for display: best rank first, then most used, then
 * shortest so "web" beats "web development services" at equal rank.
 */
export function rankTerms(rows: { term: string; n: number }[], q: string, limit = 6): string[] {
  return rows
    .filter((r) => matchesTerm(r.term, q))
    .filter((r, i, arr) => arr.findIndex((o) => o.term === r.term) === i)
    .sort(
      (a, b) =>
        suggestRank(a.term, q) - suggestRank(b.term, q) ||
        b.n - a.n ||
        a.term.length - b.term.length,
    )
    .slice(0, limit)
    .map((r) => r.term);
}