import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc, count, sql, inArray, type SQL } from "drizzle-orm";
import { db, usersTable, communityPostsTable, communityLikesTable, communityCommentsTable, communityFollowsTable } from "../db";
import { authenticate, optionalAuth } from "../middlewares/authenticate";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function kindWhitelist(kind: string | undefined, fallback: string): string {
  const allowed = ["POST", "GIG", "BARTER", "WIN", "TIPS"];
  if (kind && allowed.includes(kind)) return kind;
  return fallback;
}

function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => String(t).trim().replace(/^#/, "").slice(0, 30))
    .filter(Boolean)
    .slice(0, 5);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function avatarUrl(user: { profilePhoto?: string | null; email?: string | null }): string {
  if (user.profilePhoto) return user.profilePhoto;
  const email = user.email || "grit@gritandgigs.in";
  return `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(email)}&backgroundColor=ff5c1a,c8f522,0e0e0c&bold=true`;
}

interface PostRowShape {
  post: typeof communityPostsTable.$inferSelect;
  author: {
    id: string;
    firstName: string;
    lastName: string;
    profilePhoto: string | null;
    email: string | null;
    city: string | null;
    reputationScore: number;
  };
  likedByMe: boolean;
  followingAuthor: boolean;
  comments: {
    id: string;
    content: string;
    createdAt: Date;
    author: { id: string; firstName: string; lastName: string; profilePhoto: string | null };
  }[];
}

async function loadCommentCounts(postIds: string[]): Promise<Record<string, { count: number; rows: (typeof communityCommentsTable.$inferSelect)[] }>> {
  if (!postIds.length) return {};
  const comments = await db
    .select()
    .from(communityCommentsTable)
    .where(inArray(communityCommentsTable.postId, postIds))
    .orderBy(desc(communityCommentsTable.createdAt));
  const map: Record<string, { count: number; rows: (typeof communityCommentsTable.$inferSelect)[] }> = {};
  for (const c of comments) {
    if (!map[c.postId]) map[c.postId] = { count: 0, rows: [] };
    map[c.postId].count += 1;
    map[c.postId].rows.push(c);
  }
  return map;
}

async function loadLikedSet(userId: string | undefined, postIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!userId || !postIds.length) return out;
  const likes = await db
    .select({ postId: communityLikesTable.postId })
    .from(communityLikesTable)
    .where(and(eq(communityLikesTable.userId, userId), inArray(communityLikesTable.postId, postIds)));
  for (const l of likes) out.add(l.postId);
  return out;
}

async function loadFollowingSet(userId: string | undefined, authorIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!userId || !authorIds.length) return out;
  const follows = await db
    .select({ followingId: communityFollowsTable.followingId })
    .from(communityFollowsTable)
    .where(and(eq(communityFollowsTable.followerId, userId), inArray(communityFollowsTable.followingId, authorIds)));
  for (const f of follows) out.add(f.followingId);
  return out;
}

async function loadCommentAuthors(commentRows: (typeof communityCommentsTable.$inferSelect)[], postIds: string[]): Promise<Record<string, { id: string; firstName: string; lastName: string; profilePhoto: string | null }[]>> {
  const map: Record<string, { id: string; firstName: string; lastName: string; profilePhoto: string | null }[]> = {};
  for (const postId of postIds) map[postId] = [];
  if (!commentRows.length) return map;
  const userIds = [...new Set(commentRows.map((c) => c.userId))];
  let authors: { id: string; firstName: string; lastName: string; profilePhoto: string | null }[] = [];
  if (userIds.length) {
    authors = await db
      .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto })
      .from(usersTable)
      .where(inArray(usersTable.id, userIds));
  }
  const byId = new Map(authors.map((a) => [a.id, a]));
  for (const c of commentRows) {
    const a = byId.get(c.userId);
    if (a) map[c.postId]?.push({ ...a, id: c.userId });
  }
  return map;
}

