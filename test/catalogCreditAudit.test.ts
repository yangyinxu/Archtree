import assert from 'node:assert/strict';
import test from 'node:test';
import { planCreditSubjectLookups } from '../src/services/catalogCreditAudit';

const subject = 'abcdef012345678901234567';
const other = 'abcdef012345678901234568';
const incomplete = { knownIds: new Set<string>(), complete: false };
const credit = (subjectType: 'artist' | 'organization', subjectId = subject, role?: string) => ({
    creditId: `credit_${subjectType}_${role || 'default'}`,
    subjectType, subjectId, role: role || (subjectType === 'artist' ? 'primary' : 'label'), order: 0
});

test('one lookup budget is shared across subject types and repeated Credits across owners', () => {
    const owners = [
        { credits: [credit('artist')] },
        { credits: [credit('artist', subject.toUpperCase(), 'featured'), credit('organization')] },
        { credits: [credit('artist', other)] }
    ];
    const plan = planCreditSubjectLookups(owners, incomplete, incomplete, 2);
    assert.deepEqual([...plan.artistIds], [subject]);
    assert.deepEqual([...plan.organizationIds], [subject]);
    assert.equal(plan.remainingReferences, 0);
    assert.equal(owners[1].credits[0].subjectId, subject.toUpperCase());
});

test('known subjects and complete windows consume no supplementary query budget', () => {
    const owners = [{ credits: [credit('artist'), credit('organization')] }];
    const plan = planCreditSubjectLookups(owners,
        { knownIds: new Set([subject]), complete: false },
        { knownIds: new Set(), complete: true }, 1);
    assert.equal(plan.artistIds.size + plan.organizationIds.size, 0);
    assert.equal(plan.remainingReferences, 1);
});

test('exhausted budgets and invalid Credit state never create a target lookup', () => {
    for (const [owners, budget] of [
        [[{ credits: [credit('artist')] }], 0],
        [[{ credits: [credit('artist', 'malformed')] }], 3],
        [[{ credits: 'invalid' }], 3]
    ] as const) {
        const plan = planCreditSubjectLookups(owners, incomplete, incomplete, budget);
        assert.equal(plan.artistIds.size + plan.organizationIds.size, 0);
        assert.equal(plan.remainingReferences, budget);
    }
});
