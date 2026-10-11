import assert from 'node:assert/strict';
import test from 'node:test';
import {decisionsTriageBody, parseDecisionsTriage} from '../src/narutoMobile/decisionsTriage';
import {decisionsResponse} from './fixtures/decisionsResponse';

const batch = [{opinionId: 'first'}, {opinionId: 'second'}];
test('builds named independent questions with only Decisions-supported parameters', () => {
  const body = decisionsTriageBody(batch);
  assert.deepEqual(Object.keys(body).sort(), ['input', 'model', 'questions']);
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.questions.length, 6);
  assert.equal(new Set(body.questions.map((q) => q.name)).size, 6);
  assert.match(body.questions[0].instructions, /opinionId="first"/);
});

test('high-confidence non-feedback is skipped; product feedback and uncertain skips are retained', () => {
  const response = decisionsResponse(['first', 'second'], {decision: 'skip', informationType: 'community_chatter'});
  assert.ok(parseDecisionsTriage(response, batch).every((r) => r.decision === 'skip'));
  for (const confidence of [0.5, 0.949]) {
    const uncertain = decisionsResponse(['first', 'second'], {decision: 'skip', confidence, informationType: 'community_chatter'});
    assert.ok(parseDecisionsTriage(uncertain, batch).every((r) => r.decision === 'uncertain'));
  }
  const feedback = decisionsResponse(['first', 'second'], {decision: 'skip'});
  assert.ok(parseDecisionsTriage(feedback, batch).every((r) => r.decision === 'uncertain'));
  const contradictory = decisionsResponse(['first', 'second'], {decision: 'skip', informationType: 'community_chatter', confidence: 0.5});
  contradictory.answers[0].confidence = 0.99;
  assert.equal(parseDecisionsTriage(contradictory, batch)[0].decision, 'uncertain');
});

test('refusals, invalid probabilities and low category confidence retain the affected opinion', () => {
  const base = () => decisionsResponse(['first', 'second'], {decision: 'skip', informationType: 'community_chatter'});
  const refusal = base();
  Object.assign(refusal.answers[0], {type: 'refusal'});
  assert.equal(parseDecisionsTriage(refusal, batch)[0].decision, 'uncertain');
  assert.equal(parseDecisionsTriage(refusal, batch)[1].decision, 'skip');
  const malformed = base();
  malformed.answers[0].confidence = NaN;
  assert.equal(parseDecisionsTriage(malformed, batch)[0].decision, 'uncertain');
  const invalidDistribution = base();
  invalidDistribution.answers[0].probabilities![0].probability = -1;
  assert.equal(parseDecisionsTriage(invalidDistribution, batch)[0].decision, 'uncertain');
  const uncertainCategory = base();
  uncertainCategory.answers[2].confidence = 0.9;
  assert.equal(parseDecisionsTriage(uncertainCategory, batch)[0].decision, 'uncertain');
});

test('rejects missing, duplicated, unknown and unnamed answers even if they appear to skip', () => {
  for (const mutate of [
    (r: ReturnType<typeof decisionsResponse>) => { r.answers.pop(); },
    (r: ReturnType<typeof decisionsResponse>) => { r.answers[1].name = r.answers[0].name; },
    (r: ReturnType<typeof decisionsResponse>) => { r.answers[1].name = 'unknown'; },
    (r: ReturnType<typeof decisionsResponse>) => { r.answers[1].name = ''; }
  ]) {
    const response = decisionsResponse(['first', 'second'], {decision: 'skip', informationType: 'community_chatter'});
    mutate(response);
    assert.throws(() => parseDecisionsTriage(response, batch));
  }
});
