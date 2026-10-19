import { existsSync } from 'node:fs';
import process from 'node:process';

/**
 * Loads .env and validates every setting once, at startup.
 * Nothing else in the app reads process.env, so a typo is a boot error instead of
 * an `undefined` that only shows up when the worker tries to publish.
 */

if (existsSync('.env')) {
  // Built into Node (>= 22). No `dotenv` dependency needed.
  process.loadEnvFile('.env');
}

export const PLATFORMS = ['x', 'linkedin', 'discord'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ADAPTERS = ['discord', 'mock_x', 'mock_linkedin'] as const;
export type AdapterName = (typeof ADAPTERS)[number];

export interface Config {
  port: number;
  databaseFile: string;
  /** Platforms that `POST /posts/:id/generate` creates a variant for. */
  platforms: Platform[];
  /** Platform -> adapter that publishes it. The app never hardcodes this. */
  publishers: Record<Platform, AdapterName>;
  /** Used to build links to mock previews, so a stored link is clickable. */
  publicBaseUrl: string;
  discordWebhookUrl: string | undefined;
  /** Optional, and not a secret: only used to build a clickable link to a message. */
  discordGuildId: string | undefined;
  workerPollMs: number;
  workerLeaseMs: number;
  publishTimeoutMs: number;
  maxPublishAttempts: number;
}

class ConfigError extends Error {}

/**
 * Design-level headroom: how much longer a lease must be than the publish timeout,
 * checked once at boot. Covers the whole claim-to-commit timeline described in
 * docs/DESIGN.md, generously, because stretching is cheap and a duplicate post is not.
 */
export const LEASE_SAFETY_MARGIN_MS = 20_000;

/**
 * Runtime threshold: how much lease a worker insists on *still having* before it
 * starts a send, on top of the publish timeout. This is only what step 3 needs,
 * aborting the request and committing one row, so it is small.
 *
 * It must stay well below LEASE_SAFETY_MARGIN_MS. If the two were equal, a worker
 * holding a freshly claimed lease of exactly `timeout + margin` would already be a
 * few milliseconds short and would refuse to send at all, which is a bug this code
 * actually had: jobs were released unsent and retried until a millisecond boundary
 * happened to line up.
 */
export const LEASE_COMMIT_ALLOWANCE_MS = 2_000;

function str(key: string, fallback?: string): string {
  const raw = process.env[key]?.trim();
  if (raw) return raw;
  if (fallback !== undefined) return fallback;
  throw new ConfigError(`${key} is required`);
}

function int(key: string, fallback: number, min: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(`${key} must be a whole number >= ${min}, got "${raw}"`);
  }
  return value;
}

function oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = str(key, fallback);
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(', ')}, got "${raw}"`);
  }
  return raw as T;
}

function isAllowedWebhookUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}

function parsePlatforms(): Platform[] {
  const names = str('PLATFORMS', 'x,linkedin,discord')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  const unknown = names.filter((name) => !(PLATFORMS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new ConfigError(`PLATFORMS has unknown entries: ${unknown.join(', ')}. Allowed: ${PLATFORMS.join(', ')}`);
  }
  if (names.length === 0) throw new ConfigError('PLATFORMS must list at least one platform');
  return [...new Set(names)] as Platform[];
}

export function loadConfig(): Config {
  const platforms = parsePlatforms();
  const publishers = {
    x: oneOf('PUBLISHER_X', ADAPTERS, 'mock_x'),
    linkedin: oneOf('PUBLISHER_LINKEDIN', ADAPTERS, 'mock_linkedin'),
    discord: oneOf('PUBLISHER_DISCORD', ADAPTERS, 'discord'),
  } satisfies Record<Platform, AdapterName>;

  const publishTimeoutMs = int('PUBLISH_TIMEOUT_MS', 10_000, 1_000);
  const workerLeaseMs = int('WORKER_LEASE_MS', 60_000, 1_000);

  // Why a margin and not merely "greater than": if a lease expires while worker A is
  // still inside fetch, worker B claims the job and sends it a second time. Guarding
  // the database write cannot prevent that, because the duplicate has already been
  // posted. The lease must therefore outlast everything that can happen between the
  // claim and the result being committed:
  //   1. the gap between claiming and the request leaving (event loop, JSON encode)
  //   2. the request itself, bounded by PUBLISH_TIMEOUT_MS
  //   3. handling the abort and committing the outcome (one SQLite write, fsynced)
  //   4. clock and scheduling jitter between two processes on one machine
  // Steps 1, 3 and 4 are small but not zero, and a GC pause or a laptop suspend can
  // stretch any of them. LEASE_SAFETY_MARGIN_MS is the headroom for all of them.
  if (workerLeaseMs < publishTimeoutMs + LEASE_SAFETY_MARGIN_MS) {
    throw new ConfigError(
      `WORKER_LEASE_MS (${workerLeaseMs}) must be at least PUBLISH_TIMEOUT_MS + ` +
        `${LEASE_SAFETY_MARGIN_MS}ms = ${publishTimeoutMs + LEASE_SAFETY_MARGIN_MS}ms. ` +
        `A lease that can expire while a send is still in flight allows a second worker ` +
        `to claim the job and post the message twice.`,
    );
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
  const usesDiscord = platforms.some((platform) => publishers[platform] === 'discord');
  if (usesDiscord && !webhookUrl) {
    throw new ConfigError(
      'DISCORD_WEBHOOK_URL is required because an active platform uses the `discord` adapter. ' +
        'Set it in .env, or point that platform at a mock adapter.',
    );
  }
  // https only, so a webhook token never crosses a network in clear. localhost is
  // allowed over http because the request never leaves the machine, which is what
  // makes it possible to point the real adapter at a local endpoint and test its
  // behaviour (including a hung send) without a live webhook.
  if (webhookUrl && !isAllowedWebhookUrl(webhookUrl)) {
    throw new ConfigError(
      'DISCORD_WEBHOOK_URL must be an https URL (http is allowed only for localhost)',
    );
  }

  const port = int('PORT', 3000, 1);

  return {
    port,
    publicBaseUrl: str('PUBLIC_BASE_URL', `http://localhost:${port}`).replace(/\/+$/, ''),
    databaseFile: str('DATABASE_FILE', './data/studio.db'),
    // `port` is read above, because publicBaseUrl defaults from it.
    platforms,
    publishers,
    // `exactOptionalPropertyTypes` forbids assigning undefined to an optional key,
    // so the type is `string | undefined` and the key is always present.
    discordWebhookUrl: webhookUrl || undefined,
    discordGuildId: process.env.DISCORD_GUILD_ID?.trim() || undefined,
    workerPollMs: int('WORKER_POLL_MS', 2_000, 100),
    workerLeaseMs,
    publishTimeoutMs,
    maxPublishAttempts: int('MAX_PUBLISH_ATTEMPTS', 5, 1),
  };
}
