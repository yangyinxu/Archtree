import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { AdminImportError, defaultDraft, parseDraft, parseImportDate, parseManifest } from '../../src/administration/import/adminImportContract';
import { ImportProviderError, OpenAiImportAnalysisProvider, parseImportJson, validateAnalysisSuggestions, type AnalysisInput } from '../../src/administration/import/adminImportProvider';

const slotId = randomUUID();
const manifest = { rootLabel: 'Synthetic Artist - Album', files: [{ slotId, filename: '01 - Song.mp3', relativePath: 'Disc 1/01 - Song.mp3', byteLength: 123 }] };
const input = (): AnalysisInput => ({ generation: 1, chunk: 0, manifest, baseline: defaultDraft(manifest), slots: [], album: true });
const suggestion = () => ({ scope: 'album', slotId: null, field: 'title', text: 'Album', number: null, date: null, source: 'folder', evidence: 'Selected root: Synthetic Artist - Album' });
const output = (text: string) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const invalid = (work: () => unknown) => assert.throws(work, AdminImportError);

test('naming manifest accepts safe relative context and rejects path escape, control and duplicate identities', () => {
    assert.deepEqual(parseManifest(manifest), manifest);
    for (const path of ['/secret/song.mp3', '../song.mp3', 'folder/../01 - Song.mp3', 'C:\\private\\01 - Song.mp3', 'folder//01 - Song.mp3', 'folder\u0000/01 - Song.mp3']) invalid(() => parseManifest({ ...manifest, files: [{ ...manifest.files[0], relativePath: path }] }));
    invalid(() => parseManifest({ ...manifest, files: [manifest.files[0], { ...manifest.files[0], slotId: randomUUID() }] }));
    invalid(() => parseManifest({ ...manifest, extra: 'ignored' }));
    invalid(() => parseManifest({ ...manifest, files: Array.from({ length: 101 }, (_, i) => ({ slotId: randomUUID(), filename: `${i}.mp3`, relativePath: `${i}.mp3`, byteLength: null })) }));
    invalid(() => parseManifest({ ...manifest, rootLabel: 'absolute/path' }));
    invalid(() => parseManifest({ ...manifest, files: [{ ...manifest.files[0], filename: '\ud800' }] }));
});
test('draft retains exact slots, explicit nullable numbers, hidden default and calendar precision', () => {
    const draft = defaultDraft(manifest); assert.equal(draft.album.visibility, 'hidden'); assert.deepEqual(parseDraft(draft, manifest), draft);
    for (const date of [{ year: 2023, month: 2, day: 29 }, { year: 2024, month: null, day: 3 }, { year: 2024, month: 1 }, { year: '2024', month: 1, day: 1 }]) invalid(() => parseImportDate(date));
    assert.deepEqual(parseImportDate({ year: 2024, month: 2, day: 29 }), { year: 2024, month: 2, day: 29 });
    assert.deepEqual(parseImportDate({ year: 2024, month: null, day: null }), { year: 2024, month: null, day: null });
    invalid(() => parseDraft({ ...draft, tracks: [{ ...draft.tracks[0], trackNumber: 0 }] }, manifest));
    invalid(() => parseDraft({ ...draft, album: { ...draft.album, visibility: 'unlisted' } }, manifest));
    invalid(() => parseDraft({ ...draft, tracks: [{ ...draft.tracks[0], slotId: randomUUID() }] }, manifest));
});
test('complete strict JSON rejects duplicate keys, trailing values, invalid escapes and excessive depth', () => {
    assert.equal((parseImportJson('{"text":"ok","v":[null,true,3]}') as any).text, 'ok');
    for (const text of ['{"a":1,"a":2}', '{"a":1} {}', '{"a":"bad\u0000"}', '[1,]', '01', '1e999', '['.repeat(22) + '0' + ']'.repeat(22)]) assert.throws(() => parseImportJson(text), ImportProviderError);
});
test('analysis schema cannot inject fields, visibility, unknown slots or invalid track numbers', () => {
    assert.equal(validateAnalysisSuggestions({ suggestions: [suggestion()] }, input())[0].baseline, '');
    for (const value of [{ ...suggestion(), field: 'visibility' }, { ...suggestion(), slotId }, { ...suggestion(), text: null }, { ...suggestion(), extra: true }, { ...suggestion(), date: { year: 2024, month: null, day: null } }]) assert.throws(() => validateAnalysisSuggestions({ suggestions: [value] }, input()), ImportProviderError);
    assert.throws(() => validateAnalysisSuggestions({ suggestions: [suggestion(), suggestion()] }, input()), ImportProviderError);
    assert.throws(() => validateAnalysisSuggestions({ suggestions: [{ ...suggestion(), scope: 'track', slotId, field: 'trackNumber', text: null, number: 0 }] }, { ...input(), album: false, slots: [slotId] }), ImportProviderError);
});
test('fixed Responses transport uses strict schema, no tools/store, runtime configuration, and no automatic retries', async () => {
    const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'synthetic-key'; let calls = 0;
    try {
        const provider = new OpenAiImportAnalysisProvider(async (url, init) => {
            calls++; assert.equal(url, 'https://api.openai.com/v1/responses'); const body = JSON.parse(init!.body as string);
            assert.equal(body.model, 'gpt-6-luna'); assert.equal(body.store, false); assert.equal(body.tools, undefined); assert.equal(body.text.format.strict, true); assert.equal(body.max_output_tokens, 4000);
            return new Response(JSON.stringify(output(JSON.stringify({ suggestions: [suggestion()] }))));
        });
        assert.equal((await provider.analyze(input()))[0].value, 'Album'); assert.equal(calls, 1);
        const failing = new OpenAiImportAnalysisProvider(async () => { calls++; throw new Error('untrusted provider message'); });
        await assert.rejects(failing.analyze(input()), (error: ImportProviderError) => error.issue === 'providerOutcomeUnknown' && !error.message.includes('untrusted')); assert.equal(calls, 2);
    } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});
test('provider rejects refusal, incomplete, oversized, invalid UTF8 and complete-output contract violations', async () => {
    const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'synthetic-key';
    try {
        for (const response of [new Response(JSON.stringify({ status: 'incomplete', output: [] })), new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] })), new Response(' '.repeat(256001)), new Response(new Uint8Array([0xff, 0xfe])), new Response(JSON.stringify(output('{"suggestions":[],"suggestions":[]}')))]) await assert.rejects(new OpenAiImportAnalysisProvider(async () => response).analyze(input()), (error: ImportProviderError) => error.issue === 'providerInvalidResponse');
        await assert.rejects(new OpenAiImportAnalysisProvider(async () => new Response('private', { status: 403 })).analyze(input()), (error: ImportProviderError) => error.issue === 'providerRejected');
        await assert.rejects(new OpenAiImportAnalysisProvider(async () => new Response('private', { status: 503 })).analyze(input()), (error: ImportProviderError) => error.issue === 'providerOutcomeUnknown');
    } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});
test('a successful HTTP status with interrupted response bytes remains an uncertain paid outcome', async () => {
    const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'synthetic-key';
    try {
        const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"status":')); }, pull(controller) { controller.error(new Error('private transport failure')); } });
        await assert.rejects(new OpenAiImportAnalysisProvider(async () => new Response(body)).analyze(input()), (error: ImportProviderError) => error.issue === 'providerOutcomeUnknown' && !error.message.includes('private'));
    } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});
