// Walkthrough data for /demo.
//
// IMPORTANT: every entry here is fictional and exists only to demonstrate the
// product flow. These are NOT real members, real projects or real transactions.
// Nothing in this file is written to the database or served from the live feed —
// the page is self-contained HTML.
//
// The person shapes below are not real users. Names are generic and the avatar
// seed is deterministic.
export const PEOPLE = {
  priya: { name: "Priya Raghavan", role: "Client", city: "Bengaluru", initials: "PR", hue: 268 },
  rahul: { name: "Rahul Menon", role: "Brand designer", city: "Bengaluru", initials: "RM", hue: 200 },
  meera: { name: "Meera Iyer", role: "Client", city: "Chennai", initials: "MI", hue: 330 },
  arjun: { name: "Arjun Nair", role: "Social media manager", city: "Chennai", initials: "AN", hue: 28 },
  kavya: { name: "Kavya Shetty", role: "Client", city: "Mysuru", initials: "KS", hue: 155 },
  vikram: { name: "Vikram Rao", role: "Web developer", city: "Mysuru", initials: "VR", hue: 215 },
  neha: { name: "Neha Kulkarni", role: "Client", city: "Pune", initials: "NK", hue: 300 },
  siddharth: { name: "Siddharth Rao", role: "Photographer", city: "Pune", initials: "SR", hue: 45 },
  fatima: { name: "Fatima Sheikh", role: "Client", city: "Hyderabad", initials: "FS", hue: 175 },
  dev: { name: "Dev Malhotra", role: "Video editor", city: "Hyderabad", initials: "DM", hue: 250 },
  ananya: { name: "Ananya Bose", role: "Client", city: "Kolkata", initials: "AB", hue: 12 },
  rohan: { name: "Rohan Gupta", role: "Designer", city: "Kolkata", initials: "RG", hue: 95 },
};

export const COMPLETED_PROJECTS = [
  {
    cover: "bakery-brand-identity",
    title: "Bakery rebrand with full brand identity",
    client: "priya",
    winner: "rahul",
    budget: 24000,
    bids: 7,
    days: 18,
    deliveredOn: "12 Aug 2026",
    scope: ["Logo suite", "Menu cards", "Carry-bag design", "Colour system"],
    note: "Client confirmed the work in one round of revisions. Escrow released in full.",
  },
  {
    cover: "cafe-social-media",
    title: "Cafe social media management, 3 months",
    client: "meera",
    winner: "arjun",
    budget: 36000,
    bids: 11,
    days: 9,
    deliveredOn: "28 Aug 2026",
    scope: ["12 posts/month", "Reels", "Reply handling", "Monthly report"],
    note: "Milestone released per month after approval. No disputes raised.",
  },
  {
    cover: "clinic-website",
    title: "Dental clinic website build and launch",
    client: "kavya",
    winner: "vikram",
    budget: 42000,
    bids: 9,
    days: 24,
    deliveredOn: "4 Sep 2026",
    scope: ["6 pages", "Appointment form", "Local SEO", "Hosting setup"],
    note: "Delivered two days early. Client added a second scope at quoted price.",
  },
  {
    cover: "boutique-packaging",
    title: "Boutique clothing packaging and label design",
    client: "neha",
    winner: "rohan",
    budget: 18500,
    bids: 5,
    days: 12,
    deliveredOn: "19 Sep 2026",
    scope: ["Hang tags", "Care labels", "Sizing stickers", "Thank-you card"],
    note: "Freelancer delivered print-ready files. Approved same day.",
  },
];

export const OPEN_OFFERS = [
  {
    cover: "gym-website-redesign",
    title: "Gym website redesign, looking for a freelancer",
    client: "fatima",
    budget: 18000,
    bids: 0,
    posted: "2 hours ago",
    skills: ["Web design", "UI", "Booking flow"],
    brief:
      "We run two gyms and our current site is from 2019. Need a mobile-first redesign with class booking. We have the copy ready and photos from our studio. Open to a portfolio walkthrough.",
  },
  {
    cover: "startup-brand-video",
    title: "Startup brand video, 60 seconds, local agency",
    client: "ananya",
    budget: 55000,
    bids: 0,
    posted: "Yesterday",
    skills: ["Video editing", "Motion graphics", "Sound design"],
    brief:
      "Series A company, need a 60 second brand film for our funding announcement and website hero. Raw footage and script available. Local team strongly preferred for on-site shoot coordination.",
  },
];

export const BARTERS = [
  {
    cover: "logo-for-photographer",
    title: "Logo design in exchange for a portrait session",
    by: "siddharth",
    wants: "Logo designer",
    offers: "30-minute portrait session",
    done: true,
    completedOn: "8 Jul 2026",
    swaps: 2,
    note: "Two-way barter. Both sides confirmed delivery.",
  },
  {
    cover: "website-for-accountant",
    title: "Small business website for bookkeeping help",
    by: "priya",
    wants: "Web developer",
    offers: "3 months of bookkeeping",
    done: true,
    completedOn: "22 Jul 2026",
    swaps: 3,
    note: "Match found through the barter board. Website delivered, books balanced.",
  },
  {
    cover: "packaging-for-baker",
    title: "Cookie packaging labels for baked goods advice",
    by: "fatima",
    wants: "Print designer",
    offers: "Recipe costing help for 20 products",
    done: true,
    completedOn: "3 Aug 2026",
    swaps: 2,
    note: "Labels designed and shipped. Both sides marked complete.",
  },
  {
    cover: "shoot-for-tailor",
    title: "Product photography for a tailoring service",
    by: "meera",
    wants: "Photographer",
    offers: "Discount on 3 upcoming outfits",
    done: false,
    completedOn: null,
    swaps: 1,
    note: "Swap agreed. Photographer shortlisted, shoot not scheduled yet.",
  },
];

export const GIGS = [
  {
    cover: "logo-design-fast",
    title: "Minimal logo design, 3 concepts, 48 hour delivery",
    by: "rohan",
    price: 2400,
    rating: 4.9,
    reviews: 38,
    orders: 61,
    turnaround: "48 hours",
    includes: ["3 concepts", "2 revisions", "Source files", "Transparent PNG"],
  },
  {
    cover: "resume-writing",
    title: "ATS friendly resume writing for freshers",
    by: "dev",
    price: 900,
    rating: 4.8,
    reviews: 54,
    orders: 112,
    turnaround: "3 days",
    includes: ["ATS format", "Keyword pass", "1 revision", "Cover letter"],
  },
];

/**
 * The escrow walkthrough. This mirrors the real mechanic in src/routes/projects.ts:
 * the client's wallet is debited when the bid is accepted, and the freelancer is
 * credited when payment is released after delivery.
 */
export const ESCROW_STEPS = [
  { title: "Client funds wallet", body: "Top up via UPI, card or net banking. Razorpay processes the top-up." },
  { title: "Bid accepted", body: "The bid amount is debited from the client's own wallet, in the same operation that marks the bid accepted." },
  { title: "Work delivered", body: "Freelancer submits the work. Project moves to delivered. Money stays committed." },
  { title: "Payment released", body: "Client reviews and releases. Freelancer is credited after platform commission." },
];

export const RAISED_LIMITATION =
  "Escrow protects the payment. It does not protect the files — watermarked, domain-locked previews are the fix and are not built yet.";