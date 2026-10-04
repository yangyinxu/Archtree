import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import express from 'express';
import { handleApplicationError } from '../src/app';
import {
    consumeLinkEmailBudget,
    linkEmailBudgetPerWindow,
    resetRateLimitWindowsForTests
} from '../src/middleware/requestProtectionMiddleware';
import AuthIdentity from '../src/models/authIdentity';
import { hashEmailLinkToken, isEmailLinkTokenFormat } from '../src/models/emailLinkToken';
import { authLinkOrigin, renderAuthEmail, sendAuthEmail } from '../src/services/authEmailService';
import {
    EmailVerificationRequiredError,
    emailVerificationState
} from '../src/services/emailVerificationService';

/** Pure link, template, budget and error-shape rules; nothing here opens MongoDB or the network. */
const origin = 'https://listen.example.test';
const token = 'Lorem_ipsum-dolor_sit-amet_consectetur-adip';

const withEnvironment = (t: TestContext, values: Record<string, string | undefined>) => {
    const saved = Object.keys(values).map(name => [name, process.env[name]] as const);
    for (const [name, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    t.after(() => {
        for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
};

test('link tokens are stored only as purpose-bound keyed hashes', t => {
    withEnvironment(t, { AUTH_CODE_PEPPER: 'synthetic-link-pepper' });
    assert.equal(token.length, 43);
    const registration = hashEmailLinkToken('registration', token);
    assert.match(registration, /^[0-9a-f]{64}$/);
    assert.equal(registration.includes(token), false);
    assert.equal(hashEmailLinkToken('registration', token), registration, 'hashing is deterministic');
    assert.notEqual(hashEmailLinkToken('verifyEmail', token), registration, 'a token never matches another purpose');
    withEnvironment(t, { AUTH_CODE_PEPPER: 'another-synthetic-pepper' });
    assert.notEqual(hashEmailLinkToken('registration', token), registration, 'the pepper keys the hash');
    withEnvironment(t, { AUTH_CODE_PEPPER: undefined, JWT_SECRET: undefined });
    assert.throws(() => hashEmailLinkToken('registration', token), /pepper is not configured/);
});

test('only the exact 43-character base64url token shape is accepted', () => {
    assert.equal(isEmailLinkTokenFormat(token), true);
    for (const candidate of [token.slice(1), `${token}A`, `${token.slice(1)}=`, `${token.slice(1)}+`,
        `${token.slice(1)}/`, `${token.slice(1)}.`, '', 43, null, undefined, { token }]) {
        assert.equal(isEmailLinkTokenFormat(candidate), false, String(candidate));
    }
});

test('email templates use the exact copy and links, and never put a token in a subject', () => {
    const t1 = renderAuthEmail({ template: 'T1', token }, origin);
    assert.equal(t1.subject, 'Finish creating your Finitude account');
    assert.equal(t1.text, [
        'Someone asked to create a Finitude account with this email address.',
        '',
        'To choose your display name and password, open this link within 30 minutes:',
        `${origin}/finitude/register/complete#token=${token}`,
        '',
        'The link works once. If you didn\'t ask for this, ignore this email and no account will be created.'
    ].join('\n'));

    const t2 = renderAuthEmail({ template: 'T2' }, origin);
    assert.equal(t2.subject, 'You already have a Finitude account');
    assert.equal(t2.text, [
        'Someone asked to create a Finitude account with this email address, but it already has one. Nothing was changed.',
        '',
        'Log in on the web or in the Finitude app:',
        `${origin}/finitude/login`,
        '',
        'Forgot your password? Reset it here:',
        `${origin}/finitude/forgot-password`,
        '',
        'If you didn\'t ask for this, you can ignore this email.'
    ].join('\n'));
    assert.doesNotMatch(t2.text, /#token=/);

    const t3 = renderAuthEmail({ template: 'T3', token }, origin);
    assert.equal(t3.subject, 'Verify your Finitude email');
    assert.equal(t3.text, [
        'Your Finitude account needs a verified email address before you can sign in again.',
        '',
        'If you just tried to sign in or asked for this link, open it within 30 minutes and select Verify email, then sign in again:',
        `${origin}/finitude/verify-email#token=${token}`,
        '',
        'Your password doesn\'t change. If you didn\'t just try to sign in, don\'t open the link. Reset your password instead:',
        `${origin}/finitude/forgot-password`
    ].join('\n'));

    const reset = renderAuthEmail({ template: 'resetCode', code: '135790' }, null);
    assert.equal(reset.subject, 'Reset your Finitude password');
    assert.equal(reset.text, 'Use code 135790 to reset your password. This code expires soon. If you did not request it, you can ignore this email.');
    for (const subject of [t1.subject, t2.subject, t3.subject, reset.subject]) {
        assert.equal(subject.includes(token), false);
        assert.doesNotMatch(subject, /\d{6}/);
    }
    assert.throws(() => renderAuthEmail({ template: 'T1', token }, null), { statusCode: 503 });
});

test('link emails are built from AUTH_LINK_ORIGIN and sent through SES as plain text', async t => {
    withEnvironment(t, {
        AUTH_EMAIL_FROM: 'auth@example.test', AWS_REGION: 'us-east-1', AUTH_CODE_PEPPER: 'synthetic-link-pepper',
        AUTH_LINK_ORIGIN: 'https://Listen.Example.test/'
    });
    const commands: any[] = [];
    t.mock.method(SESv2Client.prototype, 'send', async (command: any) => { commands.push(command.input); return {}; });
    assert.equal(await sendAuthEmail('lorem@example.test', 'T1', () => ({ template: 'T1', token })), true);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].FromEmailAddress, 'auth@example.test');
    assert.deepEqual(commands[0].Destination, { ToAddresses: ['lorem@example.test'] });
    assert.equal(commands[0].Content.Simple.Body.Html, undefined);
    assert.match(commands[0].Content.Simple.Body.Text.Data, /https:\/\/listen\.example\.test\/finitude\/register\/complete#token=/);

    withEnvironment(t, { AUTH_LINK_ORIGIN: undefined });
    await assert.rejects(sendAuthEmail('lorem@example.test', 'T3', () => ({ template: 'T3', token })), { statusCode: 503 });
    await sendAuthEmail('lorem@example.test', 'resetCode', () => ({ template: 'resetCode', code: '135790' }));
    assert.equal(commands.length, 2, 'reset codes need delivery but no link origin');
});

test('the link origin is an exact https origin, never a path, query or credential', () => {
    assert.equal(authLinkOrigin({ AUTH_LINK_ORIGIN: 'https://Listen.Example.test/' }), 'https://listen.example.test');
    assert.equal(authLinkOrigin({ AUTH_LINK_ORIGIN: ' https://listen.example.test:8443 ' }), 'https://listen.example.test:8443');
    for (const value of [undefined, '', 'listen.example.test', 'https://listen.example.test/finitude',
        'https://listen.example.test/?a=1', 'https://listen.example.test#x', 'https://a:b@listen.example.test',
        'http://listen.example.test']) {
        assert.equal(authLinkOrigin({ AUTH_LINK_ORIGIN: value }), null, String(value));
    }
    assert.equal(authLinkOrigin({ AUTH_LINK_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test' }), 'http://localhost:5173');
    assert.equal(authLinkOrigin({ AUTH_LINK_ORIGIN: 'http://localhost:5173', NODE_ENV: 'production' }), null);
});

test('each address gets three link emails per window, keyed on the normalized address', () => {
    resetRateLimitWindowsForTests();
    assert.equal(linkEmailBudgetPerWindow, 3);
    for (let send = 0; send < 3; send += 1) assert.equal(consumeLinkEmailBudget('lorem@example.test'), true);
    assert.equal(consumeLinkEmailBudget('Lorem@Example.test'), false, 'case variants share the budget');
    assert.equal(consumeLinkEmailBudget('ipsum@example.test'), true, 'another address keeps its own budget');
    resetRateLimitWindowsForTests();
    assert.equal(consumeLinkEmailBudget('lorem@example.test'), true);
    resetRateLimitWindowsForTests();
});

test('verification state is derived from the stored field and provider-verified identities', async t => {
    const lookups: Array<[string, string]> = [];
    let identityMatches = false;
    t.mock.method(AuthIdentity, 'hasEmailForUser', async (userId: string, email: string) => {
        lookups.push([userId, email]);
        return identityMatches;
    });
    const account = (emailVerified?: boolean) => ({
        _id: { toString: () => 'synthetic-user' },
        email: 'Lorem@Example.test',
        ...(emailVerified === undefined ? {} : { emailVerified })
    });
    assert.equal(await emailVerificationState(account(true)), 'verified');
    assert.equal(await emailVerificationState(account(false)), 'pending_record');
    assert.deepEqual(lookups, [], 'stored values never need an identity lookup');
    assert.equal(await emailVerificationState(account()), 'legacy_unverified');
    identityMatches = true;
    assert.equal(await emailVerificationState(account()), 'verified');
    assert.deepEqual(lookups, [['synthetic-user', 'lorem@example.test'], ['synthetic-user', 'lorem@example.test']]);
});

test('the error boundary exposes a code only for errors that opt in', async t => {
    const app = express();
    const errors: Record<string, unknown> = {
        '/verification': new EmailVerificationRequiredError({ _id: 'synthetic' }),
        '/private-code': Object.assign(new Error('Conflict.'), { statusCode: 409, code: 'private_detail' }),
        '/server': Object.assign(new Error('Private failure.'), { statusCode: 500, code: 'x', exposeCode: true })
    };
    for (const [path, error] of Object.entries(errors)) app.get(path, (_req, _res, next) => next(error));
    app.use(handleApplicationError);
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    t.mock.method(console, 'error', () => undefined);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const verification = await fetch(`${url}/verification`);
    assert.equal(verification.status, 403);
    assert.deepEqual(await verification.json(), {
        code: 'email_verification_required',
        message: 'Verify your email to sign in. Open the verification link we sent to your email address, then sign in again.'
    });
    const privateCode = await fetch(`${url}/private-code`);
    assert.deepEqual(await privateCode.json(), { message: 'Conflict.' });
    const failure = await fetch(`${url}/server`);
    assert.equal(failure.status, 500);
    assert.deepEqual(await failure.json(), { message: 'The service could not complete the request.' });
});
