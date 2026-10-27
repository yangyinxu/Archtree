/**
 * The pure reader of a saved Track title's leading position (lookupTitlePositions.ts): which titles start with a Disc and Track
 * position, a Track position or none, and the Album guard under which positions count (every title has one, all in one form,
 * strictly increasing by Disc Number, a missing one as Disc 1, then Track Number; a lone title only with a Disc Number and a
 * zero-padded Track Number). The review page's number filling is meant to accept exactly this table. Titles are synthetic or
 * common song-title shapes; no network.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { leadingTitlePosition, leadingTitlePositions } from '../../src/administration/lookup/lookupTitlePositions';
import { installNetworkGuard } from '../support/networkGuard';

const guard = installNetworkGuard();
after(() => { guard.restore(); assert.deepEqual(guard.attempts, []); });

const at = (discNumber: number | null, trackNumber: number, rest: string) => ({ discNumber, trackNumber, rest });

test('a title starts with a Disc and Track position, a Track position, or none', () => {
    for (const [title, expected] of [
        ['1-01 Yorugaonokokuhaku(Live)', at(1, 1, 'Yorugaonokokuhaku(Live)')], ['1.01.雪の華', at(1, 1, '雪の華')],
        ['1.01. 創生(Instrumental)', at(1, 1, '創生(Instrumental)')], ['01 X', at(null, 1, 'X')], ['01 - X', at(null, 1, 'X')], ['01.X', at(null, 1, 'X')],
        ['001 X', at(null, 1, 'X')], [' 01  X', at(null, 1, 'X')], ['1-01 - X', at(1, 1, 'X')], ['1-01. X', at(1, 1, 'X')], ['99-999 X', at(99, 999, 'X')],
        ['2-12 Synthetic  Song ', at(2, 12, 'Synthetic Song')], ['7 Rings', at(null, 7, 'Rings')],
        // A spaced period, hyphen or dash goes with the position; a space before other punctuation leaves it in the rest.
        ['01 . X', at(null, 1, 'X')], ['01 \u2013 X', at(null, 1, 'X')], ['1-01 \u2014 X', at(1, 1, 'X')],
        ['01 ...Baby One More Time', at(null, 1, '...Baby One More Time')], ['01 -X', at(null, 1, '-X')]
    ] as const) assert.deepEqual(leadingTitlePosition(title), expected, title);
    // No position: numbers out of range or zero, no separator or text after it, another separator, full-width digits, a year.
    for (const title of ['100-01 X', '1000 X', '0 X', '1-0 X', '0-1 X', '01', '01.', '01X', '01-X', '01_X', '12) X', '１．０１．X', 'X', '1999 X', 'Room404', '7',
        `01 ${'x'.repeat(1022)}`]) {
        assert.equal(leadingTitlePosition(title), null, title);
    }
    for (const value of [null, undefined, 7, ['01 X'], { title: '01 X' }]) assert.equal(leadingTitlePosition(value), null, String(value));
});

test('positions count only when every title has one, all in one form, strictly increasing by Disc, a missing one as Disc 1, then Track; a lone title needs a padded Disc and Track', () => {
    assert.deepEqual(leadingTitlePositions(['1-01 A', '1-02 B']), [at(1, 1, 'A'), at(1, 2, 'B')]);
    assert.deepEqual(leadingTitlePositions(['1-01 A', '2-01 B']), [at(1, 1, 'A'), at(2, 1, 'B')]);
    assert.deepEqual(leadingTitlePositions(['1-01 A', '1.02.B', '1-03 - C']), [at(1, 1, 'A'), at(1, 2, 'B'), at(1, 3, 'C')]);
    assert.deepEqual(leadingTitlePositions(['01 A', '02.B', '03 - C']), [at(null, 1, 'A'), at(null, 2, 'B'), at(null, 3, 'C')]);
    assert.deepEqual(leadingTitlePositions(['1.01.雪の華', '1.02.WILL', '1.03.彩恋 ～SAI_REN～']), [at(1, 1, '雪の華'), at(1, 2, 'WILL'), at(1, 3, '彩恋 ～SAI_REN～')]);
    // Positions of both forms on one Album never count, whatever their order.
    for (const titles of [['01 A', '1-02 B'], ['1-02 A', '03 B'], ['1-01 A', '02 B', '1-03 C'], ['2-01 A', '05 B'], ['01 A', '01 B'], ['02 A', '01 B'], ['1-02 A', '1-02 B'], ['7 Rings', 'thank u, next'], ['7 Rings', '99 Luftballons', '24 Hours'],
        ['Room404', 'Room405'], [], ['01 A', null], ['01 A', 7], ['01 A', 'B']]) {
        assert.equal(leadingTitlePositions(titles), null, JSON.stringify(titles));
    }
    for (const value of [null, '01 A', { 0: '01 A', length: 1 }]) assert.equal(leadingTitlePositions(value as never), null, String(value));
    // A lone title counts only with a Disc Number and a zero-padded Track Number, so a single keeps a leading number or decimal.
    assert.deepEqual(leadingTitlePositions(['1-01 A']), [at(1, 1, 'A')]);
    assert.deepEqual(leadingTitlePositions(['1.01.雪の華']), [at(1, 1, '雪の華')]);
    assert.deepEqual(leadingTitlePositions(['2-005 A']), [at(2, 5, 'A')]);
    for (const titles of [['7 Rings'], ['01 A'], ['01. A'], ['Room404'], ['1.5 Seconds'], ['1-2 Punch'], ['1.21 Gigawatts'], ['3.14 Pi'], ['2.5 Something'],
        ['1-5 A'], ['1-12 A']]) {
        assert.equal(leadingTitlePositions(titles), null, JSON.stringify(titles));
    }
    // The known limit: titles that all start with increasing numbers read as positions, since nothing tells them apart.
    assert.deepEqual(leadingTitlePositions(['24 Hours', '99 Luftballons']), [at(null, 24, 'Hours'), at(null, 99, 'Luftballons')]);
});
