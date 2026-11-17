import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCollectHour, isQuietHour, judgeSlot, overviewDue, weekOf } from '../src/time.ts';

const at = (iso: string) => new Date(iso);

test('judge slots on an ordinary day (EET, UTC+2)', () => {
  assert.equal(judgeSlot(at('2026-11-17T04:59Z')), '2026-11-16T21'); // 06:59
  assert.equal(judgeSlot(at('2026-11-17T05:00Z')), '2026-11-17T07'); // 07:00
  assert.equal(judgeSlot(at('2026-11-17T09:59Z')), '2026-11-17T07'); // 11:59
  assert.equal(judgeSlot(at('2026-11-17T10:03Z')), '2026-11-17T12');
  assert.equal(judgeSlot(at('2026-11-17T15:03Z')), '2026-11-17T17');
  assert.equal(judgeSlot(at('2026-11-17T19:03Z')), '2026-11-17T21');
  assert.equal(judgeSlot(at('2026-11-17T21:59Z')), '2026-11-17T21'); // 23:59
});

test('judge slots across the end of summer time, 2026-10-25', () => {
  // 03:00 EEST becomes 03:00 EET at 01:00 UTC.
  assert.equal(judgeSlot(at('2026-10-25T03:59Z')), '2026-10-24T21'); // 05:59 EET
  assert.equal(judgeSlot(at('2026-10-25T05:00Z')), '2026-10-25T07'); // 07:00 EET
  assert.equal(judgeSlot(at('2026-10-24T04:00Z')), '2026-10-24T07'); // 07:00 EEST the day before
});

test('judge slots across the start of summer time, 2027-03-28', () => {
  assert.equal(judgeSlot(at('2027-03-28T04:00Z')), '2027-03-28T07'); // 07:00 EEST
  assert.equal(judgeSlot(at('2027-03-28T03:59Z')), '2027-03-27T21'); // 06:59 EEST
  assert.equal(judgeSlot(at('2027-03-27T05:00Z')), '2027-03-27T07'); // 07:00 EET the day before
});

test('a late run still lands in its slot', () => {
  // The 12:03 run was dropped; the 12:53 one is in the same slot, the 13:13 one too.
  assert.equal(judgeSlot(at('2026-11-17T10:53Z')), '2026-11-17T12');
  assert.equal(judgeSlot(at('2026-11-17T11:13Z')), '2026-11-17T12');
});

test('collection and quiet hours', () => {
  assert.equal(isCollectHour(at('2026-11-17T03:59Z')), false); // 05:59
  assert.equal(isCollectHour(at('2026-11-17T04:00Z')), true); // 06:00
  assert.equal(isCollectHour(at('2026-11-17T20:59Z')), true); // 22:59
  assert.equal(isCollectHour(at('2026-11-17T21:00Z')), false); // 23:00
  assert.equal(isQuietHour(at('2026-11-17T19:59Z')), false); // 21:59
  assert.equal(isQuietHour(at('2026-11-17T20:00Z')), true); // 22:00
  assert.equal(isQuietHour(at('2026-11-17T05:59Z')), true); // 07:59
  assert.equal(isQuietHour(at('2026-11-17T06:00Z')), false); // 08:00
  assert.equal(isQuietHour(at('2026-07-01T05:00Z')), false); // 08:00 EEST
});

test('weeks start on Monday in Tallinn', () => {
  assert.equal(weekOf(at('2026-11-17T12:00Z')), '2026-11-16');
  assert.equal(weekOf(at('2026-11-15T21:59Z')), '2026-11-09'); // Sunday 23:59
  assert.equal(weekOf(at('2026-11-15T22:00Z')), '2026-11-16'); // Monday 00:00
  // The week of the DST change: Sunday 2026-10-25 23:30 EET is still that week.
  assert.equal(weekOf(at('2026-10-25T21:30Z')), '2026-10-19');
  assert.equal(weekOf(at('2026-10-25T22:00Z')), '2026-10-26');
  assert.equal(weekOf(at('2027-03-28T20:59Z')), '2027-03-22'); // Sunday 23:59 EEST
  assert.equal(weekOf(at('2027-03-28T21:00Z')), '2027-03-29');
});

test('the overview is due from Sunday 18:00, once a week', () => {
  assert.equal(overviewDue(at('2026-11-22T15:59Z'), null), false); // 17:59
  assert.equal(overviewDue(at('2026-11-22T16:03Z'), null), true); // 18:03
  assert.equal(overviewDue(at('2026-11-22T16:13Z'), '2026-11-16'), false);
  assert.equal(overviewDue(at('2026-11-23T06:00Z'), '2026-11-09'), false); // Monday
  assert.equal(overviewDue(at('2026-10-25T16:03Z'), null), true); // 18:03 EET on the DST day
  assert.equal(overviewDue(at('2026-10-25T15:03Z'), null), false); // 17:03 EET
});
