import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NarutoMobileOpenAiClassifier,
  NarutoMobileUpstreamError
} from '../src/narutoMobile/openAiClassifierService';
import { NarutoMobileClassifyRequest } from '../src/narutoMobile/protocol';

const requestFor = (
  kind: NarutoMobileClassifyRequest['kind'],
  opinionIds = ['opinion-1']
): NarutoMobileClassifyRequest => ({
  protocolVersion: 1,
  kind,
  batch: opinionIds.map((opinionId) => ({
    opinionId,
    content: {type: 'video', title: '测试', description: '', publishedAt: null},
    opinion: {
      sourceType: 'comment', voiceType: 'viewer', text: '技能后摇太长', parentText: null,
      likes: 1, replies: 0, publishedAt: null
    }
  }))
});

const triageResult = (opinionId = 'opinion-1') => ({
  opinionId,
  decision: 'analyze',
  gameRelevant: true,
  informationType: 'product_feedback',
  reasonCode: 'possible_feedback'
});

const detailResult = (opinionId = 'opinion-1') => ({
  opinionId,
  gameRelevant: true,
  relevanceScore: 0.92,
  insightValue: 'strong',
  informationType: 'product_feedback',
  claimObject: '二技能',
  claim: '二技能后摇太长',
  specificitySignals: ['mechanism', 'impact'],
  reasonCodes: ['specific_claim'],
  topics: [{name: '忍者设计', sentiment: 'negative', evidence: '技能后摇太长'}],
  emotion: 'frustration',
  stance: 'complaint',
  severity: 3,
  behaviorIntents: [],
  playerSegment: 'unknown',
  actionability: 'high',
  confidence: 0.9,
  needsReview: false
});

const validUsage = {
  input_tokens: 50,
  input_tokens_details: {cached_tokens: 5},
  output_tokens: 10,
  output_tokens_details: {reasoning_tokens: 4},
  total_tokens: 60
};

const successResponse = (
  results: unknown[],
  options: {usage?: unknown; outputArray?: boolean} = {}
) => {
  const value: Record<string, unknown> = {
    usage: Object.prototype.hasOwnProperty.call(options, 'usage') ? options.usage : validUsage
  };
  const text = JSON.stringify({results});
  if (options.outputArray) {
    value.output = [{type: 'message', content: [{type: 'output_text', text}]}];
  } else {
    value.output_text = text;
  }
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {'content-type': 'application/json'}
  });
};

const serviceWith = (fetchImpl: typeof fetch, timeoutMs = 5_000) => (
  new NarutoMobileOpenAiClassifier({
    apiKey: 'server-key',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
    timeoutMs,
    fetchImpl
  })
);

const rejectsAs = (statusCode: number) => (error: unknown) => {
  assert.ok(error instanceof NarutoMobileUpstreamError);
  assert.equal(error.statusCode, statusCode);
  assert.equal(error.message, 'The analysis service is temporarily unavailable.');
  assert.doesNotMatch(error.message, /private|secret|invalid enum/i);
  return true;
};

test('owns the OpenAI model, schema, prompt and privacy settings on the server', async () => {
  let authorization = '';
  let body: Record<string, any> = {};
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    authorization = String((init?.headers as Record<string, string>).authorization);
    body = JSON.parse(String(init?.body));
    return successResponse([triageResult()]);
  }) as typeof fetch;
  const result = await serviceWith(fetchImpl).classify(requestFor('triage'));

  assert.equal(authorization, 'Bearer server-key');
  assert.equal(body.model, 'gpt-5.6-luna');
  assert.equal(body.store, false);
  assert.equal(body.tools, undefined);
  assert.equal(body.max_output_tokens, 3_000);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.properties.results.maxItems, 50);
  assert.equal(body.text.format.schema.properties.results.items.properties.opinionId.maxLength, undefined);
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.usage, {
    inputTokens: 50,
    cachedInputTokens: 5,
    outputTokens: 10,
    reasoningTokens: 4,
    totalTokens: 60
  });
});

test('decodes and bounds the complete detail result from the raw Responses output array', async () => {
  let body: Record<string, any> = {};
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return successResponse([detailResult()], {outputArray: true});
  }) as typeof fetch;
  const result = await serviceWith(fetchImpl).classify(requestFor('detail'));

  assert.equal(body.reasoning.effort, 'medium');
  assert.equal(body.max_output_tokens, 4_000);
  assert.equal(body.text.format.name, 'naruto_opinion_batch');
  assert.equal(body.text.format.schema.properties.results.maxItems, 10);
  assert.deepEqual(result.results, [detailResult()]);
  assert.equal(result.kind, 'detail');
  assert.equal(result.promptVersion, 'naruto-opinion-v3');
});

test('accepts optional and future usage detail fields while validating consumed counters', async () => {
  const usage = {
    input_tokens: 50,
    input_tokens_details: {cache_write_tokens: 12, future_counter: 3},
    output_tokens: 10,
    output_tokens_details: {future_counter: 2},
    total_tokens: 60,
    future_top_level_counter: 4
  };
  const fetchImpl = (async () => successResponse([triageResult()], {usage})) as typeof fetch;
  const result = await serviceWith(fetchImpl).classify(requestFor('triage'));

  assert.deepEqual(result.usage, {
    inputTokens: 50,
    cachedInputTokens: 0,
    outputTokens: 10,
    reasoningTokens: 0,
    totalTokens: 60
  });
});