async function renderPosts(rawPosts: typeof communityPostsTable.$inferSelect[], currentUserId: string | undefined, limitComments = 2): Promise<PostRowShape[]> {
  const postIds = rawPosts.map((p) => p.id);
  const authorIds = [...new Set(rawPosts.map((p) => p.userId))];

  let authors: { id: string; firstName: string; lastName: string; profilePhoto: string | null; email: string | null; city: string | null; reputationScore: number }[] = [];
  if (authorIds.length) {
    authors = await db
      .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, email: usersTable.email, city: usersTable.city, reputationScore: usersTable.reputationScore })
      .from(usersTable)
      .where(inArray(usersTable.id, authorIds));
  }
  const authorById = new Map(authors.map((a) => [a.id, a]));

  const commentData = await loadCommentCounts(postIds);
  const commentAuthorMap = await loadCommentAuthors(
    postIds.flatMap((id) => commentData[id]?.rows ?? []),
    postIds,
  );
  const likedSet = await loadLikedSet(currentUserId, postIds);
  const followingSet = await loadFollowingSet(currentUserId, authorIds);

  return rawPosts.map((post) => {
    const author = authorById.get(post.userId) ?? {
      id: post.userId,
      firstName: "Hustler",
      lastName: "",
      profilePhoto: null,
      email: null,
      city: null,
      reputationScore: 0,
    };
    const allComments = commentData[post.id]?.rows ?? [];
    const authorsForPost = commentAuthorMap[post.id] ?? [];
    const comments = allComments.slice(0, limitComments).map((c, i) => {
      const a = authorsForPost[i] ?? { id: c.userId, firstName: "Hustler", lastName: "", profilePhoto: null };
      return { id: c.id, content: c.content, createdAt: c.createdAt, author: a };
    });
    return {
      post,
      author,
      likedByMe: likedSet.has(post.id),
      followingAuthor: followingSet.has(post.userId),
      comments,
    };
  });
}

// â”€â”€ GET /community/feed?kind=&filter=&cursor= â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get("/community/feed", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const meId = req.user?.id;
  const kind = kindWhitelist(String(req.query.kind || ""), "");
  const filter = String(req.query.filter || "for-you"); // for-you | following | local | top
  const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 20));

  let where: SQL | undefined;
  if (kind) where = eq(communityPostsTable.kind, kind as typeof communityPostsTable.$inferSelect.kind);

  let basePosts: (typeof communityPostsTable.$inferSelect)[];

  if (filter === "following" && meId) {
    const follows = await db
      .select({ followingId: communityFollowsTable.followingId })
      .from(communityFollowsTable)
      .where(eq(communityFollowsTable.followerId, meId));
    const ids = follows.map((f) => f.followingId);
    const followWhere: SQL | undefined = ids.length
      ? inArray(communityPostsTable.userId, ids)
      : sql`FALSE`;
    basePosts = await db
      .select()
      .from(communityPostsTable)
      .where(where ? and(where, followWhere) : followWhere)
      .orderBy(desc(communityPostsTable.createdAt))
      .limit(limit);
  } else if (filter === "local" && meId) {
    const [me] = await db
      .select({ city: usersTable.city })
      .from(usersTable)
      .where(eq(usersTable.id, meId))
      .limit(1);
    const city = me?.city || null;
    const localWhere: SQL = city
      ? sql`(${communityPostsTable.userId} = ANY((SELECT ARRAY_AGG(users.id) FROM users WHERE users.city = ${city})))`
      : sql`TRUE`;
    basePosts = await db
      .select()
      .from(communityPostsTable)
      .where(where ? and(where, localWhere) : localWhere)
      .orderBy(desc(communityPostsTable.createdAt))
      .limit(limit);
  } else if (filter === "top") {
    basePosts = await db
      .select()
      .from(communityPostsTable)
      .where(where)
      .orderBy(desc(communityPostsTable.likeCount), desc(communityPostsTable.createdAt))
      .limit(limit);
  } else {
    basePosts = await db
      .select()
      .from(communityPostsTable)
      .where(where)
      .orderBy(desc(communityPostsTable.createdAt))
      .limit(limit);
  }

  const rows = await renderPosts(basePosts, meId);
  res.status(200).json({ success: true, data: { posts: rows } });
});

