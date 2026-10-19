import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

/**
 * These run in a **real child process**, because the behaviour under test is Node's
 * own crash reporting. An in-process test cannot prove it: installing the handler is
 * exactly what suppresses the default output, so the only honest check is to crash a
 * process for real and read its stderr.
 */

const WEBHOOK = 'https://discord.com/api/webhooks/1234567890123456789/aBcDeF-ghIJKlmnOpQrStUvWxYz_0123456789';
const TOKEN = 'aBcDeF-ghIJKlmnOpQrStUvWxYz_0123456789';

const guardsModule = new URL('./process-guards.js', import.meta.url).href;
const workDir = mkdtempSync(join(tmpdir(), 'studio-fatal-'));

after(() => rmSync(workDir, { recursive: true, force: true }));

/** Runs a script in a child process and returns what it printed and how it exited. */
function runChild(name: string, body: string): { stderr: string; stdout: string; status: number | null } {
  const file = join(workDir, `${name}.mjs`);
  writeFileSync(file, body);
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', file], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { stderr: result.stderr, stdout: result.stdout, status: result.status };
}

const withGuards = (crash: string): string => `
import { installFatalHandlers } from ${JSON.stringify(guardsModule)};
installFatalHandlers();
const WEBHOOK = ${JSON.stringify(WEBHOOK)};
${crash}
`;

/** The shape Node's fetch actually produces: a bland message hiding the URL in `cause`. */
const FETCH_STYLE_REJECTION = `
Promise.reject(new Error('fetch failed', { cause: new Error('socket hang up at ' + WEBHOOK) }));
`;

describe('unhandled promise rejection', () => {
  it('redacts the webhook URL that Node would otherwise print, and exits non-zero', () => {
    const { stderr, status } = runChild('rejection', withGuards(FETCH_STYLE_REJECTION));

    assert.ok(!stderr.includes(TOKEN), `token leaked to stderr:\n${stderr}`);
    assert.ok(!stderr.includes(WEBHOOK), `URL leaked to stderr:\n${stderr}`);
    assert.match(stderr, /\[fatal] unhandled promise rejection/);
    assert.match(stderr, /\[discord-webhook-redacted]/);
    // The cause is still reported, so the log remains diagnosable.
    assert.match(stderr, /socket hang up/);
    assert.notEqual(status, 0, 'a fatal error must not exit successfully');
  });

  it('redacts a rejection with a non-Error value', () => {
    const { stderr } = runChild('rejection-string', withGuards(`Promise.reject('failed calling ' + WEBHOOK);`));

    assert.ok(!stderr.includes(TOKEN), stderr);
    assert.match(stderr, /\[discord-webhook-redacted]/);
  });
});

describe('uncaught exception', () => {
  it('redacts the webhook URL and exits non-zero', () => {
    const { stderr, status } = runChild(
      'exception',
      withGuards(`setTimeout(() => { throw new Error('POST ' + WEBHOOK + ' exploded'); }, 0);`),
    );

    assert.ok(!stderr.includes(TOKEN), `token leaked to stderr:\n${stderr}`);
    assert.match(stderr, /\[fatal] uncaught exception/);
    assert.match(stderr, /\[discord-webhook-redacted]/);
    assert.notEqual(status, 0);
  });

  it('redacts a throw during startup, before any request is served', () => {
    const { stderr } = runChild('exception-sync', withGuards(`throw new Error('boot failed for ' + WEBHOOK);`));

    assert.ok(!stderr.includes(TOKEN), stderr);
    assert.match(stderr, /\[fatal] uncaught exception/);
  });
});

describe('the control case: this is what Node does without the handlers', () => {
  it('leaks the webhook URL when the handlers are not installed', () => {
    // Proves the handler is what prevents the leak, rather than the leak being
    // impossible anyway. If this ever stops leaking, the tests above are vacuous.
    const { stderr, status } = runChild(
      'control',
      `
      const WEBHOOK = ${JSON.stringify(WEBHOOK)};
      ${FETCH_STYLE_REJECTION}
      `,
    );

    assert.ok(stderr.includes(TOKEN), `expected Node's default output to leak, got:\n${stderr}`);
    assert.notEqual(status, 0);
  });
});
