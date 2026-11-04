-- Events follow the service schedule rules from here on: `one_time` now means
-- exactly one day. Events that historically relied on the old "one_time spans
-- the start…end window" meaning become explicit `multi_day` events, so their
-- check-in windows and calendars stay exactly as they were. Same-day end dates
-- (duration only) stay `one_time`.
UPDATE "events"
SET "recurrence" = 'multi_day'
WHERE "recurrence" = 'one_time'
  AND "end_date" IS NOT NULL
  AND (timezone('UTC', "end_date")::date) > (timezone('UTC', "start_date")::date);
