-- Human label, distinct from the immutable `name` slug used in URLs,
-- bucket prefixes, and the Convex --instance-name arg. NULL means "no
-- separate label set, UI should fall back to the slug".
ALTER TABLE instances ADD COLUMN display_name TEXT;
