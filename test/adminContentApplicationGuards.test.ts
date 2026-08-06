import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp, requiresEarlySharedContentAdmin } from '../src/app';

test('pre-body authorization targets shared writes but preserves personal content writes', () => {
    for (const [method, path] of [
        ['POST', '/content/album'],
        ['PUT', '/content/audioTrack/64b000000000000000000001'],
        ['DELETE', '/content/carousels/64b000000000000000000002'],
        ['POST', '/feed/post']
    ]) {
        assert.equal(requiresEarlySharedContentAdmin(method, path), true, `${method} ${path}`);
    }
    for (const [method, path] of [
        ['GET', '/content/albums'],
        ['POST', '/content/me/recently-played'],
        ['PUT', '/content/me/saves/album/64b000000000000000000001'],
        ['POST', '/content/manage/artist/create'],
        ['POST', '/auth/browser/login']
    ]) {
        assert.equal(requiresEarlySharedContentAdmin(method, path), false, `${method} ${path}`);
    }
});

test('application installs Manager and shared-write authorization before body parsers', () => {
    const app = createApp();
    const stack = (app as any)._router.stack as Array<{ name: string }>;
    const names = stack.map((layer) => layer.name);
    const jsonParserIndex = names.indexOf('jsonParser');
    const urlencodedParserIndex = names.indexOf('urlencodedParser');
    assert.ok(jsonParserIndex > 0);
    assert.ok(urlencodedParserIndex > jsonParserIndex);
    for (const middleware of [
        'requireAuthForWeb',
        'requireAdminForWeb',
        'requireSharedContentAdminBeforeBody'
    ]) {
        const index = names.indexOf(middleware);
        assert.ok(index >= 0, `${middleware} must be installed`);
        assert.ok(index < jsonParserIndex, `${middleware} must run before JSON parsing`);
    }
});
