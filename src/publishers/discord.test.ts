import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DiscordWebhookPublisher, redact, type FetchLike } from './discord.js';
import type { PublishFailure, PublishSuccess } from './types.js';

/** A realistic-looking webhook URL. Fake, but shaped exactly like a real one. */
const WEBHOOK = 'https://discord.com/api/webhooks/1234567890123456789/aBcDeF-ghIJKlmnOpQrStUvWxYz_0123456789-abcdefGHIJ';
const TOKEN = 'aBcDeF-ghIJKlmnOpQrStUvWxYz_0123456789-abcdefGHIJ';

function publisherWith(fetchImpl: FetchLike, guildId?: string): DiscordWebhookPublisher {
  return new DiscordWebhookPublisher({
    webhookUrl: WEBHOOK,
    timeoutMs: 10_000,
    ...(guildId === undefined ? {} : { guildId }),
    fetchImpl,
  });
}

const request = {
  idempotencyKey: 'variant:1:slot:2026-10-19T15:00',
  platform: 'discord' as const,
  text: 'Publish exactly once, even when the network lies.',
};

/** Builds a fetch stub returning a given status and body. */
const respondWith = (status: number, body: unknown, headers: Record<string, string> = {}): FetchLike =>
  async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

/** Builds a fetch stub that throws, the way Node's fetch throws on a socket error. */
const throwing = (error: Error): FetchLike => async () => {
  throw error;
};

function nodeFetchError(code: string, message = 'fetch failed'): Error {
  // Node wraps socket failures: `fetch failed` with the real error as `cause`.
  const cause = Object.assign(new Error(`${code} something`), { code });
  return Object.assign(new Error(message), { cause });
}

describe('a successful publish', () => {
  it('returns the message id and a link to the live message', async () => {
    const publisher = publisherWith(
      respondWith(200, { id: '999888777', channel_id: '555444333', guild_id: '111222333' }),
    );
    const result = (await publisher.publish(request)) as PublishSuccess;

    assert.equal(result.ok, true);
    assert.equal(result.externalId, '999888777');
    assert.equal(result.url, 'https://discord.com/channels/111222333/555444333/999888777');
    assert.equal(result.deduplicated, false);
  });

  it('uses the configured guild id when the response omits one', async () => {
    const publisher = publisherWith(respondWith(200, { id: '999', channel_id: '555' }), '777');
    const result = (await publisher.publish(request)) as PublishSuccess;
    assert.equal(result.url, 'https://discord.com/channels/777/555/999');
  });

  it('still succeeds without a guild id, recording the id and no link', async () => {
    const publisher = publisherWith(respondWith(200, { id: '999', channel_id: '555' }));
    const result = (await publisher.publish(request)) as PublishSuccess;
    assert.equal(result.externalId, '999');
    assert.equal(result.url, '');
  });

  it('requests ?wait=true, so the message id is known as early as possible', async () => {
    let seenUrl = '';
    const publisher = publisherWith(async (url) => {
      seenUrl = url;
      return new Response(JSON.stringify({ id: '1', channel_id: '2' }), { status: 200 });
    });
    await publisher.publish(request);
    assert.match(seenUrl, /\?wait=true$/);
  });

  it('tells Discord to resolve no mentions, so a variant cannot ping a server', async () => {
    let body: { content: string; allowed_mentions: { parse: string[] } } | undefined;
    const publisher = publisherWith(async (_url, init) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: '1', channel_id: '2' }), { status: 200 });
    });
    await publisher.publish(request);

    assert.deepEqual(body?.allowed_mentions, { parse: [] });
    assert.equal(body?.content, request.text);
  });

  it('counts a 2xx with an unreadable body as published, never as a failure', async () => {
    // Discord accepted the message, so a retry would post twice. Only the id is lost.
    const publisher = publisherWith(respondWith(200, 'not json at all'));
    const result = (await publisher.publish(request)) as PublishSuccess;

    assert.equal(result.ok, true, 'a 2xx must never be reported as a failure');
    assert.equal(result.externalId, 'unknown');
  });
});

