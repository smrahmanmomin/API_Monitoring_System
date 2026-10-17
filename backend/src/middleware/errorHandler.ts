import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors.js';

interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `Route ${req.method} ${req.path} does not exist`));
};

/**
 * Centralised error → response mapping. Response shape is always
 * `{ error: { code, message, details?, request_id } }`; stack traces are never returned in production.
 */
export function createErrorHandler(isProduction: boolean): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    const requestId = String(req.id ?? '');
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown;

    const bodyError = err as BodyParserError;
    if (err instanceof AppError) {
      ({ status, code, message } = err);
      details = err.details;
    } else if (bodyError?.type === 'entity.parse.failed') {
      status = 400;
      code = 'MALFORMED_JSON';
      message = 'Request body is not valid JSON';
    } else if (bodyError?.type === 'entity.too.large') {
      status = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'Request body exceeds the size limit';
    } else if (bodyError?.type === 'encoding.unsupported' || bodyError?.type === 'charset.unsupported') {
      status = 415;
      code = 'UNSUPPORTED_ENCODING';
      message = 'Unsupported request encoding';
    } else if (err instanceof Prisma.PrismaClientInitializationError || (err instanceof Prisma.PrismaClientKnownRequestError && err.code.startsWith('P1'))) {
      status = 503;
      code = 'DATABASE_UNAVAILABLE';
      message = 'The database is temporarily unavailable';
    }

    if (status >= 500) req.log?.error({ err }, 'request failed');
    else req.log?.warn({ code, status }, 'request rejected');

    res.status(status).json({
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
        request_id: requestId,
        ...(!isProduction && status >= 500 && err instanceof Error ? { debug: err.message } : {}),
      },
    });
  };
}
