/**
 * Demo marketplace dataset.
 *
 * Fabricated on purpose: the people, the work and the engagement counts are all
 * invented, for building and demonstrating the UI only. Nothing here may reach
 * production - see ./guard.ts.
 *
 * Modelled on community_posts, which is what the Hustle feed actually renders.
 * Projects and barters are posts of kind PROJECT and BARTER, and "completed" is
 * expressed with status SOLD, since community post status is ACTIVE | CLOSED |
 * SOLD rather than the projects-table COMPLETED.
 */

export type DemoKind = "PROJECT" | "BARTER";
export type DemoStatus = "ACTIVE" | "SOLD";

export interface DemoPerson {
  key: string;
  firstName: string;
  lastName: string;
  tagline: string;
  bio: string;
  city: string;
  skillsOffered: string[];
  skillsNeeded: string[];
  /** Deterministic avatar seed, rendered locally by the client. */
  avatarSeed: string;
}

export interface DemoListingInput {
  key: string;
  ownerKey: string;
  kind: DemoKind;
  status: DemoStatus;
  content: string;
  tags: string[];
  priceInr?: number;
  wantInr?: number;
  wantText?: string;
  deliveryDays?: number;
  location: string;
  isRemote: boolean;
  likeCount: number;
  commentCount: number;
  daysAgo: number;
}

export type DemoListing = DemoListingInput & { coverImage: string };

export const DEMO_PEOPLE: DemoPerson[] = [
  {
    key: "ananya",
    firstName: "Ananya",
    lastName: "Rao",
    tagline: "Brand designer taking on 2 projects this month",
    bio: "Six years in brand identity, mostly D2C packaging and brand kits. I work in Figma and hand over organised, editable files.",
    city: "Bengaluru",
    skillsOffered: ["Brand identity", "Figma", "Packaging design", "Logo design"],
    skillsNeeded: ["Web development", "Copywriting"],
    avatarSeed: "ananya-rao",
  },
  {
    key: "irfan",
    firstName: "Irfan",
    lastName: "Sheikh",
    tagline: "Full-stack developer, Node and React",
    bio: "I build dashboards and internal tools. Comfortable owning a feature end to end, from schema to the screen the client actually uses.",
    city: "Hyderabad",
    skillsOffered: ["Node.js", "React", "PostgreSQL", "API design"],
    skillsNeeded: ["UI design", "Technical writing"],
    avatarSeed: "irfan-sheikh",
  },
  {
    key: "meher",
    firstName: "Meher",
    lastName: "Kapoor",
    tagline: "Content writer for fintech and SaaS",
    bio: "I write landing pages, onboarding emails and help-centre articles. I ask a lot of questions before I write anything.",
    city: "Mumbai",
    skillsOffered: ["Copywriting", "Content strategy", "SEO writing"],
    skillsNeeded: ["Video editing", "Illustration"],
    avatarSeed: "meher-kapoor",
  },
  {
    key: "devansh",
    firstName: "Devansh",
    lastName: "Nair",
    tagline: "Data analyst, Excel and Power BI",
    bio: "I turn messy spreadsheets into dashboards people actually open. Comfortable cleaning data as part of the job.",
    city: "Kochi",
    skillsOffered: ["Excel", "Power BI", "Data cleaning", "Dashboards"],
    skillsNeeded: ["Frontend development", "Illustration"],
    avatarSeed: "devansh-nair",
  },
  {
    key: "priya",
    firstName: "Priya",
    lastName: "Menon",
    tagline: "Social media manager for local businesses",
    bio: "I run Instagram and WhatsApp channels for restaurants and clinics. Reporting monthly, no vanity metrics.",
    city: "Pune",
    skillsOffered: ["Social media", "Content calendar", "Reels editing"],
    skillsNeeded: ["Web development", "SEO"],
    avatarSeed: "priya-menon",
  },
  {
    key: "arjun",
    firstName: "Arjun",
    lastName: "Verma",
    tagline: "Flutter developer, Android and iOS",
    bio: "Shipped four production apps. I work in small increments with a demo at the end of every week.",
    city: "Jaipur",
    skillsOffered: ["Flutter", "Dart", "Android", "iOS"],
    skillsNeeded: ["Brand identity", "Copywriting"],
    avatarSeed: "arjun-verma",
  },
];

