-- Per-instance scheduled-restart config. Restarting the backend on a cron
-- reclaims the Node executor's V8/heap memory that self-hosted Convex does
-- not release at runtime (a long-lived backend + executor grow unbounded;
-- only a process restart frees the memory). Opt-in per instance.
--
-- restart_cron    NULL = use RESTART_DEFAULT_CRON when enabled.
-- restart_enabled NULL/0 = no scheduled restart. 1 = active.
ALTER TABLE instances ADD COLUMN restart_cron TEXT;
ALTER TABLE instances ADD COLUMN restart_enabled INTEGER;
