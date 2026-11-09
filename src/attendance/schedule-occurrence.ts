/**
 * @file schedule-occurrence.ts
 * @description Shared date maths for service schedules and recurring events.
 *
 * A service can repeat weekly (the historical behaviour), happen once, or run
 * across a bounded multi-day window. Events follow the same rules: once on a
 * single day, across a bounded multi-day window, or weekly on their start
 * weekday. Check-in calls use these helpers to reject dates that the schedule
 * never occurs on; create/update calls use the assert helpers to reject
 * schedules that mix the modes up.
 *
 * @module attendance/schedule-occurrence
 * @since 1.0.0
 */

import { BadRequestException } from '@nestjs/common';

/** Recurrence modes a service schedule can use. */
export const SCHEDULE_RECURRENCES = ['weekly', 'one_time', 'multi_day'] as const;
export type ScheduleRecurrence = (typeof SCHEDULE_RECURRENCES)[number];

/** Events happen once, repeat weekly, or run across a bounded multi-day window. */
export const EVENT_RECURRENCES = ['one_time', 'weekly', 'multi_day'] as const;
export type EventRecurrence = (typeof EVENT_RECURRENCES)[number];

export interface ServiceSchedule {
  recurrence?: string | null;
  day_of_week?: number | null;
  starts_on?: Date | string | null;
  ends_on?: Date | string | null;
}

export interface EventSchedule {
  recurrence?: string | null;
  start_date: Date | string;
  end_date?: Date | string | null;
}

/** Normalises a Date or YYYY-MM-DD string to a UTC day key. */
export function dayKey(value: Date | string): string {
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    return new Date(value).toISOString().slice(0, 10);
  }
  return value.toISOString().slice(0, 10);
}

/** Weekday (0=Sunday) for a UTC day key. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

/** Converts a day key to the UTC-midnight Date stored in `@db.Date` columns. */
export function dateOnly(value: Date | string): Date {
  return new Date(`${dayKey(value)}T00:00:00.000Z`);
}

/**
 * Whether a service meets on the supplied calendar day.
 *
 * - weekly: every matching `day_of_week` inside the optional `[starts_on, ends_on]`
 *   window. A null weekday means any day.
 * - one_time: exactly `starts_on`.
 * - multi_day: every day from `starts_on` through `ends_on` inclusive.
 */
export function serviceOccursOn(schedule: ServiceSchedule, date: string): boolean {
  const recurrence = (schedule.recurrence || 'weekly') as ScheduleRecurrence;
  const start = schedule.starts_on ? dayKey(schedule.starts_on) : null;
  const end = schedule.ends_on ? dayKey(schedule.ends_on) : null;

  if (start && date < start) return false;
  if (end && date > end) return false;

  if (recurrence === 'one_time') return start !== null && date === start;
  if (recurrence === 'multi_day')
    return start !== null && end !== null && date >= start && date <= end;

  if (schedule.day_of_week == null) return true;
  return weekdayOf(date) === schedule.day_of_week;
}

/**
 * Whether an event occurs on the supplied calendar day.
 *
 * - one_time: exactly the day of `start_date` (a same-day `end_date` only
 *   carries the end time, not extra days — multi-day windows are `multi_day`).
 * - multi_day: every day from `start_date` through `end_date` inclusive.
 * - weekly: the same weekday as `start_date`, from `start_date` through
 *   `end_date` when present, otherwise indefinitely.
 */
export function eventOccursOn(schedule: EventSchedule, date: string): boolean {
  const start = dayKey(schedule.start_date);
  const end = schedule.end_date ? dayKey(schedule.end_date) : null;

  if (date < start) return false;
  if (end && date > end) return false;

  const recurrence = (schedule.recurrence || 'one_time') as EventRecurrence;
  if (recurrence === 'weekly') return weekdayOf(date) === weekdayOf(start);
  if (recurrence === 'multi_day') return end !== null && date >= start && date <= end;

  return date === start;
}

