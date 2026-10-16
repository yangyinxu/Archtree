import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { createApp } from '../src/app';
import { renderAuthEmail } from '../src/services/authEmailService';
import { suggestEmailCorrection } from '../web/src/features/account/emailDomainSuggestion';

const pages = [
    ['/account/register', 'register', 'Create a Kashewt account.'],
    ['/account/register/complete', 'register-complete', 'Set up your Kashewt account.'],
    ['/account/verify-email', 'verify-email', 'Confirm this email is yours.'],
    ['/account/forgot-password', 'forgot-password', 'Reset your password.'],
    ['/account/reset-password', 'reset-password', 'Choose a new password.']
] as const;

test('Kashewt account pages are private, script-driven shells under the strict policy', async () => {
    const app = createApp({ environment: 'test', listenerDistPath: path.join(os.tmpdir(), 'archtree-account-pages-missing') });
    const server = await new Promise<Server>((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    try {
        for (const [pathname, page, title] of pages) {
            const response = await fetch(`${base}${pathname}`);
            assert.equal(response.status, 200, pathname);
            assert.equal(response.headers.get('cache-control'), 'no-store', pathname);
            const csp = response.headers.get('content-security-policy') ?? '';
            assert.match(csp, /(?:^|; )style-src 'self'(?:;|$)/, pathname);
            assert.match(csp, /script-src-attr 'none'/, pathname);
            const html = await response.text();
            assert.match(html, new RegExp(`data-account-page="${page}"`), pathname);
            assert.match(html, new RegExp(title.replace('.', '\\.')), pathname);
            assert.match(html, /<script src="\/assets\/account-forms\.js"><\/script>/, pathname);
            assert.match(html, /<span>Kashewt<\/span>/, pathname);
            assert.doesNotMatch(html, /style=|<script>|Archtree|\/finitude\//, pathname);
        }

        const script = await fetch(`${base}/assets/account-forms.js`);
        assert.equal(script.status, 200);
        const source = await script.text();
        // Link tokens are read from the fragment and only ever sent in JSON bodies.
        assert.match(source, /\/\^#token=\(\[A-Za-z0-9_-\]\{43\}\)\$\//);
        assert.match(source, /history\.replaceState/);
        assert.equal((await fetch(`${base}/assets/account.css`)).status, 200);
        assert.equal((await fetch(`${base}/account/unknown`)).status, 404);
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('every emailed link opens a Kashewt account page', () => {
    const token = 'A'.repeat(43);
    const origin = 'https://kashewt.example.test';
    const texts = [
        renderAuthEmail({ template: 'T1', token }, origin).text,
        renderAuthEmail({ template: 'T2' }, origin).text,
        renderAuthEmail({ template: 'T3', token }, origin).text
    ].join('\n');
    const links = [...texts.matchAll(/https:\/\/\S+/g)].map((match) => new URL(match[0]).pathname);
    assert.deepEqual([...new Set(links)].sort(), [
        '/account/forgot-password', '/account/register/complete', '/account/verify-email', '/auth/login-web'
    ]);
    for (const pathname of links) {
        assert.ok(pathname === '/auth/login-web' || pages.some(([page]) => page === pathname), pathname);
    }
});

test('the Kashewt email suggestion matches the Finitude implementation', () => {
    const context: { kashewtSuggestEmailCorrection?: (value: string) => string | null } = {};
    vm.runInNewContext(readFileSync(path.join(__dirname, '../src/public/email-suggestion.js'), 'utf8'), { globalThis: context });
    const suggest = context.kashewtSuggestEmailCorrection;
    assert.equal(typeof suggest, 'function');
    for (const input of [
        'Lorem-Listener@gmial.com', 'name@gmail.co', 'name@gmail.com', 'name@GMAIL.COM', 'name@yahoo.ca', 'name@hp.com',
        'name@outlok.com', 'name@hotmial.com', 'name@icloud.con', 'name@qq.co', 'name@mail.com', 'name@protonmail.co',
        'name@gmail.com.', 'no-at-sign', 'a@b@gmail.com', ' spaced@gmial.com ', 'name with space@gmial.com', '',
        'name@ymail.com', 'name@foxmial.com', 'name@163.co', `${'x'.repeat(250)}@gmial.com`
    ]) {
        assert.equal(suggest!(input), suggestEmailCorrection(input), input);
    }
});
