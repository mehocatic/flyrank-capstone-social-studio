import { isIP } from 'node:net';
import { badRequest, unprocessable } from '../http/errors.js';
import { htmlToMarkdown } from './markdown.js';

const MAX_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Hosts that must never be fetched. The URL comes from a request body, so without
 * this check the server could be asked to fetch its own network (SSRF), for example
 * a cloud metadata endpoint. Blocking by hostname is a deliberately simple guard:
 * it does not resolve DNS, so a name pointing at a private IP still gets through.
 * Stated plainly rather than hidden, because this tool runs on a trusted machine.
 */
function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest(`"url" is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest(`"url" must use http or https, got "${url.protocol}"`);
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLocalName = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local');
  const isLoopbackV6 = host === '::1';
  const isPrivateV4 =
    isIP(host) === 4 &&
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);

  if (isLocalName || isLoopbackV6 || isPrivateV4) {
    throw badRequest(`"url" points at a local or private address (${host}), which is not fetched`);
  }
  return url;
}

export interface FetchedPost {
  title: string | undefined;
  body: string;
  finalUrl: string;
}

/**
 * Fetches the page once, at ingest time. The stored row is then the single source
 * of truth: generation never re-fetches, so a variant cannot silently change when
 * the blog does.
 */
export async function fetchPost(raw: string): Promise<FetchedPost> {
  const url = assertFetchableUrl(raw);

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'text/html,text/markdown,text/plain', 'user-agent': 'social-media-studio/0.1' },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw unprocessable('fetch_failed', `Could not fetch ${url.href}: ${reason}`);
  }

  if (!response.ok) {
    throw unprocessable('fetch_failed', `${url.href} returned HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!/text\/(html|markdown|plain)|application\/(xhtml|json)/i.test(contentType)) {
    throw unprocessable('fetch_failed', `${url.href} is "${contentType}", not a readable text page`);
  }

  const raw_body = await readCapped(response);
  const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw_body);
  const parsed = isHtml ? htmlToMarkdown(raw_body) : { title: undefined, body: raw_body.trim() };

  if (parsed.body.length < 50) {
    throw unprocessable(
      'fetch_failed',
      `${url.href} yielded only ${parsed.body.length} characters of text, too little to generate from`,
    );
  }
  return { ...parsed, finalUrl: response.url || url.href };
}

/** Reads the body but stops at MAX_BYTES, so a huge page cannot exhaust memory. */
async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) {
    throw unprocessable('fetch_failed', `Page is ${declared} bytes, over the ${MAX_BYTES} limit`);
  }
  const text = await response.text();
  return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
}
