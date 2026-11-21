'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { _internal } = require('../providers/onetouchtv');
const { findBestOttMatch, splitTitleYear } = _internal;

const row = (title, extra = {}) => ({ id: title, title, type: 'movie', ...extra });

test('splitTitleYear strips only a trailing " (YYYY)"', () => {
    assert.deepStrictEqual(splitTitleYear('RRR (2022)'), { title: 'RRR', year: 2022 });
    assert.deepStrictEqual(splitTitleYear('RRR'), { title: 'RRR', year: null });
    assert.deepStrictEqual(splitTitleYear('1917 Remastered'), { title: '1917 Remastered', year: null });
});

test('"RRR (2022)" matches RRR 2022 (and a year one off)', () => {
    assert.strictEqual(findBestOttMatch([row('RRR (2022)')], 'RRR', 2022, 'movie')?.id, 'RRR (2022)');
    assert.strictEqual(findBestOttMatch([row('RRR (2022)')], 'RRR', 2021, 'movie')?.id, 'RRR (2022)');
    assert.strictEqual(findBestOttMatch([row('RRR (2022)')], 'RRR', null, 'movie')?.id, 'RRR (2022)');
});

test('"RRR (1999)" does not match RRR 2022', () => {
    assert.strictEqual(findBestOttMatch([row('RRR (1999)')], 'RRR', 2022, 'movie'), null);
    assert.strictEqual(findBestOttMatch([row('RRR (1999)'), row('RRR (2022)')], 'RRR', 2022, 'movie')?.id, 'RRR (2022)');
});

test('a short wrong title stays rejected', () => {
    assert.strictEqual(findBestOttMatch([row('RRRR (2022)')], 'RRR', 2022, 'movie'), null);
    assert.strictEqual(findBestOttMatch([row('RX 100 (2022)')], 'RRR', 2022, 'movie'), null);
    assert.strictEqual(findBestOttMatch([row('RRR 2 (2022)')], 'RRR', 2022, 'movie'), null);
});

test('the row year field keeps its exact rule', () => {
    assert.strictEqual(findBestOttMatch([row('RRR (2022)', { year: '2021' })], 'RRR', 2022, 'movie')?.id, 'RRR (2022)',
        'no survivor keeps all (unchanged findTitleMatch behaviour)');
    assert.strictEqual(findBestOttMatch([row('RRR (2022)', { year: '2021' }), row('RRR', { year: '2022', id: 'x' })], 'RRR', 2022, 'movie')?.id, 'x');
});
