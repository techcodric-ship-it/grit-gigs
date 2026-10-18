// Source adapter contracts for Prep. Every fact shown in a company report
// must trace back to a SourceDocument with a publisher, URL and source label.
// Raw text here; summarization happens later in PrepAiService (Phase 4) with
// post-processing that refuses unsourced claims.

export type SourceLabel =
  | "OFFICIAL" // company-owned site/page
  | "NEWS" // press or news article
  | "MEMBER_REPORTED" // user-submitted report
  | "VERIFIED_DOCUMENT" // uploaded, reviewed evidence
  | "AI_ESTIMATE"; // model output — never raw source text

export interface SourceDocument {
  url: string;
  title: string;
  publisher: string;
  label: SourceLabel;
  fetchedAt: string; // ISO timestamp
  publishedAt?: string; // ISO timestamp when the source exposes one
  text: string; // bounded plain text extracted for the model
}

export interface SourceAdapterResult {
  documents: SourceDocument[];
  errors: string[]; // adapter-level failures; never abort the whole pipeline
}

export interface SourceAdapter {
  name: string;
  collect(company: { name: string; domain: string | null; website: string | null }): Promise<SourceAdapterResult>;
}
