import assert from 'node:assert/strict';
import { Server } from 'node:http';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import AuthSession from '../src/models/authSession';
import User from '../src/models/user';

const primaryUserId = '64b000000000000000000001';
const otherUserId = '64b000000000000000000002';
const primarySessionId = '64c000000000000000000001';
const otherSessionId = '64c000000000000000000002';
const jwtSecret = 'naruto-mobile-route-test-secret';

const listen = async () => {
  const app = createApp({environment: 'test'});
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {server, baseUrl: `http://127.0.0.1:${address.port}`};
};

const close = (server: Server) => new Promise<void>((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

const accessToken = (userId: string, sessionId: string) => jwt.sign({
  userId,
  email: `${userId}@example.test`,
  role: 'user',
  sessionId,
  tokenType: 'access'
}, jwtSecret, {algorithm: 'HS256', expiresIn: 900});

test('protects the fixed proxy with any authenticated Archtree account', async () => {
  const savedEnvironment = {
    NODE_ENV: process.env.NODE_ENV,
    JWT_SECRET: process.env.JWT_SECRET,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  };
  const originalFindSession = AuthSession.findActiveById;
  const originalFindUser = User.findById;
  const originalFetch = globalThis.fetch;
  let upstreamAuthorization = '';
  let upstreamBody = '';
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = jwtSecret;
  process.env.OPENAI_API_KEY = 'test-key-that-must-not-be-returned';
  AuthSession.findActiveById = async (candidateSessionId: string) => {
    const authenticatedUserId = candidateSessionId === primarySessionId ? primaryUserId
      : candidateSessionId === otherSessionId ? otherUserId : undefined;
    return authenticatedUserId
      ? {userId: authenticatedUserId} as Awaited<ReturnType<typeof AuthSession.findActiveById>>
      : null;
  };
  User.findById = async (userId: string) => ({
    email: `${userId}@example.test`,
    role: 'user'
  }) as Awaited<ReturnType<typeof User.findById>>;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.href === 'https://api.openai.com/v1/responses') {
      upstreamAuthorization = new Headers(init?.headers).get('authorization') ?? '';
      upstreamBody = String(init?.body ?? '');
      const upstreamRequest = JSON.parse(upstreamBody) as {input: string};
      const upstreamBatch = (JSON.parse(upstreamRequest.input) as {
        batch: Array<{opinionId: string}>;
      }).batch;
      return new Response(JSON.stringify({
        output_text: JSON.stringify({results: upstreamBatch.map(({opinionId}) => ({
          opinionId,
          decision: 'analyze',
          gameRelevant: true,
          informationType: 'product_feedback',
          reasonCode: 'specific_claim'
        }))}),
        usage: {input_tokens: 20, output_tokens: 10, total_tokens: 30}
      }), {status: 200, headers: {'content-type': 'application/json'}});
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const {server, baseUrl} = await listen();
  try {
    const status = await fetch(`${baseUrl}/naruto-mobile/api/v1/status`);
    assert.equal(status.status, 200);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.equal(status.headers.get('access-control-allow-origin'), null);
    const statusBody = await status.text();
    assert.deepEqual(JSON.parse(statusBody), {
      enabled: true,
      protocolVersion: 1,
      serviceVersion: 'naruto-mobile-proxy-v1'
    });
    assert.doesNotMatch(statusBody, /test-key/);

    const browserRequest = await fetch(`${baseUrl}/naruto-mobile/api/v1/status`, {
      headers: {origin: 'https://example.com'}
    });
    assert.equal(browserRequest.status, 403);

    const missingBearer = await fetch(`${baseUrl}/naruto-mobile/api/v1/classify`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: `{"private":"${'x'.repeat(180 * 1024)}"`
    });
    assert.equal(missingBearer.status, 401);
    assert.equal((await missingBearer.json()).code, 'login_required');

    const cookieOnly = await fetch(`${baseUrl}/naruto-mobile/api/v1/access`, {
      headers: {cookie: `session_token=${accessToken(primaryUserId, primarySessionId)}`}
    });
    assert.equal(cookieOnly.status, 401);

    const otherAccount = await fetch(`${baseUrl}/naruto-mobile/api/v1/access`, {
      headers: {authorization: `Bearer ${accessToken(otherUserId, otherSessionId)}`}
    });
    assert.equal(otherAccount.status, 200);
    assert.deepEqual(await otherAccount.json(), {authorized: true, protocolVersion: 1});

    const authorized = await fetch(`${baseUrl}/naruto-mobile/api/v1/access`, {
      headers: {authorization: `Bearer ${accessToken(primaryUserId, primarySessionId)}`}
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), {authorized: true, protocolVersion: 1});

    const classified = await fetch(`${baseUrl}/naruto-mobile/api/v1/classify`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken(otherUserId, otherSessionId)}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        protocolVersion: 1,
        kind: 'triage',
        batch: [{
          opinionId: 'opinion-1',
          content: {type: 'video', title: '标题', description: '', publishedAt: null},
          opinion: {
            sourceType: 'comment',
            voiceType: 'viewer',
            text: '二技能后摇太长',
            parentText: null,
            likes: 2,
            replies: 0,
            publishedAt: null
          }
        }]
      })
    });
    assert.equal(classified.status, 200);
    const classifiedText = await classified.text();
    assert.match(upstreamAuthorization, /^Bearer test-key/);
    assert.doesNotMatch(classifiedText, /test-key/);
    assert.equal(JSON.parse(upstreamBody).store, false);
    assert.equal(JSON.parse(classifiedText).results[0].opinionId, 'opinion-1');

    const maximumLegalBatch = Array.from({length: 50}, (_, index) => ({
      opinionId: `maximum-opinion-${index}`,
      content: {
        type: 'video',
        title: '标'.repeat(300),
        description: '描'.repeat(900),
        publishedAt: null
      },
      opinion: {
        sourceType: 'comment',
        voiceType: 'viewer',
        text: '评'.repeat(2_400),
        parentText: '父'.repeat(1_600),
        likes: 0,
        replies: 0,
        publishedAt: null
      }
    }));
    const maximumLegalBody = JSON.stringify({
      protocolVersion: 1,
      kind: 'triage',
      batch: maximumLegalBatch
    });
    assert.ok(Buffer.byteLength(maximumLegalBody) > 128 * 1024);
    assert.ok(Buffer.byteLength(maximumLegalBody) < 1024 * 1024);
    const maximumLegalResponse = await fetch(`${baseUrl}/naruto-mobile/api/v1/classify`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken(primaryUserId, primarySessionId)}`,
        'content-type': 'application/json'
      },
      body: maximumLegalBody
    });
    assert.equal(maximumLegalResponse.status, 200);
    assert.equal((await maximumLegalResponse.json()).results.length, 50);

    const invalidSession = await fetch(`${baseUrl}/naruto-mobile/api/v1/access`, {
      headers: {authorization: `Bearer ${accessToken(primaryUserId, '64c000000000000000000003')}`}
    });
    assert.equal(invalidSession.status, 401);

    const unsupported = await fetch(`${baseUrl}/naruto-mobile/api/v1/classify`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken(primaryUserId, primarySessionId)}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({protocolVersion: 1, kind: 'triage', batch: [], model: 'arbitrary'})
    });
    assert.equal(unsupported.status, 400);
    assert.equal((await unsupported.json()).code, 'invalid_request');

    const oversized = await fetch(`${baseUrl}/naruto-mobile/api/v1/classify`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken(primaryUserId, primarySessionId)}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({private: 'x'.repeat(1024 * 1024)})
    });
    assert.equal(oversized.status, 413);
  } finally {
    await close(server);
    AuthSession.findActiveById = originalFindSession;
    User.findById = originalFindUser;
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
