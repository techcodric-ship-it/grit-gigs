/**
 * Guard rails for demo/sample data.
 *
 * Demo records exist so the UI can be built, reviewed and demonstrated with a
 * populated marketplace. They are fabricated: invented people, invented work,
 * invented engagement. That is fine on a developer machine and unacceptable in
 * front of real users, because a visitor who believes a listing is real will
 * apply to it and message a person who does not exist.
 *
 * So every path that can produce demo data has to pass through here first, and
 * the default answer is no.
 */

const LOOPBACK = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i;

/** Strip credentials and query string so two spellings of one URL compare equal. */
function normalize(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export class DemoTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoTargetError";
  }
}

/**
 * True when demo data may be rendered or written.
 *
 * Requires BOTH that demo mode was explicitly requested AND that we are not
 * running a production build. NODE_ENV=production wins over everything, so a
 * stray DEMO_MODE=1 in a production env file cannot enable it.
 */
export function isDemoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") return false;
  return env.DEMO_MODE === "1";
}

/**
 * Refuse to write demo rows into a database that holds real users.
 *
 * Two independent checks, because either alone has a failure mode:
 *  - not equal to DATABASE_URL, so the production database is never a target
 *    even if the operator passes it explicitly;
 *  - not a remote host without an explicit opt-in, so a typo in a host name
 *    cannot point a seed run at someone's live database.
 */
export function assertDemoTargetAllowed(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV === "production") {
    throw new DemoTargetError("refusing to seed demo data with NODE_ENV=production");
  }

  const production = env.DATABASE_URL ? normalize(env.DATABASE_URL) : null;
  if (production && normalize(target) === production) {
    throw new DemoTargetError(
      "refusing to seed demo data into the production DATABASE_URL. " +
        "Point DATABASE_URL at a local or dedicated demo database.",
    );
  }

  const host = hostOf(target);
  if (!host) {
    throw new DemoTargetError("could not parse a hostname out of the target URL");
  }

  if (!LOOPBACK.test(host) && env.DEMO_ALLOW_REMOTE_TARGET !== "1") {
    throw new DemoTargetError(
      `refusing to seed demo data into remote host "${host}". ` +
        "Set DEMO_ALLOW_REMOTE_TARGET=1 only if this is a dedicated demo database.",
    );
  }
}