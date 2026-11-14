// Profile photo helpers for GritScore cards.
//
// The owner can upload one photo that appears on the public card. It is purely
// decorative: never read by the score, never sent to the AI extractor. Two
// checks live here because both protect the same <img src>:
//   - safePhotoUrl: only a file we stored ourselves or a real https URL may be
//     rendered, so a corrupted row cannot inject javascript: or data: URLs.
//   - looksLikeImage: the extension and browser MIME type are attacker
//     controlled, so the bytes are checked before anything is stored.

/** Only a profile photo we stored ourselves or a real https URL is allowed to
 *  reach an <img src>. Anything else (javascript:, data:, unknown paths) is
 *  dropped, so a corrupted row cannot become an injection point. */
export function safePhotoUrl(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (/^https:\/\//i.test(value)) return value.slice(0, 600);
  if (/^\/uploads\/gritscore\/[A-Za-z0-9._-]+$/.test(value)) return value.slice(0, 600);
  return null;
}

/** True when the buffer starts with a JPEG, PNG or WebP signature. */
export function looksLikeImage(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) return false;
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const webp = buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  return jpeg || png || webp;
}
