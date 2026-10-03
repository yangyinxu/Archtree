import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import test, { TestContext } from 'node:test';
import express from 'express';

import authRoutes from '../src/routes/authRoutes';
import { resetRateLimitWindowsForTests } from '../src/middleware/requestProtectionMiddleware';

type EmailCodeRoute = {
    path: string;
    form?: boolean;
    body: (email: string) => Record<string, string>;
};

const syntheticPassword = 'lorem-ipsum-dolor-sit-01';

// Every route whose controller resolves the account from the normalized `email`.
// Payloads are well formed so each admitted request reaches its controller.
const emailCodeRoutes: EmailCodeRoute[] = [
    { path: '/signup', body: (email) => ({ email, password: syntheticPassword, displayName: 'Lorem Ipsum' }) },
    { path: '/email/verify', body: (email) => ({ email, code: '123456' }) },
    { path: '/email/resend-verification', body: (email) => ({ email }) },
    { path: '/password/forgot', body: (email) => ({ email }) },
    { path: '/password/reset', body: (email) => ({ email, code: '123456', password: syntheticPassword }) },
    {
        path: '/signup-web',
        form: true,
        body: (email) => ({ email, password: syntheticPassword, username: 'loremipsum' })
    },
    { path: '/browser/register', body: (email) => ({ email, password: syntheticPassword, displayName: 'Lorem Ipsum' }) },
    { path: '/browser/email/verify', body: (email) => ({ email, code: '123456' }) },
    { path: '/browser/email/resend-verification', body: (email) => ({ email }) },
    { path: '/browser/password/forgot', body: (email) => ({ email }) },
    { path: '/browser/password/reset', body: (email) => ({ email, code: '123456', password: syntheticPassword }) }
];

const authEmailEnvironment = ['AUTH_EMAIL_FROM', 'AWS_REGION', 'AUTH_CODE_PEPPER', 'JWT_SECRET'] as const;

/**
 * Serves the real auth router without a database or mail configuration. Admitted
 * requests fail inside their controller, so only the limiter can return 429.
 */
const listen = async (t: TestContext) => {
    const savedEnvironment = authEmailEnvironment.map((name) => [name, process.env[name]] as const);
    for (const name of authEmailEnvironment) delete process.env[name];
    t.after(() => {
        for (const [name, value] of savedEnvironment) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    resetRateLimitWindowsForTests();
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use('/auth', authRoutes);
    app.use((error: { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(error.statusCode ?? 500).json({ message: 'The service could not complete the request.' });
    });
    const server = await new Promise<Server>((resolve) => {
        const value = app.listen(0, '127.0.0.1', () => resolve(value));
    });
    t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;

    return async (route: Pick<EmailCodeRoute, 'path' | 'form'>, body: Record<string, string>) => {
        const response = await fetch(`${origin}/auth${route.path}`, {
            method: 'POST',
            headers: {
                origin,
                'content-type': route.form ? 'application/x-www-form-urlencoded' : 'application/json'
            },
            body: route.form ? new URLSearchParams(body).toString() : JSON.stringify(body)
        });
        await response.arrayBuffer();
        return response;
    };
};

test('email-code routes ignore extra identifier fields when counting account attempts', async (t) => {
    const post = await listen(t);
    for (const route of emailCodeRoutes) {
        resetRateLimitWindowsForTests();
        for (let attempt = 1; attempt <= 10; attempt += 1) {
            const response = await post(route, {
                ...route.body('lorem.ipsum@example.test'),
                identifier: `probe-${randomUUID()}@example.test`,
                username: `probe-${randomUUID()}`
            });
            assert.notEqual(response.status, 429, `${route.path} attempt ${attempt} must reach its controller`);
        }
        const rejected = await post(route, {
            ...route.body('lorem.ipsum@example.test'),
            identifier: `probe-${randomUUID()}@example.test`
        });
        assert.equal(rejected.status, 429, `${route.path} must limit the account, not each identifier`);
        assert.ok(Number(rejected.headers.get('retry-after')) > 0);
    }
});

test('email-code routes count normalized Gmail address variants as one account', async (t) => {
    const post = await listen(t);
    for (const route of emailCodeRoutes) {
        resetRateLimitWindowsForTests();
        for (let attempt = 1; attempt <= 10; attempt += 1) {
            const variant = attempt % 2 === 0
                ? `Victim.Name+probe${attempt}@GoogleMail.com`
                : `v.i.c.t.i.m.n.a.m.e+probe${attempt}@gmail.com`;
            const response = await post(route, route.body(variant));
            assert.notEqual(response.status, 429, `${route.path} variant ${attempt} must reach its controller`);
        }
        const canonical = await post(route, route.body('victimname@gmail.com'));
        assert.equal(canonical.status, 429, `${route.path} must share one bucket across address variants`);

        // Another account behind the same client keeps its own budget.
        const unrelated = await post(route, route.body('dolor.amet@example.test'));
        assert.notEqual(unrelated.status, 429, `${route.path} must key on the account, not the client`);
    }
});

test('email-code attempts share the identifier login budget for the same address', async (t) => {
    const post = await listen(t);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
        const response = await post({ path: '/password/forgot' }, { email: 'Victim.Name+probe@GoogleMail.com' });
        assert.notEqual(response.status, 429);
    }
    const login = await post({ path: '/login' }, { identifier: 'victimname@gmail.com', password: syntheticPassword });
    assert.equal(login.status, 429);
});
