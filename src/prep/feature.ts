// FEATURE_PREP flag. Default OFF in every environment, including production.
// Enabled only when the env var is explicitly truthy: "1", "true" or "on".
// Nothing under /prep, /api/prep, /api/proof or the Prep nav entry may be
// visible or reachable while this returns false.

export const PREP_FLAG_NAME = "FEATURE_PREP";

const TRUTHY = new Set(["1", "true", "on"]);

export function isPrepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PREP_FLAG_NAME];
  if (raw === undefined || raw === null) return false;
  return TRUTHY.has(String(raw).trim().toLowerCase());
}
