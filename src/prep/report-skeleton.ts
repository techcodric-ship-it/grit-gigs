// Pure, deterministic report skeleton builder — no DB, no network, no AI.
// Every section item traces to a SourceDocument in provenance.

import type { PrepCompany } from "./schema";
import type { SourceDocument } from "./sources/types";
import type { GatheredSources } from "./sources/gather";
import { roleSkills } from "./role-skills";

export interface ReportItem {
  title: string;
  url?: string;
  publisher?: string;
  publishedAt?: string;
  label: SourceDocument["label"];
  text?: string;
}

export interface ReportSkeleton {
  overview: {
    name: string;
    slug: string;
    domain: string | null;
    website: string | null;
    status: string;
  };
  role: string | null;
  userType: string | null;
  // Guidance, not sourced claims: the skills a candidate for this searched
  // role is usually judged on (pure role profile, see role-skills.ts).
  roleBrief: {
    role: string | null;
    skills: string[];
    note: string;
  };
  officialSites: ReportItem[];
  careers: ReportItem[];
  recentNews: ReportItem[];
  provenance: {
    url: string;
    title: string;
    publisher: string;
    label: SourceDocument["label"];
    fetchedAt: string;
    publishedAt?: string;
  }[];
  disclaimers: string[];
  sourceCount: number;
  generatedAt: string;
}

const CAREERS_RE = /careers|jobs|join-us|life-at|work-with-us|hiring/i;

function toItem(doc: SourceDocument): ReportItem {
  return {
    title: doc.title,
    url: doc.url,
    publisher: doc.publisher,
    publishedAt: doc.publishedAt,
    label: doc.label,
    text: doc.text.slice(0, 400),
  };
}

/** Build the deterministic, fully-sourced report skeleton. Pure — unit tested. */
export function buildReportSkeleton(
  company: Pick<PrepCompany, "name" | "slug" | "domain" | "website" | "status">,
  gathered: GatheredSources,
  meta: { role?: string | null; userType?: string | null } = {},
): ReportSkeleton {
  const officialDocs = gathered.documents.filter((d) => d.label === "OFFICIAL");
  const careers = officialDocs.filter((d) => CAREERS_RE.test(d.url) || CAREERS_RE.test(d.title));
  const officialSites = officialDocs.filter((d) => !careers.includes(d));
  const recentNews = gathered.documents
    .filter((d) => d.label === "NEWS")
    .sort((a, b) => (b.publishedAt ?? b.fetchedAt).localeCompare(a.publishedAt ?? a.fetchedAt))
    .slice(0, 8);

  return {
    overview: {
      name: company.name,
      slug: company.slug,
      domain: company.domain,
      website: company.website,
      status: company.status,
    },
    role: meta.role?.slice(0, 120) ?? null,
    userType: meta.userType?.slice(0, 40) ?? null,
    roleBrief: {
      role: meta.role?.slice(0, 120) ?? null,
      skills: roleSkills(meta.role ?? ""),
      note: "Curated from common hiring patterns for this role - always cross-check the actual job description before you prepare.",
    },
    officialSites: officialSites.map(toItem),
    careers: careers.map(toItem),
    recentNews: recentNews.map(toItem),
    provenance: gathered.documents.map((d) => ({
      url: d.url,
      title: d.title,
      publisher: d.publisher,
      label: d.label,
      fetchedAt: d.fetchedAt,
      publishedAt: d.publishedAt,
    })),
    disclaimers: [
      "This report summarizes the sources listed below. Every claim should be re-verified at the original link.",
      "Grit&Gigs does not verify employer claims independently and does not label any company fraudulent.",
      "This is not legal, financial, or career advice.",
    ],
    sourceCount: gathered.documents.length,
    generatedAt: new Date().toISOString(),
  };
}
