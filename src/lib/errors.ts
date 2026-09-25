export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'TOKEN_EXPIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'TOO_MANY_REQUESTS'
  | 'PAYLOAD_TOO_LARGE'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ErrorDetail {
  field?: string;
  message: string;
}

/**
 * An error that is safe to expose to API clients. Anything that is not an
 * AppError is treated as an unexpected failure and reported generically.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: ErrorDetail[];

  constructor(status: number, code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  badRequest: (message: string, details?: ErrorDetail[]) => new AppError(400, 'BAD_REQUEST', message, details),
  validation: (message: string, details?: ErrorDetail[]) => new AppError(400, 'VALIDATION_ERROR', message, details),
  unauthorized: (message = 'Authentication required.') => new AppError(401, 'UNAUTHORIZED', message),
  tokenExpired: () => new AppError(401, 'TOKEN_EXPIRED', 'Your session has expired. Please sign in again.'),
  forbidden: (message = 'You do not have permission to perform this action.') => new AppError(403, 'FORBIDDEN', message),
  notFound: (entity = 'Resource') => new AppError(404, 'NOT_FOUND', `${entity} not found.`),
  conflict: (message: string, details?: ErrorDetail[]) => new AppError(409, 'CONFLICT', message, details),
  unprocessable: (message: string, details?: ErrorDetail[]) => new AppError(422, 'UNPROCESSABLE', message, details),
  tooMany: (message = 'Too many requests. Please try again later.') => new AppError(429, 'TOO_MANY_REQUESTS', message),
  unavailable: (message = 'Service temporarily unavailable.') => new AppError(503, 'SERVICE_UNAVAILABLE', message),
};
