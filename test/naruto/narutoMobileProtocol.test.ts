import assert from 'node:assert/strict';
import test from 'node:test';
import { NarutoMobileProtocolError, parseNarutoMobileClassifyRequest } from '../../src/narutoMobile/protocol';

const request = (type: unknown) => ({
  protocolVersion: 1,
  kind: 'triage',
  batch: [{
    opinionId: 'opinion-1',
    content: { type, title: '标题', description: '', publishedAt: null },
    opinion: { sourceType: 'comment', voiceType: 'viewer', text: '二技能后摇太长', parentText: null, likes: 0, replies: 0, publishedAt: null }
  }]
});

test('classify requests accept every content type the Naruto collector produces', () => {
  for (const type of ['video', 'dynamic', 'article']) {
    assert.equal(parseNarutoMobileClassifyRequest(request(type)).batch[0].content.type, type);
  }
});

test('classify requests reject unknown content types', () => {
  for (const type of ['live', '', null]) {
    assert.throws(() => parseNarutoMobileClassifyRequest(request(type)),
      (error: unknown) => error instanceof NarutoMobileProtocolError && error.message === 'batch[0].content.type is invalid.');
  }
});