/**
 * Cross-field validation for an event schedule — the event twin of
 * `assertServiceSchedule`. `startDate`/`endDate` stay full timestamps (events
 * carry wall-clock times); the rules run on their UTC day keys. A same-day
 * `endDate` is kept for one-time events (it carries the end time).
 */
export function assertEventSchedule(input: {
  recurrence?: string | null;
  startDate: Date | string;
  endDate?: Date | string | null;
}): { recurrence: EventRecurrence } {
  const recurrence = (input.recurrence || 'one_time') as EventRecurrence;
  if (!(EVENT_RECURRENCES as readonly string[]).includes(recurrence))
    throw new BadRequestException('Choose a valid event recurrence');

  const start = dayKey(input.startDate);
  const end = input.endDate ? dayKey(input.endDate) : null;

  if (recurrence === 'one_time' && end && end !== start)
    throw new BadRequestException(
      'A one-time event happens on a single day. Choose Date range for multiple days',
    );
  if (recurrence === 'multi_day' && !end)
    throw new BadRequestException('A date-range event needs a start and end date');
  if (end && end < start)
    throw new BadRequestException('The end date must be on or after the start date');

  return { recurrence };
}

/** Cross-field validation for a service schedule. */
export function assertServiceSchedule(input: {
  recurrence?: string | null;
  startsOn?: Date | string | null;
  endsOn?: Date | string | null;
}): { recurrence: ScheduleRecurrence; startsOn: Date | null; endsOn: Date | null } {
  const recurrence = (input.recurrence || 'weekly') as ScheduleRecurrence;
  if (!SCHEDULE_RECURRENCES.includes(recurrence))
    throw new BadRequestException('Choose a valid service recurrence');

  const startsOn = input.startsOn ? dateOnly(input.startsOn) : null;
  const endsOn = input.endsOn ? dateOnly(input.endsOn) : null;

  if (recurrence === 'one_time' && !startsOn)
    throw new BadRequestException('A one-time service needs a start date');
  if (recurrence === 'multi_day' && (!startsOn || !endsOn))
    throw new BadRequestException('A date-range service needs a start and end date');
  if (startsOn && endsOn && endsOn < startsOn)
    throw new BadRequestException('The end date must be on or after the start date');

  return {
    recurrence,
    startsOn,
    endsOn: recurrence === 'one_time' ? null : endsOn,
  };
}

/** Rejects a date the service does not meet on. */
export function assertServiceOccursOn(name: string, schedule: ServiceSchedule, date: string): void {
  if (!serviceOccursOn(schedule, date))
    throw new BadRequestException(`${name} does not meet on ${date}`);
}

/** Rejects a date the event does not occur on. */
export function assertEventOccursOn(name: string, schedule: EventSchedule, date: string): void {
  if (!eventOccursOn(schedule, date))
    throw new BadRequestException(`${name} does not occur on ${date}`);
}

/**
 * The first UTC-midnight day on or after `from` that the event occurs on, or
 * null when the schedule produces no further occurrence. Lets "upcoming"
 * consumers present recurring events by their NEXT date, even months out.
 */
export function nextEventOccurrence(schedule: EventSchedule, from: Date = new Date()): Date | null {
  const fromKey = dayKey(from);
  const startKey = dayKey(schedule.start_date);
  const endKey = schedule.end_date ? dayKey(schedule.end_date) : null;
  const recurrence = (schedule.recurrence || 'one_time') as EventRecurrence;

  if (endKey && endKey < fromKey) return null;
  if (recurrence === 'one_time') return startKey >= fromKey ? dateOnly(startKey) : null;
  if (recurrence === 'multi_day') {
    if (!endKey) return null;
    return dateOnly(startKey >= fromKey ? startKey : fromKey);
  }

  const targetWeekday = weekdayOf(startKey);
  const cursor = new Date(`${startKey >= fromKey ? startKey : fromKey}T00:00:00.000Z`);
  for (let i = 0; i < 7; i += 1) {
    const key = cursor.toISOString().slice(0, 10);
    if (weekdayOf(key) === targetWeekday && (!endKey || key <= endKey)) return cursor;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return null;
}
