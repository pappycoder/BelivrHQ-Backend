-- Add recurrence windows to service schedules and events.
-- Additive only: existing rows keep their current behaviour. Services default to
-- the indefinite weekly rhythm they already followed; events default to one-time
-- because a start/end window described a single occurrence before this change.

BEGIN;

ALTER TABLE "services"
  ADD COLUMN "recurrence" TEXT NOT NULL DEFAULT 'weekly',
  ADD COLUMN "starts_on" DATE,
  ADD COLUMN "ends_on" DATE;

ALTER TABLE "events"
  ADD COLUMN "recurrence" TEXT NOT NULL DEFAULT 'one_time';

COMMIT;