// â”€â”€ GET /community/posts/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get("/community/posts/:id", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const [post] = await db
    .select()
    .from(communityPostsTable)
    .where(eq(communityPostsTable.id, String(req.params.id)))
    .limit(1);
  if (!post) {
    res.status(404).json({ success: false, message: "Post not found" });
    return;
  }
  const [row] = await renderPosts([post], req.user?.id, 50);
  res.status(200).json({ success: true, data: row });
});

// â”€â”€ POST /community/posts â€” create a post â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post("/community/posts", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { kind, content, tags, media, priceInr, deliveryDays, location, isRemote } = req.body ?? {};

  const k = kindWhitelist(String(kind || "POST"), "POST");
  if (!content || !String(content).trim()) {
    res.status(400).json({ success: false, message: "Post content is required" });
    return;
  }

  let price: number | null = null;
  if (k === "GIG") {
    const p = Number(priceInr);
    if (!Number.isFinite(p) || p <= 0) {
      res.status(400).json({ success: false, message: "Gig posts need a price in â‚¹" });
      return;
    }
    price = Math.round(p);
  }

  try {
    const [post] = await db
      .insert(communityPostsTable)
      .values({
        userId: req.user!.id,
        kind: k as typeof communityPostsTable.$inferSelect.kind,
        content: String(content).trim().slice(0, 5000),
        tags: cleanTags(tags),
        media: Array.isArray(media) ? media.slice(0, 9) : [],
        priceInr: price,
        deliveryDays: Number.isFinite(Number(deliveryDays)) && Number(deliveryDays) > 0 ? Math.round(Number(deliveryDays)) : null,
        location: location ? String(location).trim().slice(0, 100) : req.user!.city ?? null,
        isRemote: isRemote !== false,
      })
      .returning();

    const [row] = await renderPosts([post], req.user!.id);
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    logger.error({ err }, "Failed to create community post");
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
});

// â”€â”€ POST /community/posts/:id/like â€” toggle like â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post("/community/posts/:id/like", authenticate, async (req: Request, res: Response): Promise<void> => {
  const postId = String(req.params.id);
  const userId = req.user!.id;
  const [like] = await db
    .select({ id: communityLikesTable.id })
    .from(communityLikesTable)
    .where(and(eq(communityLikesTable.postId, postId), eq(communityLikesTable.userId, userId)))
    .limit(1);

  if (like) {
    await db.delete(communityLikesTable).where(eq(communityLikesTable.id, like.id));
    await db.update(communityPostsTable).set({ likeCount: sql`GREATEST(like_count - 1, 0)`, updatedAt: new Date() }).where(eq(communityPostsTable.id, postId));
  } else {
    await db.insert(communityLikesTable).values({ postId, userId });
    await db.update(communityPostsTable).set({ likeCount: sql`like_count + 1`, updatedAt: new Date() }).where(eq(communityPostsTable.id, postId));
  }

  const [post] = await db
    .select({ likeCount: communityPostsTable.likeCount })
    .from(communityPostsTable)
    .where(eq(communityPostsTable.id, postId))
    .limit(1);

  res.status(200).json({ success: true, data: { liked: !like, likeCount: post?.likeCount ?? 0 } });
});

