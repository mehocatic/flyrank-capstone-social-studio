import type { NextFunction, Request, Response } from 'express';
import { redactError } from '../redact.js';

/**
 * One error shape for the whole API: { error, message, details? }.
 * Routes throw; this module turns throws into responses, so no route repeats
 * try/catch. Similar to an ASP.NET exception filter.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);
export const notFound = (message: string) => new HttpError(404, 'not_found', message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new HttpError(422, code, message, details);

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(notFound(`No route for ${req.method} ${req.path}`));
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({
      error: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
    return;
  }
  // Unexpected: log the real cause for us, return something generic to the client.
  // Redacted first, because an error thrown from a publish path can carry the
  // webhook URL in its message, and this log is the one place that prints an
  // arbitrary error in full.
  console.error(`[api] unhandled error: ${redactError(error)}`);
  res.status(500).json({ error: 'internal_error', message: 'Unexpected server error' });
}
