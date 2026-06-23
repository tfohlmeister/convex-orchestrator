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

// Free-form human label. Empty string is allowed (the route handler
// normalises empty to null, which means "fall back to the slug in the
// UI"). 64-char cap to keep table layouts predictable.
export const DisplayNameSchema = z.string().max(64);

export const CreateInstanceSchema = z.object({
  name: InstanceNameSchema,
  displayName: DisplayNameSchema.optional(),
});

export const SetDisplayNameSchema = z.object({
  displayName: DisplayNameSchema,
});

export const DeleteConfirmSchema = z.object({
  confirmName: InstanceNameSchema,
});

export const LogsQuerySchema = z.object({
  stream: z.enum(['stdout', 'stderr']).default('stdout'),
  tail: z.coerce.number().int().min(1).max(10_000).default(100),
});

// All fields optional so the UI can PATCH any subset. `null` for cron /
// retention / enabled clears the override back to the orchestrator default.
export const BackupConfigSchema = z
  .object({
    cron: z.string().min(1).nullable().optional(),
    retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
    enabled: z.boolean().nullable().optional(),
  })
  .strict();

// Per-instance scheduled-restart config. `null` cron clears the override
// back to RESTART_DEFAULT_CRON; `null` enabled clears the opt-in.
export const RestartConfigSchema = z
  .object({
    cron: z.string().min(1).nullable().optional(),
    enabled: z.boolean().nullable().optional(),
  })
  .strict();

export const RestoreSchema = z.object({
  backupId: z.string().min(1),
  confirmName: InstanceNameSchema,
});

export type CreateInstanceInput = z.infer<typeof CreateInstanceSchema>;
export type SetDisplayNameInput = z.infer<typeof SetDisplayNameSchema>;
export type DeleteConfirmInput = z.infer<typeof DeleteConfirmSchema>;
export type LogsQuery = z.infer<typeof LogsQuerySchema>;
export type BackupConfigInput = z.infer<typeof BackupConfigSchema>;
export type RestartConfigInput = z.infer<typeof RestartConfigSchema>;
export type RestoreInput = z.infer<typeof RestoreSchema>;
