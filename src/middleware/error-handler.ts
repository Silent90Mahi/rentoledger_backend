import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { config } from '../config/env.js';
import { AppError, isPgError, PG_ERRORS, type ErrorCode, type ErrorDetail } from '../lib/errors.js';

interface ErrorBody {
  success: false;
  error: { code: ErrorCode; message: string; details?: ErrorDetail[]; requestId?: string };
}

function send(res: Response, status: number, code: ErrorCode, message: string, details?: ErrorDetail[]): void {
  const body: ErrorBody = { success: false, error: { code, message } };
  if (details?.length) body.error.details = details;
  const requestId = res.getHeader('x-request-id');
  if (typeof requestId === 'string') body.error.requestId = requestId;
  res.status(status).json(body);
}

export function notFoundHandler(req: Request, res: Response): void {
  send(res, 404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found.`);
}

/**
 * Converts every error into the standard `{ success: false, error }` envelope.
 * Unexpected errors are logged with the request and reported generically.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    req.log?.error({ err }, 'Error after response was sent');
    return;
  }

  if (err instanceof AppError) {
    if (err.status >= 500) req.log?.error({ err }, err.message);
    send(res, err.status, err.code, err.message, err.details);
    return;
  }

  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ field: i.path.join('.') || undefined, message: i.message }));
    send(res, 400, 'VALIDATION_ERROR', details[0]?.message ?? 'Invalid request.', details);
    return;
  }

  // body-parser / express errors
  const httpErr = err as { type?: string; status?: number; statusCode?: number };
  if (httpErr?.type === 'entity.parse.failed') {
    send(res, 400, 'BAD_REQUEST', 'Request body is not valid JSON.');
    return;
  }
  if (httpErr?.type === 'entity.too.large') {
    send(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    return;
  }

  if (isPgError(err)) {
    switch (err.code) {
      case PG_ERRORS.UNIQUE_VIOLATION:
        send(res, 409, 'CONFLICT', 'A record with the same details already exists.');
        return;
      case PG_ERRORS.FOREIGN_KEY_VIOLATION:
        send(res, 409, 'CONFLICT', 'This record is linked to other records and cannot be changed this way.');
        return;
      case PG_ERRORS.CHECK_VIOLATION:
      case PG_ERRORS.NOT_NULL_VIOLATION:
      case PG_ERRORS.INVALID_TEXT_REPRESENTATION:
      case PG_ERRORS.INVALID_DATETIME:
      case PG_ERRORS.DATETIME_OVERFLOW:
      case PG_ERRORS.NUMERIC_OUT_OF_RANGE:
      case PG_ERRORS.STRING_TOO_LONG:
        req.log?.warn({ err }, 'Database rejected input');
        send(res, 400, 'VALIDATION_ERROR', 'Some values are invalid or out of range.');
        return;
      default:
        break;
    }
  }

  const status = httpErr?.status ?? httpErr?.statusCode;
  if (status && status >= 400 && status < 500) {
    send(res, status, 'BAD_REQUEST', (err as Error).message || 'Bad request.');
    return;
  }

  req.log?.error({ err }, 'Unhandled error');
  send(
    res,
    500,
    'INTERNAL_ERROR',
    config.isProduction ? 'Something went wrong. Please try again.' : `Internal error: ${(err as Error)?.message ?? String(err)}`,
  );
}
