import { badRequest } from './errors.js';

/**
 * Tiny hand-rolled request validation. A schema library (zod) would do this, but
 * the rules here are few and the brief rewards code I can explain line by line.
 * Every helper throws an HttpError, so routes stay free of validation branches.
 */

export function asObject(value: unknown, what = 'request body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`"${key}" must be a string`);
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > maxLength) {
    throw badRequest(`"${key}" must be at most ${maxLength} characters, got ${trimmed.length}`);
  }
  return trimmed;
}

export function optionalStringArray(
  body: Record<string, unknown>,
  key: string,
  maxItems: number,
): string[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw badRequest(`"${key}" must be an array of strings`);
  if (value.length > maxItems) throw badRequest(`"${key}" must have at most ${maxItems} items`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw badRequest(`"${key}[${index}]" must be a non-empty string`);
    }
    return item.trim();
  });
}

/** Route params arrive as strings; ids must be positive integers. */
export function parseId(raw: string | undefined, what = 'id'): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw badRequest(`"${what}" must be a positive integer, got "${raw}"`);
  }
  return value;
}
