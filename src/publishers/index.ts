import type { AdapterName, Config, Platform } from '../config.js';
import type { Db } from '../db/index.js';
import { DiscordWebhookPublisher } from './discord.js';
import { MockPublisher } from './mock.js';
import type { SocialPublisher } from './types.js';

/**
 * The **only** place in the codebase that maps an adapter name to an implementation.
 *
 * This is what makes probe 6 true: swapping a platform's adapter is a change to
 * `.env`, not to business logic. Nothing outside this file names a concrete adapter,
 * so the worker, the routes and the services are all unaware of Discord or the mocks.
 */
export function createPublisher(name: AdapterName, config: Config, db: Db): SocialPublisher {
  switch (name) {
    case 'mock_x':
      return new MockPublisher('mock_x', db, config.publicBaseUrl);
    case 'mock_linkedin':
      return new MockPublisher('mock_linkedin', db, config.publicBaseUrl);
    case 'mock_discord':
      // A dry-run stand-in for the real Discord adapter, so the default setup needs
      // no webhook while still previewing Discord variants as Discord.
      return new MockPublisher('mock_discord', db, config.publicBaseUrl);
    case 'discord': {
      if (!config.discordWebhookUrl) {
        // loadConfig already refuses this combination, so reaching here is a bug.
        throw new Error('The `discord` adapter needs DISCORD_WEBHOOK_URL');
      }
      return new DiscordWebhookPublisher({
        webhookUrl: config.discordWebhookUrl,
        timeoutMs: config.publishTimeoutMs,
        guildId: config.discordGuildId,
      });
    }
  }
}

/**
 * One publisher per configured platform, built once at startup. Building them up
 * front means a misconfiguration fails at boot rather than at publish time, when a
 * job is already due.
 */
export function createPublisherRegistry(config: Config, db: Db): Map<Platform, SocialPublisher> {
  const registry = new Map<Platform, SocialPublisher>();
  for (const platform of config.platforms) {
    registry.set(platform, createPublisher(config.publishers[platform], config, db));
  }
  return registry;
}

export type { SocialPublisher } from './types.js';
