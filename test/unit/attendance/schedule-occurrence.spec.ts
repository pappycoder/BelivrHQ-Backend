/**
 * @file schedule-occurrence.spec.ts
 * @description Unit tests for service/event schedule date maths.
 *
 * @module test/unit/attendance/schedule-occurrence.spec
 * @since 1.0.0
 */

import { BadRequestException } from '@nestjs/common';
import {
  assertEventOccursOn,
  assertServiceOccursOn,
  assertServiceSchedule,
  dateOnly,
  eventOccursOn,
  serviceOccursOn,
} from '../../../src/attendance/schedule-occurrence';

describe('schedule occurrence helpers', () => {
  const sunday = '2026-10-18';
  const monday = '2026-10-19';

  describe('serviceOccursOn', () => {
    it('treats legacy rows without recurrence as indefinite weekly schedules', () => {
      expect(serviceOccursOn({ day_of_week: 0 }, sunday)).toBe(true);
      expect(serviceOccursOn({ day_of_week: 0 }, monday)).toBe(false);
    });

    it('accepts every weekday when the recurring service has no weekday', () => {
      expect(serviceOccursOn({ recurrence: 'weekly', day_of_week: null }, monday)).toBe(true);
    });

    it('respects weekly start and end bounds inclusively', () => {
      const schedule = {
        recurrence: 'weekly',
        day_of_week: 0,
        starts_on: new Date('2026-10-04T00:00:00.000Z'),
        ends_on: new Date('2026-10-18T00:00:00.000Z'),
      };
      expect(serviceOccursOn(schedule, '2026-10-04')).toBe(true);
      expect(serviceOccursOn(schedule, sunday)).toBe(true);
      expect(serviceOccursOn(schedule, '2026-10-25')).toBe(false);
      expect(serviceOccursOn(schedule, '2026-09-27')).toBe(false);
    });

    it('only accepts the start day for a one-time service', () => {
      const schedule = {
        recurrence: 'one_time',
        day_of_week: 0,
        starts_on: '2026-10-18',
      };
      expect(serviceOccursOn(schedule, sunday)).toBe(true);
      expect(serviceOccursOn(schedule, monday)).toBe(false);
      expect(serviceOccursOn({ recurrence: 'one_time' }, sunday)).toBe(false);
    });

    it('accepts every day in a multi-day range inclusively', () => {
      const schedule = {
        recurrence: 'multi_day',
        starts_on: '2026-10-18',
        ends_on: '2026-10-21',
      };
      expect(serviceOccursOn(schedule, sunday)).toBe(true);
      expect(serviceOccursOn(schedule, '2026-10-21')).toBe(true);
      expect(serviceOccursOn(schedule, '2026-10-22')).toBe(false);
      expect(serviceOccursOn(schedule, '2026-10-17')).toBe(false);
    });
  });

  describe('eventOccursOn', () => {
    const oneTime = {
      recurrence: 'one_time',
      start_date: new Date('2026-10-18T09:00:00.000Z'),
      end_date: new Date('2026-10-20T12:00:00.000Z'),
    };

    it('accepts every day inside a one-time window', () => {
      expect(eventOccursOn(oneTime, sunday)).toBe(true);
      expect(eventOccursOn(oneTime, '2026-10-20')).toBe(true);
      expect(eventOccursOn(oneTime, '2026-10-21')).toBe(false);
      expect(eventOccursOn(oneTime, '2026-10-17')).toBe(false);
    });

    it('defaults missing recurrence to a one-time window', () => {
      expect(eventOccursOn({ start_date: '2026-10-18' }, '2026-10-19')).toBe(true);
    });

    it('repeats weekly on the start weekday and stops at the end date', () => {
      const weekly = {
        recurrence: 'weekly',
        start_date: new Date('2026-10-18T09:00:00.000Z'),
        end_date: new Date('2026-11-08T12:00:00.000Z'),
      };
      expect(eventOccursOn(weekly, '2026-10-25')).toBe(true);
      expect(eventOccursOn(weekly, '2026-11-08')).toBe(true);
      expect(eventOccursOn(weekly, '2026-11-15')).toBe(false);
      expect(eventOccursOn(weekly, monday)).toBe(false);
    });

    it('repeats weekly indefinitely with no end date', () => {
      const weekly = {
        recurrence: 'weekly',
        start_date: '2026-10-18',
        end_date: null,
      };
      expect(eventOccursOn(weekly, '2027-04-18')).toBe(true);
      expect(eventOccursOn(weekly, '2027-04-19')).toBe(false);
    });
  });

  describe('assertServiceSchedule', () => {
    it('normalises a one-time schedule and clears its end bound', () => {
      expect(
        assertServiceSchedule({
          recurrence: 'one_time',
          startsOn: '2026-10-18',
          endsOn: '2026-10-20',
        }),
      ).toEqual({
        recurrence: 'one_time',
        startsOn: dateOnly('2026-10-18'),
        endsOn: null,
      });
    });

    it('defaults to weekly when no recurrence is supplied', () => {
      expect(assertServiceSchedule({ startsOn: null, endsOn: null })).toEqual({
        recurrence: 'weekly',
        startsOn: null,
        endsOn: null,
      });
    });

    it('rejects one-time schedules without a start date', () => {
      expect(() => assertServiceSchedule({ recurrence: 'one_time' })).toThrow(BadRequestException);
    });

    it('rejects multi-day schedules missing either bound', () => {
      expect(() =>
        assertServiceSchedule({ recurrence: 'multi_day', startsOn: '2026-10-18' }),
      ).toThrow('start and end date');
    });

    it('rejects an end date before the start date', () => {
      expect(() =>
        assertServiceSchedule({
          recurrence: 'multi_day',
          startsOn: '2026-10-20',
          endsOn: '2026-10-18',
        }),
      ).toThrow('on or after');
    });
  });

  describe('assert helpers', () => {
    it('raises the friendly message the API returns', () => {
      expect(() => assertServiceOccursOn('Sunday Service', { day_of_week: 0 }, monday)).toThrow(
        'Sunday Service does not meet on 2026-10-19',
      );
      expect(() =>
        assertEventOccursOn(
          'Conference',
          { start_date: '2026-10-18', end_date: '2026-10-18' },
          monday,
        ),
      ).toThrow('Conference does not occur on 2026-10-19');
    });
  });
});
