import "dotenv/config";
import { db, usersTable, communityPostsTable } from "../src/db";

// ── Seed the Hustle Feed with starter community content ──────────────────
// Usage: tsx scripts/seed-community.ts  (safe to re-run — skips if posts exist)

const SEED_POSTS: {
  text: string;
  kind: "POST" | "GIG" | "BARTER" | "WIN" | "TIPS";
  tags: string[];
  priceInr?: number;
  deliveryDays?: number;
  location?: string;
  hoursAgo: number;
  likes: number;
  comments: number;
}[] = [
  {
    text: "Just closed my first ₹15,000 freelance logo project. 3 days of work, 1 happy client. If I can do it from my hostel room, so can you.",
    kind: "WIN",
    tags: ["freelancing", "design"],
    location: "Mumbai",
    hoursAgo: 2,
    likes: 214,
    comments: 38,
  },
  {
    text: "Logo + full brand kit for small businesses. 3 revisions, PNG + SVG + social media pack. DM to order.",
    kind: "GIG",
    tags: ["design", "branding"],
    priceInr: 1499,
    deliveryDays: 4,
    location: "Delhi",
    hoursAgo: 5,
    likes: 89,
    comments: 14,
  },
  {
    text: "I can teach spoken English + interview prep if you teach me Excel + Google Sheets for my gig work. 2 sessions, fully remote.",
    kind: "BARTER",
    tags: ["barter", "skills"],
    location: "Remote",
    hoursAgo: 9,
    likes: 156,
    comments: 27,
  },
  {
    text: "Biggest lesson after 6 months of gig work: never send your deliverable before payment. Escrow or upfront 50%. Saved me from 3 deadbeat clients already.",
    kind: "TIPS",
    tags: ["tips", "gigwork", "money"],
    location: "Hyderabad",
    hoursAgo: 24,
    likes: 342,
    comments: 55,
  },
  {
    text: "Cleared a full day of gig deliveries this week. ₹2,100 in one day. Not much, but it is mine. Building steady.",
    kind: "WIN",
    tags: ["grind", "firstearn"],
    location: "Bengaluru",
    hoursAgo: 26,
    likes: 187,
    comments: 23,
  },
  {
    text: "Content writing for websites + Instagram. ₹999 per blog post, SEO friendly, unlimited small edits. 3 days delivery.",
    kind: "GIG",
    tags: ["content", "writing"],
    priceInr: 999,
    deliveryDays: 3,
    location: "Remote",
    hoursAgo: 48,
    likes: 64,
    comments: 11,
  },
  {
    text: "Took a small loan to buy a second-hand laptop just for gig work. 2 months later, it has already paid itself off. Invest in your own hustle first.",
    kind: "POST",
    tags: ["hustle", "growth"],
    location: "Chennai",
    hoursAgo: 50,
    likes: 421,
    comments: 66,
  },
];

async function seed() {
  const existing = await db.select({ id: communityPostsTable.id }).from(communityPostsTable).limit(1);
  if (existing.length) {
    console.log("Community posts already exist — skipping seed.");
    return;
  }

  const users = await db
    .select({ id: usersTable.id, city: usersTable.city })
    .from(usersTable)
    .orderBy(usersTable.createdAt)
    .limit(8);
  if (!users.length) {
    console.error("No users found — cannot attribute seed posts.");
    process.exit(1);
  }

  let inserted = 0;
  for (let i = 0; i < SEED_POSTS.length; i++) {
    const s = SEED_POSTS[i];
    const author = users[i % users.length];
    const post = await db
      .insert(communityPostsTable)
      .values({
        userId: author.id,
        kind: s.kind,
        content: s.text,
        tags: s.tags,
        priceInr: s.priceInr ?? null,
        deliveryDays: s.deliveryDays ?? null,
        location: s.location ?? author.city ?? null,
        isRemote: true,
        likeCount: s.likes,
        commentCount: s.comments,
        createdAt: new Date(Date.now() - s.hoursAgo * 3600 * 1000),
      })
      .returning({ id: communityPostsTable.id });
    if (post[0]) inserted++;
    console.log(`✓ ${s.kind} · ${s.tags[0] ?? ""} · ${s.likes} likes`);
  }
  console.log(`Seeded ${inserted} posts.`);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});