describe('failure classification', () => {
  it('never dedupes by key, which is why ambiguity cannot be retried', () => {
    assert.equal(publisherWith(respondWith(200, {})).dedupesByKey, false);
  });

  it('classifies 429 as retryable: the request was rejected before posting', async () => {
    const publisher = publisherWith(
      respondWith(429, { message: 'You are being rate limited.', retry_after: 1.5 }, { 'retry-after': '2' }),
    );
    const result = (await publisher.publish(request)) as PublishFailure;

    assert.equal(result.kind, 'retryable');
    assert.match(result.error, /429/);
    assert.match(result.error, /retry-after 2s/);
  });

  it('classifies 500 as ambiguous, not retryable', async () => {
    // The dangerous case: Discord may have created the message and failed afterwards.
    const publisher = publisherWith(respondWith(500, { message: 'Internal Server Error' }));
    const result = (await publisher.publish(request)) as PublishFailure;

    assert.equal(result.kind, 'ambiguous');
    assert.match(result.error, /may be after the message was created/);
  });

  it('classifies 502, 503 and 504 as ambiguous too', async () => {
    for (const status of [502, 503, 504]) {
      const publisher = publisherWith(respondWith(status, 'gateway trouble'));
      const result = (await publisher.publish(request)) as PublishFailure;
      assert.equal(result.kind, 'ambiguous', `${status} must be ambiguous`);
    }
  });

  it('classifies 400 as permanent: the payload will never be accepted', async () => {
    const publisher = publisherWith(respondWith(400, { message: 'Invalid Form Body' }));
    const result = (await publisher.publish(request)) as PublishFailure;

    assert.equal(result.kind, 'permanent');
    assert.match(result.error, /400/);
  });

  it('classifies 404 as permanent: the webhook is gone', async () => {
    const publisher = publisherWith(respondWith(404, { message: 'Unknown Webhook' }));
    const result = (await publisher.publish(request)) as PublishFailure;

    assert.equal(result.kind, 'permanent');
    assert.match(result.error, /Unknown Webhook/);
  });

  it('classifies 401 and 403 as permanent: a revoked token will not recover', async () => {
    for (const status of [401, 403]) {
      const publisher = publisherWith(respondWith(status, 'nope'));
      const result = (await publisher.publish(request)) as PublishFailure;
      assert.equal(result.kind, 'permanent', `${status} must be permanent`);
    }
  });

  it('classifies a timeout as ambiguous: the request was already on the wire', async () => {
    const publisher = publisherWith(throwing(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })));
    const result = (await publisher.publish(request)) as PublishFailure;

    assert.equal(result.kind, 'ambiguous');
    assert.match(result.error, /timed out after 10000ms/);
    assert.match(result.error, /may have been created/);
  });

  it('classifies a connection reset as ambiguous', async () => {
    const publisher = publisherWith(throwing(nodeFetchError('ECONNRESET')));
    const result = (await publisher.publish(request)) as PublishFailure;

    assert.equal(result.kind, 'ambiguous');
    assert.match(result.error, /reset in flight/);
  });

  it('classifies "socket hang up" as ambiguous', async () => {
    const publisher = publisherWith(throwing(new Error('socket hang up')));
    const result = (await publisher.publish(request)) as PublishFailure;
    assert.equal(result.kind, 'ambiguous');
  });

  it('classifies connection refused as retryable: nothing was delivered', async () => {
    const publisher = publisherWith(throwing(nodeFetchError('ECONNREFUSED')));
    const result = (await publisher.publish(request)) as PublishFailure;

    assert.equal(result.kind, 'retryable');
    assert.match(result.error, /never delivered/);
  });

  it('classifies DNS failure as retryable: the request never reached a server', async () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
      const publisher = publisherWith(throwing(nodeFetchError(code)));
      const result = (await publisher.publish(request)) as PublishFailure;
      assert.equal(result.kind, 'retryable', `${code} must be retryable`);
    }
  });

  it('defaults an unrecognised error to ambiguous, the safe direction', async () => {
    // Guessing "retryable" here is exactly how a duplicate post happens.
    const publisher = publisherWith(throwing(new Error('something nobody predicted')));
    const result = (await publisher.publish(request)) as PublishFailure;
    assert.equal(result.kind, 'ambiguous');
  });
});

describe('the webhook URL never escapes', () => {
  /** Every way this adapter can fail, as the text it would hand upstream to be stored. */
  async function allFailureTexts(): Promise<string[]> {
    const cases: FetchLike[] = [
      // Error messages that embed the request URL, which is what Node actually does.
      throwing(new Error(`request to ${WEBHOOK}?wait=true failed`)),
      throwing(Object.assign(new Error(`connect ECONNRESET ${WEBHOOK}`), { code: 'ECONNRESET' })),
      throwing(new Error(`fetch failed`, { cause: new Error(`socket hang up at ${WEBHOOK}`) })),
      throwing(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })),
      // Error bodies that echo the URL or token back at us.
      respondWith(400, { message: `Invalid webhook ${WEBHOOK}` }),
      respondWith(500, `upstream ${WEBHOOK}?wait=true returned 500`),
      respondWith(404, { message: `Unknown Webhook`, url: WEBHOOK }),
      respondWith(429, `slow down, ${WEBHOOK}`),
    ];

    const texts: string[] = [];
    for (const fetchImpl of cases) {
      const result = await publisherWith(fetchImpl).publish(request);
      if (!result.ok) texts.push(result.error);
    }
    return texts;
  }

  it('redacts the URL and the token from every stored error message', async () => {
    const texts = await allFailureTexts();
    assert.equal(texts.length, 8, 'every case should produce a failure to inspect');

    for (const text of texts) {
      assert.ok(!text.includes(WEBHOOK), `URL leaked: ${text}`);
      assert.ok(!text.includes(TOKEN), `token leaked: ${text}`);
      assert.ok(!/\/webhooks\/\d{5,}/.test(text), `webhook id leaked: ${text}`);
    }
  });

  it('does not expose the URL through the adapter description', () => {
    const publisher = publisherWith(respondWith(200, {}));
    assert.ok(!publisher.target.includes(WEBHOOK));
    assert.ok(!publisher.target.includes(TOKEN));
  });
});

describe('redact', () => {
  it('removes a full webhook URL', () => {
    assert.equal(redact(`posting to ${WEBHOOK} now`), 'posting to [discord-webhook-redacted] now');
  });

  it('removes the discordapp.com form as well', () => {
    const old = 'https://discordapp.com/api/v10/webhooks/123456789/secrettoken';
    assert.ok(!redact(`see ${old}`).includes('secrettoken'));
  });

  it('removes a bare webhook path, with or without a version', () => {
    assert.ok(!redact('/api/webhooks/123456789/secrettoken').includes('secrettoken'));
    assert.ok(!redact('/api/v10/webhooks/123456789/secrettoken').includes('secrettoken'));
  });

  it('leaves text with no webhook in it untouched', () => {
    assert.equal(redact('Discord returned 500'), 'Discord returned 500');
  });
});
