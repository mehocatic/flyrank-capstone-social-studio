import { redact } from '../redact.js';
import { failed, published, type PublishRequest, type PublishResult, type SocialPublisher } from './types.js';

/** Injected so tests can simulate every failure mode without a network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DiscordPublisherOptions {
  webhookUrl: string;
  timeoutMs: number;
  /** Optional, only to build a clickable message link. Not a secret. */
  guildId?: string | undefined;
  fetchImpl?: FetchLike;
}

/**
 * The one real publish target: a Discord webhook on a server I own.
 *
 * `dedupesByKey` is **false**, and that is the single most important line in this
 * file. A webhook accepts a message and has no notion of an idempotency key, so
 * sending the same request twice creates two messages. Every retry decision upstream
 * reads this flag, which is why an ambiguous failure is parked rather than retried.
 */
export class DiscordWebhookPublisher implements SocialPublisher {
  readonly name = 'discord';
  readonly dedupesByKey = false;
  readonly target = 'Discord webhook (URL read from .env, never stored or logged)';

  private readonly webhookUrl: string;
  private readonly timeoutMs: number;
  private readonly guildId: string | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(options: DiscordPublisherOptions) {
    this.webhookUrl = options.webhookUrl;
    this.timeoutMs = options.timeoutMs;
    this.guildId = options.guildId;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.executeUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: request.text,
          // Belt and braces with the `no_mass_mentions` rule: even if a variant
          // slipped through containing @everyone, Discord is told to resolve no
          // mentions at all, so it cannot ping a server.
          allowed_mentions: { parse: [] },
        }),
        // Shorter than the worker's lease, so a hung request cannot outlive the claim.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return this.classifyNetworkError(error);
    }

    if (response.ok) return await this.readMessage(response);
    return await this.classifyStatus(response);
  }

  /**
   * `?wait=true` makes Discord respond with the created message instead of an empty
   * 204. That costs one round trip and buys two things: the message id and link for
   * the publish history, and a much smaller crash window, because the result is known
   * as early as it possibly can be.
   */
  private executeUrl(): string {
    const separator = this.webhookUrl.includes('?') ? '&' : '?';
    return `${this.webhookUrl}${separator}wait=true`;
  }

  private async readMessage(response: Response): Promise<PublishResult> {
    try {
      const message = (await response.json()) as { id?: string; channel_id?: string; guild_id?: string };
      if (!message.id) throw new Error('response had no message id');

      return published(message.id, this.messageUrl(message));
    } catch (error) {
      // The post succeeded: Discord returned 2xx. Only the id is unreadable, which
      // must not be reported as a failure, or the job would be retried and post
      // twice. The attempt is recorded as a success with an unknown id instead.
      console.warn(`[discord] published but could not read the message id: ${redact(describe(error))}`);
      return published('unknown', '');
    }
  }

  private messageUrl(message: { id?: string; channel_id?: string; guild_id?: string }): string {
    const guild = message.guild_id ?? this.guildId;
    if (!guild || !message.channel_id) return '';
    return `https://discord.com/channels/${guild}/${message.channel_id}/${message.id}`;
  }

  /**
   * Status mapping. The reasoning is in docs/DESIGN.md; the rule of thumb is that
   * anything which might have been processed before failing is `ambiguous`, because
   * only a provably-not-posted failure is safe to retry against a target with no
   * idempotency key.
   */
  private async classifyStatus(response: Response): Promise<PublishResult> {
    const detail = await this.readErrorBody(response);

    if (response.status === 429) {
      // Rate limited. Discord rejects the request before creating a message, so this
      // is the one error class that is provably safe to retry.
      const retryAfter = response.headers.get('retry-after');
      return failed(
        'retryable',
        `Discord rate limited the request (429)${retryAfter ? `, retry-after ${retryAfter}s` : ''}${detail}`,
      );
    }

    if (response.status >= 500) {
      // NOT retryable. A 5xx can be returned after Discord has already accepted and
      // processed the message, for example a gateway failing on the way back.
      return failed(
        'ambiguous',
        `Discord returned ${response.status}, which may be after the message was created${detail}`,
      );
    }

    if (response.status === 408) {
      // The server gave up waiting on the request. Usually nothing was created, but
      // that is not guaranteed, and the safe direction is always ambiguous.
      return failed('ambiguous', `Discord returned 408 request timeout${detail}`);
    }

    // Any other 4xx is a request this webhook will never accept: a bad payload, a
    // revoked token, a deleted webhook. Retrying cannot help.
    return failed('permanent', `Discord rejected the request with ${response.status}${detail}`);
  }

  private classifyNetworkError(error: unknown): PublishResult {
    const name = error instanceof Error ? error.name : '';
    const message = describe(error);
    const code = extractCode(error);

    // Timeout: the request was already on the wire, so Discord may well have created
    // the message and only the response was lost.
    if (name === 'TimeoutError' || name === 'AbortError') {
      return failed(
        'ambiguous',
        `Discord request timed out after ${this.timeoutMs}ms; the message may have been created`,
      );
    }

    // Reset or truncated mid-flight: same reasoning, the request may have completed.
    if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || /socket hang up|terminated/i.test(message)) {
      return failed(
        'ambiguous',
        `Connection to Discord was reset in flight; the message may have been created (${redact(message)})`,
      );
    }

    // Never reached a server, so nothing can have been posted. Safe to retry.
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return failed('retryable', `Could not reach Discord (${code}); the request was never delivered`);
    }

    // Unrecognised: treat as ambiguous rather than guess in the unsafe direction.
    return failed('ambiguous', `Discord request failed in an unrecognised way: ${redact(message)}`);
  }

  /** Discord's error bodies are useful and contain no secret, but are capped and redacted. */
  private async readErrorBody(response: Response): Promise<string> {
    try {
      const text = (await response.text()).trim();
      return text ? `: ${redact(text).slice(0, 300)}` : '';
    } catch {
      return '';
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (cause: ${error.cause.message})` : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}

function extractCode(error: unknown): string | undefined {
  // Node nests the real cause: fetch throws "fetch failed" with the socket error as `cause`.
  for (const candidate of [error, error instanceof Error ? error.cause : undefined]) {
    if (candidate instanceof Error && 'code' in candidate && typeof candidate.code === 'string') {
      return candidate.code;
    }
  }
  return undefined;
}

export { redact } from '../redact.js';
