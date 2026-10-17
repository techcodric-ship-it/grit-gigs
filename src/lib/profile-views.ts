// Pure helpers for the "Who viewed me" list.

export interface ProfileViewRow {
  viewerId: string | null;
  createdAt: Date | string;
  viewer?: {
    id: string;
    firstName: string;
    lastName: string | null;
    profilePhoto: string | null;
    city: string | null;
  } | null;
}

export interface ProfileViewSummary {
  total: number;
  signedIn: number;
  anonymous: number;
  viewers: {
    id: string;
    name: string;
    profilePhoto: string | null;
    city: string | null;
    views: number;
    lastViewedAt: Date;
  }[];
}

/** Collapse raw view rows into per-viewer summaries, most recent first. */
export function summarizeProfileViews(rows: ProfileViewRow[]): ProfileViewSummary {
  const byViewer = new Map<string, { views: number; last: Date; viewer: ProfileViewRow["viewer"] }>();
  let anonymous = 0;
  for (const r of rows) {
    const at = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
    if (!r.viewerId) {
      anonymous++;
      continue;
    }
    const cur = byViewer.get(r.viewerId);
    if (cur) {
      cur.views++;
      if (at > cur.last) cur.last = at;
    } else {
      byViewer.set(r.viewerId, { views: 1, last: at, viewer: r.viewer ?? null });
    }
  }
  const viewers = [...byViewer.entries()]
    .map(([id, v]) => ({
      id,
      name: v.viewer ? `${v.viewer.firstName} ${v.viewer.lastName ?? ""}`.trim() : "Grit&Gigs member",
      profilePhoto: v.viewer?.profilePhoto ?? null,
      city: v.viewer?.city ?? null,
      views: v.views,
      lastViewedAt: v.last,
    }))
    .sort((a, b) => b.lastViewedAt.getTime() - a.lastViewedAt.getTime());
  return {
    total: rows.length,
    signedIn: rows.length - anonymous,
    anonymous,
    viewers,
  };
}

export const PROFILE_VIEW_LIMIT = 100;
