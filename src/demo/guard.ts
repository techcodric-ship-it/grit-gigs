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
 * Three checks, because each covers a case the others miss:
 *  - NODE_ENV=production is refused outright;
 *  - a non-loopback target is refused unless DEMO_ALLOW_REMOTE_TARGET=1, so a
 *    typo in a hostname cannot point a seed run at a live database;
 *  - a target that IS the configured DATABASE_URL on a remote host is refused
 *    with no override, because that is unambiguously the live database.
 *
 * Loopback is always allowed. That is the local development case, where
 * DATABASE_URL deliberately points at the throwaway demo database, so an
 * earlier blanket "target must differ from DATABASE_URL" rule refused the one
 * situation it was written to permit.
 */
export function assertDemoTargetAllowed(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV === "production") {
    throw new DemoTargetError("refusing to seed demo data with NODE_ENV=production");
  }

  const host = hostOf(target);
  if (!host) {
    throw new DemoTargetError("could not parse a hostname out of the target URL");
  }

  if (LOOPBACK.test(host)) return;

  if (env.DATABASE_URL) {
    const liveHost = hostOf(env.DATABASE_URL);
    if (liveHost && liveHost.toLowerCase() === host.toLowerCase()) {
      throw new DemoTargetError(
        `refusing to seed demo data into "${host}", which is the database this ` +
          "process is connected to. That is the live database. Point " +
          "DATABASE_URL at a local or dedicated demo database instead.",
      );
    }
  }

  if (env.DEMO_ALLOW_REMOTE_TARGET !== "1") {
    throw new DemoTargetError(
      `refusing to seed demo data into remote host "${host}". ` +
        "Set DEMO_ALLOW_REMOTE_TARGET=1 only if this is a dedicated demo database.",
    );
  }
}