// â”€â”€ POST /community/posts/:id/comment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post("/community/posts/:id/comment", authenticate, async (req: Request, res: Response): Promise<void> => {
  const content = String(req.body?.content || "").trim();
  if (!content) {
    res.status(400).json({ success: false, message: "Comment content is required" });
    return;
  }
  const [post] = await db
    .select({ id: communityPostsTable.id, commentCount: communityPostsTable.commentCount })
    .from(communityPostsTable)
    .where(eq(communityPostsTable.id, String(req.params.id)))
    .limit(1);
  if (!post) {
    res.status(404).json({ success: false, message: "Post not found" });
    return;
  }

  try {
    const [comment] = await db
      .insert(communityCommentsTable)
      .values({ postId: post.id, userId: req.user!.id, content: content.slice(0, 500) })
      .returning();
    await db.update(communityPostsTable).set({ commentCount: sql`comment_count + 1`, updatedAt: new Date() }).where(eq(communityPostsTable.id, post.id));

    const [author] = await db
      .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto })
      .from(usersTable)
      .where(eq(usersTable.id, req.user!.id))
      .limit(1);

    res.status(201).json({
      success: true,
      data: {
        id: comment.id,
        content: comment.content,
        createdAt: comment.createdAt,
        commentCount: (post.commentCount ?? 0) + 1,
        author: author ?? { id: req.user!.id, firstName: req.user!.firstName, lastName: "", profilePhoto: null },
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to comment on community post");
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
});

// â”€â”€ GET /community/users/:id â€” public profile card for feed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get("/community/users/:id", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const [user] = await db
    .select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      profilePhoto: usersTable.profilePhoto,
      email: usersTable.email,
      bio: usersTable.bio,
      tagline: usersTable.tagline,
      city: usersTable.city,
      skillsOffered: usersTable.skillsOffered,
      reputationScore: usersTable.reputationScore,
      kycVerified: usersTable.kycVerified,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, String(req.params.id)))
    .limit(1);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }

  const [postStats] = await db
    .select({
      posts: count(communityPostsTable.id),
      likes: sql<number>`COALESCE(SUM(${communityPostsTable.likeCount}), 0)`,
    })
    .from(communityPostsTable)
    .where(eq(communityPostsTable.userId, user.id));

  const [followerCount] = await db
    .select({ c: count() })
    .from(communityFollowsTable)
    .where(eq(communityFollowsTable.followingId, user.id));

  let following: boolean | null = null;
  if (req.user?.id && req.user.id !== user.id) {
    const [f] = await db
      .select({ id: communityFollowsTable.id })
      .from(communityFollowsTable)
      .where(and(eq(communityFollowsTable.followerId, req.user.id), eq(communityFollowsTable.followingId, user.id)))
      .limit(1);
    following = !!f;
  }

  res.status(200).json({
    success: true,
    data: {
      user,
      posts: Number(postStats?.posts ?? 0),
      likes: Number(postStats?.likes ?? 0),
      followers: Number(followerCount?.c ?? 0),
      following,
    },
  });
});

// â”€â”€ POST /community/users/:id/follow â€” toggle follow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post("/community/users/:id/follow", authenticate, async (req: Request, res: Response): Promise<void> => {
  const targetId = String(req.params.id);
  const meId = req.user!.id;
  if (targetId === meId) {
    res.status(400).json({ success: false, message: "You can't follow yourself" });
    return;
  }

  const [target] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.id, targetId))
    .limit(1);
  if (!target) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }

  const [existing] = await db
    .select({ id: communityFollowsTable.id })
    .from(communityFollowsTable)
    .where(and(eq(communityFollowsTable.followerId, meId), eq(communityFollowsTable.followingId, targetId)))
    .limit(1);

  if (existing) {
    await db.delete(communityFollowsTable).where(eq(communityFollowsTable.id, existing.id));
    res.status(200).json({ success: true, data: { following: false } });
  } else {
    await db.insert(communityFollowsTable).values({ followerId: meId, followingId: targetId });
    res.status(200).json({ success: true, data: { following: true } });
  }
});

// â”€â”€ POST /community/posts/:id/delete â€” author deletes post â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post("/community/posts/:id/delete", authenticate, async (req: Request, res: Response): Promise<void> => {
  const [post] = await db
    .select({ id: communityPostsTable.id, userId: communityPostsTable.userId })
    .from(communityPostsTable)
    .where(eq(communityPostsTable.id, String(req.params.id)))
    .limit(1);
  if (!post) {
    res.status(404).json({ success: false, message: "Post not found" });
    return;
  }
  if (post.userId !== req.user!.id && req.user!.role !== "ADMIN") {
    res.status(403).json({ success: false, message: "You can only delete your own posts" });
    return;
  }
  await db.delete(communityPostsTable).where(eq(communityPostsTable.id, post.id));
  res.status(200).json({ success: true, message: "Post deleted" });
});

export { avatarUrl, slugify };
export default router;