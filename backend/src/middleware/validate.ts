import type { ZodType, ZodTypeDef } from 'zod';
import { AppError, formatZodIssues } from '../utils/errors.js';

/** Parse untrusted input with a Zod schema or throw a 400 AppError with field-level details. */
export function parseOrThrow<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown, what: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw AppError.badRequest(`Invalid ${what}`, formatZodIssues(result.error.issues));
  return result.data;
}
