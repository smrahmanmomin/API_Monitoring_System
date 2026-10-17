/** Application error carrying an HTTP status and a stable, machine-readable code. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: unknown, code = 'VALIDATION_ERROR'): AppError {
    return new AppError(400, code, message, details);
  }

  static notFound(message: string): AppError {
    return new AppError(404, 'NOT_FOUND', message);
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError(409, 'INVALID_STATE_TRANSITION', message, details);
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Convert Zod issues to a compact, client-safe shape. */
export function formatZodIssues(issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>): ValidationIssue[] {
  return issues.map((issue) => ({ path: issue.path.join('.') || '(root)', message: issue.message }));
}

/** Prisma unique-constraint violation (used for the open-alert dedup race). */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002';
}
