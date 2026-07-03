#!/usr/bin/env node
// ============================================================
//  Grit&Gigs — apply-project-fixes.js  (v2 — fixed)
//  Run once from your swiftexchange folder:
//    node apply-project-fixes.js
// ============================================================
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

let ok = 0, fail = 0, skip = 0;

function patch(file, label, find, replace) {
  const filePath = join(ROOT, file);
  if (!existsSync(filePath)) { console.log('  ❌ ' + label + ' — file not found: ' + file); fail++; return false; }
  let src;
  try { src = readFileSync(filePath, 'utf8'); } catch(e) { console.log('  ❌ ' + label + ' — read error: ' + e.message); fail++; return false; }
  if (!src.includes(find)) {
    console.log('  ⚠️  ' + label + ' — pattern not found (may already be applied or version differs)');
    skip++;
    return false;
  }
  const updated = src.replace(find, replace);
  writeFileSync(filePath, updated, 'utf8');
  console.log('  ✅ ' + label);
  ok++;
  return true;
}

// ============================================================
//  PATCH 1-3: dist/index.mjs — Credit system for bids
// ============================================================
console.log('\n📦 Patching dist/index.mjs...');

// 1a — Credit check before inserting bid
patch(
  'dist/index.mjs',
  'Credit check before bid',
  'if (existing[0]) return res.status(400).json({ success: false, message: "Already submitted a bid" });\n    var amount = _projPositiveInt(req.body.amount);',
  'if (existing[0]) return res.status(400).json({ success: false, message: "Already submitted a bid" });\n    var _BID_FEE = 2;\n    var _walletRows = await db.select().from(freelanceWalletsTable).where(eq(freelanceWalletsTable.userId, u.id)).limit(1);\n    var _bidWallet = _walletRows[0];\n    if (!_bidWallet) {\n      try { await db.insert(freelanceWalletsTable).values({ userId: u.id, balance: 0, totalEarned: 0, totalSpent: 0, totalWithdrawn: 0 }); } catch(e) {}\n      return res.status(400).json({ success: false, message: "You need at least 2 credits to submit a proposal. Buy credits in your Wallet." });\n    }\n    if (_bidWallet.balance < _BID_FEE) return res.status(400).json({ success: false, message: "Not enough credits. You need 2 credits to submit a proposal. Buy credits in your Wallet." });\n    var amount = _projPositiveInt(req.body.amount);'
);

// 1b — Deduct wallet credits after bid is inserted
patch(
  'dist/index.mjs',
  'Deduct 2 credits after bid insert',
  'await db.insert(notificationsTable).values({ userId: project.userId, type: "PROJECT_BID_RECEIVED", title: "New project proposal", message: `A freelancer submitted a proposal for "${project.title}".`, linkUrl: "/dashboard.html#my-projects" });\n    res.status(201).json({ success: true, data: { bid: bid[0] } });',
  'await db.update(freelanceWalletsTable).set({ balance: _bidWallet.balance - _BID_FEE, totalSpent: (_bidWallet.totalSpent || 0) + _BID_FEE }).where(eq(freelanceWalletsTable.userId, u.id));\n    await db.insert(notificationsTable).values({ userId: project.userId, type: "PROJECT_BID_RECEIVED", title: "New project proposal", message: `A freelancer submitted a proposal for "${project.title}".`, linkUrl: "/dashboard.html#my-projects" });\n    res.status(201).json({ success: true, data: { bid: bid[0], creditsCost: _BID_FEE } });'
);

// 1c — Return fuller bidder profile fields in project detail
patch(
  'dist/index.mjs',
  'Fuller bidder profile in project detail',
  'var users = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, reputationScore: usersTable.reputationScore }).from(usersTable).where(eq(usersTable.id, bid.userId)).limit(1);',
  'var users = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, reputationScore: usersTable.reputationScore, skillsOffered: usersTable.skillsOffered, tagline: usersTable.tagline, city: usersTable.city, profilePhoto: usersTable.profilePhoto, portfolioLinks: usersTable.portfolioLinks }).from(usersTable).where(eq(usersTable.id, bid.userId)).limit(1);'
);

// ============================================================
//  PATCH 4-6: public/dashboard.html — UI improvements
// ============================================================
console.log('\n🎨 Patching public/dashboard.html...');

// 4 — Add "Browse Full Marketplace" button
patch(
  'public/dashboard.html',
  'Browse Full Marketplace button',
  '<h2 style="font-size:1.1rem;">Browse Projects</h2>\n        <button class="btn bp" onclick="showPage(\'post-project\')">Post a Project</button>',
  '<h2 style="font-size:1.1rem;">Browse Projects</h2>\n        <div style="display:flex;gap:8px;align-items:center;">\n          <a href="projects.html" class="btn bs btn-sm" target="_blank" style="font-size:.75rem;">🌐 Full Marketplace</a>\n          <button class="btn bp" onclick="showPage(\'post-project\')">Post a Project</button>\n        </div>'
);

// 5 — Credit cost notice in bid form + updated button text
patch(
  'public/dashboard.html',
  'Credit cost notice in bid form',
  '<button class="btn bp btn-lg" style="width:100%;justify-content:center;" onclick="submitBid(\'${p.id}\',this.closest(\'.mo\'))">📨 Submit Proposal</button>',
  '<div style="background:rgba(232,160,32,.1);border-radius:8px;padding:9px 12px;margin-bottom:10px;font-size:.76rem;color:#7A4500;display:flex;align-items:center;gap:7px;">💡 Submitting costs <strong style="margin:0 2px;">2 credits</strong>. Balance: <strong id="bidCrBal">—</strong></div>\n          <button class="btn bp btn-lg" style="width:100%;justify-content:center;" onclick="fetchBidBalance();submitBid(\'${p.id}\',this.closest(\'.mo\'))">📨 Submit Proposal (2 credits)</button>'
);

// 6 — Inject improved renderBidCard + overridden openProjectDet before </body>
const overrideFile = join(ROOT, 'dashboard-override.html');
if (!existsSync(overrideFile)) {
  console.log('  ❌ dashboard-override.html not found — skipping improved bid cards');
  fail++;
} else {
  patch(
    'public/dashboard.html',
    'Improved bid card display + fetchBidBalance',
    '</body>',
    readFileSync(overrideFile, 'utf8') + '\n</body>'
  );
}

// ============================================================
//  SUMMARY
// ============================================================
console.log('\n' + '─'.repeat(50));
console.log('✅ Applied: ' + ok + '  ⚠️  Skipped: ' + skip + '  ❌ Failed: ' + fail);
if (ok > 0) {
  console.log('\n🎉 Done! Next steps:');
  console.log('   1. Restart your server:  npm start');
  console.log('   2. Open projects.html for the new marketplace');
  console.log('   3. Bids now cost 2 credits each');
}
if (fail > 0) {
  console.log('\n⚠️  Some patches failed — check the messages above.');
}
console.log('');