const RAW_LISTINGS: DemoListingInput[] = [
  {
    key: "p-brand-kit",
    ownerKey: "ananya",
    kind: "PROJECT",
    status: "SOLD",
    content:
      "Brand identity for afilter-free skincare startup: logo, two colour palettes, packaging mockups and a small usage guide. Delivered as editable Figma files plus exported PNG and SVG. Three revisions included, 9 day turnaround.",
    tags: ["design", "branding", "figma"],
    priceInr: 18000,
    deliveryDays: 9,
    location: "Bengaluru",
    isRemote: true,
    likeCount: 318,
    commentCount: 44,
    daysAgo: 8,
  },
  {
    key: "p-ops-dashboard",
    ownerKey: "irfan",
    kind: "PROJECT",
    status: "SOLD",
    content:
      "Internal operations dashboard for a logistics team: order tracking, agent assignment and a daily revenue summary. Node and Postgres behind it, React front end. I wrote the schema and the seed script so their team can run it locally without me.",
    tags: ["react", "node", "postgres", "dashboard"],
    priceInr: 32000,
    deliveryDays: 18,
    location: "Hyderabad",
    isRemote: true,
    likeCount: 274,
    commentCount: 31,
    daysAgo: 7,
  },
  {
    key: "p-onboarding-copy",
    ownerKey: "meher",
    kind: "PROJECT",
    status: "SOLD",
    content:
      "Onboarding and help-centre copy for a payroll SaaS: 14 help articles, 9 email sequences and a rewrite of the signup flow. I recorded a short Loom per article so their support team can edit without coming back to me.",
    tags: ["copywriting", "saas", "content"],
    priceInr: 14000,
    deliveryDays: 12,
    location: "Mumbai",
    isRemote: true,
    likeCount: 156,
    commentCount: 22,
    daysAgo: 6,
  },
  {
    key: "p-sales-bi",
    ownerKey: "devansh",
    kind: "PROJECT",
    status: "SOLD",
    content:
      "Sales dashboard for a D2C brand: revenue by channel, cohort retention and a weekly summary that goes out on Monday morning. Their export was three years of inconsistent spreadsheets, so cleaning was most of the work.",
    tags: ["powerbi", "excel", "analytics"],
    priceInr: 22000,
    deliveryDays: 14,
    location: "Kochi",
    isRemote: true,
    likeCount: 203,
    commentCount: 28,
    daysAgo: 5,
  },
  {
    key: "p-clinic-social",
    ownerKey: "priya",
    kind: "PROJECT",
    status: "ACTIVE",
    content:
      "Looking for someone to run Instagram and WhatsApp for a dermatology clinic in Baner. Roughly 12 posts a month, mostly before-and-after with consent forms. Budget is monthly, not per post, and I want a simple monthly report.",
    tags: ["social media", "reels", "local business"],
    priceInr: 12000,
    deliveryDays: 30,
    location: "Pune",
    isRemote: true,
    likeCount: 9,
    commentCount: 4,
    daysAgo: 4,
  },
  {
    key: "p-booking-app",
    ownerKey: "arjun",
    kind: "PROJECT",
    status: "ACTIVE",
    content:
      "Flutter app for a chain of three dental clinics: booking, reminders and a basic loyalty card. Designs are ready in Figma, I only need the build. Weekly demo so we can course-correct early.",
    tags: ["flutter", "mobile", "booking"],
    priceInr: 45000,
    deliveryDays: 35,
    location: "Jaipur",
    isRemote: true,
    likeCount: 14,
    commentCount: 6,
    daysAgo: 0,
  },
  {
    key: "b-logo-for-site",
    ownerKey: "ananya",
    kind: "BARTER",
    status: "SOLD",
    content:
      "I will design a logo and one-page brand treatment for anyone who can build or fix a small business website. I need the site more than the logo, honestly. Two rounds of revisions, files handed over in Figma and SVG.",
    tags: ["barter", "design", "web"],
    wantText: "A small business website, built or repaired",
    wantInr: 6000,
    deliveryDays: 7,
    location: "Bengaluru",
    isRemote: true,
    likeCount: 187,
    commentCount: 35,
    daysAgo: 4,
  },
  {
    key: "b-copy-for-code",
    ownerKey: "irfan",
    kind: "BARTER",
    status: "SOLD",
    content:
      "Looking to trade React work for writing help. I will build a landing page or fix a bug in an existing React app; in return I need the copy written and edited, because I keep shipping placeholder text. My own site is a good candidate.",
    tags: ["barter", "react", "copywriting"],
    wantText: "Landing page copy and editing",
    wantInr: 5000,
    deliveryDays: 6,
    location: "Hyderabad",
    isRemote: true,
    likeCount: 141,
    commentCount: 26,
    daysAgo: 3,
  },
  {
    key: "b-analytics-for-brand",
    ownerKey: "devansh",
    kind: "BARTER",
    status: "SOLD",
    content:
      "I will set up a clean Excel and Power BI dashboard for a small business in exchange for brand identity work. I am specifically looking for a logo and colour palette, since I keep defaulting to Excel blue.",
    tags: ["barter", "analytics", "branding"],
    wantText: "Logo and colour palette",
    wantInr: 7000,
    deliveryDays: 8,
    location: "Kochi",
    isRemote: true,
    likeCount: 128,
    commentCount: 21,
    daysAgo: 2,
  },
  {
    key: "b-reels-for-sql",
    ownerKey: "priya",
    kind: "BARTER",
    status: "SOLD",
    content:
      "Offering 15 edited reels for anyone who can teach me SQL properly. I have copied queries from stack overflow for two years and still cannot write a join from memory. Remote sessions, twice a week, an hour each.",
    tags: ["barter", "video", "sql"],
    wantText: "SQL coaching, two sessions a week",
    wantInr: 8000,
    deliveryDays: 10,
    location: "Pune",
    isRemote: true,
    likeCount: 164,
    commentCount: 29,
    daysAgo: 1,
  },
];

/**
 * Cover paths are derived from the key rather than written out per listing.
 * The generator names files after the key too, so the two cannot drift - which
 * they did once, leaving four covers on disk that nothing referenced.
 */
export const DEMO_LISTINGS: DemoListing[] = RAW_LISTINGS.map((l) => ({
  ...l,
  coverImage: `/uploads/demo-covers/${l.key}.jpg`,
}));
export const personByKey = (key: string): DemoPerson => {
  const p = DEMO_PEOPLE.find((x) => x.key === key);
  if (!p) throw new Error(`demo dataset references unknown person "${key}"`);
  return p;
};

export const listingByKey = (key: string): DemoListing => {
  const l = DEMO_LISTINGS.find((x) => x.key === key);
  if (!l) throw new Error(`demo dataset references unknown listing "${key}"`);
  return l;
};

/** Fixed clock so snapshots and assertions are stable. */
export const DEMO_EPOCH = new Date("2026-01-15T12:00:00.000Z");

export function createdAtFor(listing: DemoListing, base: Date = DEMO_EPOCH): Date {
  return new Date(base.getTime() - listing.daysAgo * 86_400_000);
}