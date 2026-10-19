/**
 * Minimal Markdown and HTML handling. No parser dependency: the system only needs a
 * title, a plain-text body and tags. Anything more would be scope the brief rules out.
 */

/** Takes the first `# Heading` as the title, else the first non-empty line, trimmed. */
export function extractTitle(markdown: string): string | undefined {
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(trimmed);
    return clampTitle(heading?.[1] ?? trimmed);
  }
  return undefined;
}

function clampTitle(value: string): string {
  const clean = stripInlineMarkdown(value).trim();
  return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
}

/** Strips the markers that would otherwise leak into social text, keeping link labels. */
export function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images: keep the alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links: keep the label
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '');
}

/**
 * The body as plain prose: headings, code fences, images and list markers removed.
 * This is what the generator reads, so a code block never ends up in a tweet.
 */
export function toPlainText(markdown: string): string {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, ' ');
  return stripInlineMarkdown(withoutCode)
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+\.\s+/gm, '')
    .replace(/^\s{0,3}([-*_]\s?){3,}$/gm, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Converts a fetched HTML page into Markdown-ish text good enough to generate from. */
export function htmlToMarkdown(html: string): { title: string | undefined; body: string } {
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];

  // Prefer <article> or <main>: it keeps navigation and footers out of the body.
  const main =
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ??
    /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ??
    /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ??
    html;

  const body = main
    .replace(/<(script|style|noscript|nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|section|blockquote)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return {
    title: decodeEntities(h1 ?? titleTag ?? '').trim() || undefined,
    body: decodeEntities(body).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  };
  return value
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}
