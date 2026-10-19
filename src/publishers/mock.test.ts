import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase, type Db } from '../db/index.js';
import { MockPostRepository, MockPublisher } from './mock.js';
import type { PublishSuccess } from './types.js';

let db: Db;
let publisher: MockPublisher;
let posts: MockPostRepository;

beforeEach(() => {
  // A real schema in memory, so the UNIQUE constraint under test is the actual one.
  db = openDatabase(':memory:');
  publisher = new MockPublisher('mock_x', db, 'http://localhost:3000');
  posts = new MockPostRepository(db);
});

const request = (key: string, text = 'Retries are cheap. Correctness is not.') => ({
  idempotencyKey: key,
  platform: 'x' as const,
  text,
});

describe('MockPublisher', () => {
  it('stores what it would have posted and returns a preview link', async () => {
    const result = (await publisher.publish(request('variant:1:slot:2026-10-19T15:00'))) as PublishSuccess;

    assert.equal(result.ok, true);
    assert.equal(result.deduplicated, false);
    assert.equal(result.url, `http://localhost:3000/mock/posts/${result.externalId}`);

    const stored = posts.findById(Number(result.externalId));
    assert.equal(stored?.adapter, 'mock_x');
    assert.equal(stored?.text, 'Retries are cheap. Correctness is not.');
    assert.equal(stored?.idempotencyKey, 'variant:1:slot:2026-10-19T15:00');
  });

  it('declares that it dedupes by key, which is what lets the worker retry it', () => {
    assert.equal(publisher.dedupesByKey, true);
  });

  it('names its target without revealing anything secret', () => {
    assert.match(publisher.target, /mock_x/);
  });
});

describe('publishing the same key twice', () => {
  it('creates exactly one stored post', async () => {
    const key = 'variant:1:slot:2026-10-19T15:00';
    const first = (await publisher.publish(request(key))) as PublishSuccess;
    const second = (await publisher.publish(request(key))) as PublishSuccess;

    assert.equal(posts.countByKey('mock_x', key), 1, 'the key must store one post, not two');
    assert.equal(second.externalId, first.externalId, 'the retry returns the original message id');
    assert.equal(second.url, first.url);
  });

  it('reports the second call as deduplicated, so history can tell them apart', async () => {
    const key = 'variant:2:slot:2026-10-19T15:00';
    const first = (await publisher.publish(request(key))) as PublishSuccess;
    const second = (await publisher.publish(request(key))) as PublishSuccess;

    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
  });

  it('keeps the first text, ignoring different text under the same key', async () => {
    // The key identifies the intended post. Once sent, the text is settled: a retry
    // must not quietly rewrite a message that is already live.
    const key = 'variant:3:slot:2026-10-19T15:00';
    const first = (await publisher.publish(request(key, 'original text'))) as PublishSuccess;
    await publisher.publish(request(key, 'different text'));

    assert.equal(posts.countByKey('mock_x', key), 1);
    assert.equal(posts.findById(Number(first.externalId))?.text, 'original text');
  });

  it('survives many retries of the same key', async () => {
    const key = 'variant:4:slot:2026-10-19T15:00';
    const results = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      results.push((await publisher.publish(request(key))) as PublishSuccess);
    }

    assert.equal(posts.countByKey('mock_x', key), 1);
    assert.equal(new Set(results.map((r) => r.externalId)).size, 1, 'every retry returns one id');
  });
});

describe('different keys and different adapters are independent', () => {
  it('treats a different slot as a different post', async () => {
    await publisher.publish(request('variant:1:slot:2026-10-19T15:00'));
    await publisher.publish(request('variant:1:slot:2026-10-19T16:00'));

    assert.equal(posts.countByKey('mock_x', 'variant:1:slot:2026-10-19T15:00'), 1);
    assert.equal(posts.countByKey('mock_x', 'variant:1:slot:2026-10-19T16:00'), 1);
  });

  it('keeps two adapters from sharing a key, since each is its own destination', async () => {
    const linkedin = new MockPublisher('mock_linkedin', db, 'http://localhost:3000');
    const key = 'variant:1:slot:2026-10-19T15:00';

    const a = (await publisher.publish(request(key))) as PublishSuccess;
    const b = (await linkedin.publish(request(key))) as PublishSuccess;

    assert.notEqual(a.externalId, b.externalId, 'the same key on another adapter is another post');
    assert.equal(posts.countByKey('mock_x', key), 1);
    assert.equal(posts.countByKey('mock_linkedin', key), 1);
  });
});
