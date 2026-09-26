// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBand, units } from './band.mjs';

test('center and symmetric halfway quotes preserve public parameters', () => {
  assert.equal(calculateBand(0).cap, 50n);
  assert.equal(calculateBand(0).premium, 8000000n);
  for (const deviation of [-250, 250]) {
    const quote = calculateBand(deviation);
    assert.equal(quote.cap, 25n);
    assert.equal(quote.extraBps, 500n);
    assert.equal(quote.premium, 8400000n);
  }
});
test('whole-contract floor closes the band before the numerical edge', () => {
  assert.equal(calculateBand(490).cap, 1n);
  for (const deviation of [-700, -500, -499, 491, 500, 510, 700]) {
    assert.equal(calculateBand(deviation).reason, 'OutsideBand');
    assert.equal(calculateBand(deviation).premium, null);
  }
});
test('deadline and original anchor independently block an open band', () => {
  assert.equal(calculateBand(0, true).reason, 'QuoteExpired');
  assert.equal(calculateBand(0, false, true).reason, 'QuoteOffAnchor');
  assert.equal(calculateBand(-250, false, true).reason, null);
  assert.equal(calculateBand(510, true, true).reason, 'OutsideBand');
});
test('token formatting preserves integers beyond JavaScript safe-number limits', () => {
  assert.equal(units('29999999999999999999'), '29.9999');
  assert.equal(units('123456789012345678901234567890', 18), '123,456,789,012.3456');
  assert.equal(units('-1250000', 6), '−1.25');
  assert.equal(units('5', 0), '5');
});
