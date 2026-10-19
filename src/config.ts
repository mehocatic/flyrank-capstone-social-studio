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
  workerPollMs: number;
  workerLeaseMs: number;
  publishTimeoutMs: number;
  maxPublishAttempts: number;
}

class ConfigError extends Error {}

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
  if (workerLeaseMs <= publishTimeoutMs) {
    // Otherwise a lease can expire while the send is still in flight, and another
    // worker could claim a job that is already talking to the network.
    throw new ConfigError('WORKER_LEASE_MS must be greater than PUBLISH_TIMEOUT_MS');
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
  const usesDiscord = platforms.some((platform) => publishers[platform] === 'discord');
  if (usesDiscord && !webhookUrl) {
    throw new ConfigError(
      'DISCORD_WEBHOOK_URL is required because an active platform uses the `discord` adapter. ' +
        'Set it in .env, or point that platform at a mock adapter.',
    );
  }
  if (webhookUrl && !webhookUrl.startsWith('https://')) {
    throw new ConfigError('DISCORD_WEBHOOK_URL must be an https URL');
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
    workerPollMs: int('WORKER_POLL_MS', 2_000, 100),
    workerLeaseMs,
    publishTimeoutMs,
    maxPublishAttempts: int('MAX_PUBLISH_ATTEMPTS', 5, 1),
  };
}
