/**
 * Removes secrets from any text that is about to be logged, stored or returned.
 *
 * Applied at every boundary where arbitrary text escapes the process, not only where
 * a leak is known to be possible. A thrown `fetch` error routinely embeds the whole
 * request URL, and such strings reach `publish_attempts.error`, `jobs.last_error` and
 * the server log, all of which a person can read. The match is structural rather than
 * a comparison against the configured value, so a URL arriving from a redirect, a
 * nested `cause`, or a copy of the config is caught too.
 */
export function redact(text: string): string {
  return text
    .replace(
      /https?:\/\/[^\s/]*discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\S*/gi,
      '[discord-webhook-redacted]',
    )
    .replace(/\/api(?:\/v\d+)?\/webhooks\/\d+\/\S*/gi, '/api/webhooks/[redacted]');
}

/**
 * An error as safe, readable text. Includes the stack and any nested `cause`, because
 * that is where the useful detail lives, then redacts the result.
 */
export function redactError(error: unknown): string {
  if (!(error instanceof Error)) return redact(String(error));

  const parts = [error.stack ?? `${error.name}: ${error.message}`];
  if (error.cause instanceof Error) {
    parts.push(`caused by: ${error.cause.stack ?? error.cause.message}`);
  } else if (error.cause !== undefined) {
    parts.push(`caused by: ${String(error.cause)}`);
  }
  return redact(parts.join('\n'));
}