test('rejects malformed triage and detail fields without exposing their contents', async (context) => {
  const cases: Array<{name: string; request: NarutoMobileClassifyRequest; results: unknown[]}> = [
    {
      name: 'missing required field',
      request: requestFor('triage'),
      results: [{opinionId: 'opinion-1'}]
    },
    {
      name: 'unsupported enum',
      request: requestFor('detail'),
      results: [{...detailResult(), emotion: 'private invalid enum'}]
    },
    {
      name: 'oversized generated string',
      request: requestFor('detail'),
      results: [{...detailResult(), claim: 'x'.repeat(501)}]
    },
    {
      name: 'unexpected generated field',
      request: requestFor('triage'),
      results: [{...triageResult(), secret: 'private output'}]
    }
  ];

  for (const candidate of cases) {
    await context.test(candidate.name, async () => {
      const fetchImpl = (async () => successResponse(candidate.results)) as typeof fetch;
      await assert.rejects(serviceWith(fetchImpl).classify(candidate.request), rejectsAs(502));
    });
  }
});

test('rejects missing, unknown, and duplicate result IDs', async (context) => {
  const cases: Array<{name: string; request: NarutoMobileClassifyRequest; results: unknown[]}> = [
    {name: 'missing result', request: requestFor('triage'), results: []},
    {name: 'unknown ID', request: requestFor('triage'), results: [triageResult('private-id')]},
    {
      name: 'duplicate ID',
      request: requestFor('triage', ['opinion-1', 'opinion-2']),
      results: [triageResult('opinion-1'), triageResult('opinion-1')]
    }
  ];

  for (const candidate of cases) {
    await context.test(candidate.name, async () => {
      const fetchImpl = (async () => successResponse(candidate.results)) as typeof fetch;
      await assert.rejects(serviceWith(fetchImpl).classify(candidate.request), rejectsAs(502));
    });
  }
});

test('rejects invalid or inconsistent token usage', async (context) => {
  const cases: Array<{name: string; usage: unknown}> = [
    {name: 'missing usage', usage: undefined},
    {name: 'non-numeric input', usage: {...validUsage, input_tokens: 'private usage'}},
    {
      name: 'cached input exceeds input',
      usage: {...validUsage, input_tokens_details: {cached_tokens: 51}}
    },
    {
      name: 'reasoning exceeds output',
      usage: {...validUsage, output_tokens_details: {reasoning_tokens: 11}}
    },
    {name: 'output exceeds request ceiling', usage: {...validUsage, output_tokens: 3_001, total_tokens: 3_051}},
    {name: 'total is inconsistent', usage: {...validUsage, total_tokens: 61}}
  ];

  for (const candidate of cases) {
    await context.test(candidate.name, async () => {
      const fetchImpl = (async () => successResponse([triageResult()], {usage: candidate.usage})) as typeof fetch;
      await assert.rejects(serviceWith(fetchImpl).classify(requestFor('triage')), rejectsAs(502));
    });
  }
});

test('maps upstream rate and server failures without parsing or exposing their bodies', async (context) => {
  const cases = [
    {name: 'rate limit', status: 429, expected: 429, retryAfter: '7'},
    {name: 'server failure', status: 500, expected: 503, retryAfter: undefined}
  ];

  for (const candidate of cases) {
    await context.test(candidate.name, async () => {
      const fetchImpl = (async () => new Response('private upstream failure', {
        status: candidate.status,
        headers: candidate.retryAfter ? {'retry-after': candidate.retryAfter} : undefined
      })) as typeof fetch;
      await assert.rejects(
        serviceWith(fetchImpl).classify(requestFor('triage')),
        (error: unknown) => {
          rejectsAs(candidate.expected)(error);
          assert.equal(
            (error as NarutoMobileUpstreamError).retryAfterSeconds,
            candidate.retryAfter ? Number(candidate.retryAfter) : undefined
          );
          return true;
        }
      );
    });
  }
});

test('rejects oversized and malformed successful provider envelopes as 502', async (context) => {
  await context.test('declared response is too large', async () => {
    const fetchImpl = (async () => new Response('{}', {
      status: 200,
      headers: {'content-length': String(2 * 1024 * 1024 + 1)}
    })) as typeof fetch;
    await assert.rejects(serviceWith(fetchImpl).classify(requestFor('triage')), rejectsAs(502));
  });

  await context.test('streamed response exceeds the byte cap without Content-Length', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      privatePadding: 'x'.repeat(2 * 1024 * 1024)
    }), {status: 200})) as typeof fetch;
    await assert.rejects(serviceWith(fetchImpl).classify(requestFor('triage')), rejectsAs(502));
  });

  await context.test('response JSON is malformed', async () => {
    const fetchImpl = (async () => new Response('private malformed json', {status: 200})) as typeof fetch;
    await assert.rejects(serviceWith(fetchImpl).classify(requestFor('triage')), rejectsAs(502));
  });
});

test('maps provider timeout and an already-aborted parent request to generic 503 errors', async (context) => {
  const waitingFetch = (async (_input: string | URL | Request, init?: RequestInit) => (
    new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new Error('private aborted request'));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener('abort', abort, {once: true});
    })
  )) as typeof fetch;

  await context.test('provider timeout', async () => {
    await assert.rejects(
      serviceWith(waitingFetch, 5).classify(requestFor('triage')),
      rejectsAs(503)
    );
  });

  await context.test('provider body timeout', async () => {
    const stalledBodyFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => controller.error(new Error('private stalled body'));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener('abort', abort, {once: true});
        }
      });
      return new Response(body, {status: 200});
    }) as typeof fetch;
    await assert.rejects(
      serviceWith(stalledBodyFetch, 5).classify(requestFor('triage')),
      rejectsAs(503)
    );
  });

  await context.test('parent was already aborted', async () => {
    const parent = new AbortController();
    parent.abort();
    await assert.rejects(
      serviceWith(waitingFetch).classify(requestFor('triage'), parent.signal),
      rejectsAs(503)
    );
  });
});
