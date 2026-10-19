import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redact, redactError } from './redact.js';

const WEBHOOK = 'https://discord.com/api/webhooks/1234567890123456789/aBcDeF-ghIJKlmnOpQrStUvWxYz_0123456789';
const TOKEN = 'aBcDeF-ghIJKlmnOpQrStUvWxYz_0123456789';

describe('redact', () => {
  it('removes a webhook URL anywhere in the text', () => {
    for (const text of [
      `request to ${WEBHOOK}?wait=true failed`,
      `${WEBHOOK}`,
      `connect ECONNRESET ${WEBHOOK} at 1.2.3.4:443`,
      `{"message":"Invalid webhook","url":"${WEBHOOK}"}`,
    ]) {
      const safe = redact(text);
      assert.ok(!safe.includes(TOKEN), `token leaked: ${safe}`);
      assert.ok(!safe.includes(WEBHOOK), `URL leaked: ${safe}`);
    }
  });

  it('removes the legacy discordapp.com host and versioned paths', () => {
    assert.ok(!redact(`https://discordapp.com/api/v10/webhooks/123456789/${TOKEN}`).includes(TOKEN));
    assert.ok(!redact(`/api/v10/webhooks/123456789/${TOKEN}`).includes(TOKEN));
    assert.ok(!redact(`/api/webhooks/123456789/${TOKEN}`).includes(TOKEN));
  });

  it('leaves text without a secret untouched', () => {
    assert.equal(redact('Discord returned 500'), 'Discord returned 500');
    assert.equal(redact('see https://discord.com/channels/1/2/3'), 'see https://discord.com/channels/1/2/3');
  });
});

describe('redactError', () => {
  it('includes the stack, so the log is still useful', () => {
    const safe = redactError(new Error('boom'));
    assert.match(safe, /Error: boom/);
    assert.match(safe, /redact\.test/);
  });

  it('redacts a URL carried in the message', () => {
    const safe = redactError(new Error(`POST ${WEBHOOK} failed`));
    assert.ok(!safe.includes(TOKEN), safe);
  });

  it('redacts a URL hidden in a nested cause, which is where fetch puts it', () => {
    // `fetch` throws a bland "fetch failed" and hides the real error in `cause`.
    const error = new Error('fetch failed', { cause: new Error(`socket hang up at ${WEBHOOK}`) });
    const safe = redactError(error);

    assert.match(safe, /caused by/);
    assert.ok(!safe.includes(TOKEN), safe);
  });

  it('handles a non-Error being thrown', () => {
    assert.equal(redactError(`failed calling ${WEBHOOK}`).includes(TOKEN), false);
    assert.equal(redactError(42), '42');
  });
});
