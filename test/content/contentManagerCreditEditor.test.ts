/** The Content Manager Credit editor shows each join phrase between names as an editable form. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderManagePage } from '../../src/views/contentManager/managePageView';

const albumId = '64c000000000000000000001';
const subject = (suffix: string) => `64c0000000000000000000${suffix}`;
const zeroWidthSpace = String.fromCharCode(0x200b);
const credit = (creditId: string, subjectId: string, joinPhrase?: unknown) => ({
    creditId, subjectType: 'artist', subjectId, role: 'primary', order: 0,
    ...(joinPhrase === undefined ? {} : { joinPhrase })
});

const render = (credits: unknown[], creditRevision?: unknown) => renderManagePage({
    userId: '64c0000000000000000000ff',
    userEmail: 'credit-editor@example.test',
    maxAudioBatchFiles: 100,
    organizationTypes: ['label'],
    isAdmin: true,
    managerView: 'catalog',
    prefillAlbumId: albumId,
    prefillAlbum: {
        _id: albumId, title: 'Synthetic phrase Album', audioTrackIds: [], credits, attributionStatus: 'documented',
        ...(creditRevision === undefined ? {} : { creditRevision })
    },
    prefillCreditSubjectLabels: Object.fromEntries(['11', '12', '13', '14'].map((suffix, index) =>
        [`artist:${subject(suffix)}`, `Synthetic Artist ${index + 1}`]))
});

const phraseForms = (html: string) => [...html.matchAll(
    /<form method="POST" action="\/content\/manage\/credits\/update-join-phrase">([\s\S]*?)<\/form>/g
)].map((match) => match[1]);

test('every Credit except the last renders an escaped join phrase form', () => {
    const html = render([
        credit('credit_first', subject('11'), ' & '),
        credit('credit_second', subject('12'), '<b>'),
        credit('credit_third', subject('13'), `x${zeroWidthSpace}y`),
        credit('credit_fourth', subject('14'), ' / ')
    ], 7);
    const forms = phraseForms(html);
    assert.equal(forms.length, 3);
    // Each phrase form carries the rendered Credit revision, so a later list change asks for a reload.
    assert.deepEqual(forms.map((form) => /<input type="hidden" name="creditRevision" value="([^"]*)" \/>/.exec(form)?.[1]),
        ['7', '7', '7']);
    assert.deepEqual(forms.map((form) => /name="creditId" value="([^"]+)"/.exec(form)?.[1]),
        ['credit_first', 'credit_second', 'credit_third']);
    assert.deepEqual(forms.map((form) => /name="joinPhrase" maxlength="16" value="([^"]*)"/.exec(form)?.[1]),
        [' &amp; ', '&lt;b&gt;', '']);
    // The last Credit has no next name, so its stored phrase is neither shown nor editable.
    assert.equal(html.includes('value=" / "'), false);
    assert.equal(html.includes(zeroWidthSpace), false);
    assert.match(html, /Leave a join phrase empty for a comma\. Moving, adding or removing a Credit clears a join phrase whose next name changes\./);
});

test('a missing or non-integer stored Credit revision renders as revision 0', () => {
    for (const creditRevision of [undefined, '3', 1.5, null]) {
        const forms = phraseForms(render([credit('credit_first', subject('11')), credit('credit_second', subject('12'))], creditRevision));
        assert.deepEqual(forms.map((form) => /name="creditRevision" value="([^"]*)"/.exec(form)?.[1]), ['0'], String(creditRevision));
    }
});

test('a single Credit has no join phrase form or note', () => {
    const html = render([credit('credit_only', subject('11'), ' & ')]);
    assert.equal(phraseForms(html).length, 0);
    assert.doesNotMatch(html, /Leave a join phrase empty/);
});
