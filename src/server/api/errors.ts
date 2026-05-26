import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';

export class OrchestratorError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof OrchestratorError) {
    return c.json(
      { error: err.message, code: err.code },
      err.status as 400 | 401 | 404 | 409 | 422,
    );
  }
  if (err instanceof ZodError) {
    return c.json(
      {
        error: err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
        code: 'VALIDATION_ERROR',
      },
      400,
    );
  }
  if (err instanceof HTTPException) {
    return c.json({ error: err.message, code: 'HTTP_ERROR' }, err.status);
  }
  // Log unexpected errors so they don't get silently swallowed.
  console.error('unhandled error in route:', err);
  return c.json({ error: 'internal error', code: 'INTERNAL' }, 500);
}
