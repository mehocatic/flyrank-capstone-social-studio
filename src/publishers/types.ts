import type { Platform } from '../config.js';

/**
 * The adapter seam. The app publishes through this interface and never learns which
 * network it is talking to. A new platform is a new implementation, not a change to
 * the worker. Configuration chooses the implementation (probe 6).
 */
export interface SocialPublisher {
  /** Matches the configured adapter name, and is recorded on every publish attempt. */
  readonly name: string;

  /**
   * True when sending the **same idempotency key twice is safe**, because the target
   * recognises the key and will not create a second post.
   *
   * This single flag decides what the worker may do after an ambiguous failure, which
   * is the whole crash-safety question:
   *  - `true`  (the mocks, which key their stored rows): a retry is safe, so the job
   *            is retried and at-least-once delivery becomes exactly-once in effect.
   *  - `false` (a Discord webhook, which has no idempotency key): a retry could post
   *            twice, so an ambiguous job is parked as `unknown` for a human instead.
   */
  readonly dedupesByKey: boolean;

  /** A line for the history view, naming the destination without revealing a secret. */
  readonly target: string;

  publish(request: PublishRequest): Promise<PublishResult>;
}

export interface PublishRequest {
  /** `variant:{id}:slot:{iso-minute}`. Stable across retries, unique per variant and slot. */
  idempotencyKey: string;
  platform: Platform;
  text: string;
}

export type PublishResult = PublishSuccess | PublishFailure;

export interface PublishSuccess {
  ok: true;
  /** The target's own id for the message, stored so history can prove what was posted. */
  externalId: string;
  /** A link to the live message, or to a mock's preview page. */
  url: string;
  /** True when the target recognised the key and returned the existing message. */
  deduplicated: boolean;
}

export interface PublishFailure {
  ok: false;
  kind: FailureKind;
  error: string;
}

/**
 * How a failure may be treated. The adapter classifies, because only the adapter knows
 * what its protocol guarantees. Getting this wrong is how duplicates happen.
 */
export type FailureKind =
  /** Provably not posted (connection refused, 429 before processing). Safe to retry. */
  | 'retryable'
  /** Provably rejected and never will be accepted (400, 404, text too long). Do not retry. */
  | 'permanent'
  /**
   * Unknown whether the post landed: a timeout after the request was sent, a 5xx, a
   * reset connection. Retrying risks a duplicate, so only an adapter with
   * `dedupesByKey` may retry; otherwise a human decides.
   */
  | 'ambiguous';

/** Helpers, so every adapter builds the same shapes. */
export const published = (externalId: string, url: string, deduplicated = false): PublishSuccess => ({
  ok: true,
  externalId,
  url,
  deduplicated,
});

export const failed = (kind: FailureKind, error: string): PublishFailure => ({ ok: false, kind, error });
