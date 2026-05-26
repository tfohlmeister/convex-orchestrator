import { z } from 'zod';

const RESERVED = new Set(['dashboard', 'api', '_internal', 'orchestrator', 'traefik']);
const NAME_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export const InstanceNameSchema = z
  .string()
  .min(3)
  .max(32)
  .refine((s) => NAME_RE.test(s), {
    message: 'must be lowercase-kebab-case, 3-32 chars, starting with a letter',
  })
  .refine((s) => !RESERVED.has(s), { message: 'reserved name' });

export const CreateInstanceSchema = z.object({
  name: InstanceNameSchema,
});

export const DeleteConfirmSchema = z.object({
  confirmName: InstanceNameSchema,
});

export const LogsQuerySchema = z.object({
  stream: z.enum(['stdout', 'stderr']).default('stdout'),
  tail: z.coerce.number().int().min(1).max(10_000).default(100),
});

export type CreateInstanceInput = z.infer<typeof CreateInstanceSchema>;
export type DeleteConfirmInput = z.infer<typeof DeleteConfirmSchema>;
export type LogsQuery = z.infer<typeof LogsQuerySchema>;
