import test from 'node:test';
import assert from 'node:assert/strict';
import {DAY, MINUTE, effectiveStep, darknessIntervals, longestDarkness, earliestWindow} from '../src/mission.js';

test('longest uninterrupted darkness interpolates and clips to mission bounds', () => {
  const intervals = darknessIntervals([
    {t: 0, sm: 1}, {t: 10, sm: -1}, {t: 20, sm: -1}, {t: 30, sm: 1},
    {t: 40, sm: -1}, {t: 50, sm: -1},
  ]);
  assert.deepEqual(intervals, [{start: 5, end: 25}, {start: 35, end: 50}]);
  assert.deepEqual(longestDarkness(intervals, 15, 47), {start: 35, end: 47});
});

test('find the earliest minute of a feasible equal-duration mission', () => {
  const darkness = [{start: 2 * DAY, end: 7 * DAY}, {start: 7.5 * DAY, end: 13 * DAY}];
  assert.equal(earliestWindow(darkness, MINUTE, 20 * DAY, 5 * DAY, 2 * DAY), 11 * DAY);
  assert.equal(earliestWindow(darkness, MINUTE, 10 * DAY, 5 * DAY, 2 * DAY), null);
  assert.equal(earliestWindow(darkness, MINUTE, 10 * DAY, DAY, DAY), MINUTE);
  assert.equal(earliestWindow([{start: 0, end: 20 * DAY}], MINUTE, DAY, 4 * DAY, 0), null);
});

test('365-day missions keep ephemeris requests below the row cap', () => {
  assert.equal(effectiveStep(365 * DAY, 1), 36);
  assert.equal(effectiveStep(365 * DAY, 60), 60);
  assert.equal(effectiveStep(DAY, 1), 1);
});

test('Earth outage uses Earth visibility and interpolates both boundary times', () => {
  const samples = [
    {t: 0, sm: -1, em: 2},
    {t: 12, sm: -1, em: -1},
    {t: 24, sm: 1, em: -2},
    {t: 36, sm: 1, em: 2},
  ];
  assert.deepEqual(longestDarkness(darknessIntervals(samples, 'em'), 0, 36), {start: 8, end: 30});
  assert.deepEqual(darknessIntervals([{t: 0, em: 1}, {t: 36, em: 2}], 'em'), []);
});
