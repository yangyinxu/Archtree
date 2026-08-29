export const NARUTO_MOBILE_PROTOCOL_VERSION = 1 as const;
export const NARUTO_MOBILE_PROMPT_VERSION = 'naruto-opinion-v3';
export const NARUTO_MOBILE_TRIAGE_VERSION = 'naruto-triage-v3';

export type NarutoMobileClassificationKind = 'triage' | 'detail';

export interface NarutoMobileOpinionInput {
  opinionId: string;
  content: {
    type: 'video' | 'dynamic';
    title: string;
    description: string;
    publishedAt: string | null;
  };
  opinion: {
    sourceType: 'comment' | 'reply' | 'danmaku' | 'creator_view';
    voiceType: 'viewer' | 'creator';
    text: string;
    parentText: string | null;
    likes: number;
    replies: number;
    publishedAt: string | null;
  };
}

export interface NarutoMobileClassifyRequest {
  protocolVersion: typeof NARUTO_MOBILE_PROTOCOL_VERSION;
  kind: NarutoMobileClassificationKind;
  batch: NarutoMobileOpinionInput[];
}

export interface NarutoMobileUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface NarutoMobileClassifyResponse {
  protocolVersion: typeof NARUTO_MOBILE_PROTOCOL_VERSION;
  kind: NarutoMobileClassificationKind;
  promptVersion: string;
  model: string;
  results: unknown[];
  usage: NarutoMobileUsage;
}

export class NarutoMobileProtocolError extends Error {
  readonly statusCode = 400;
}

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], label: string) => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new NarutoMobileProtocolError(`${label} contains unsupported or missing fields.`);
  }
};

const objectValue = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NarutoMobileProtocolError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  options: { nullable: true; pattern?: RegExp }
): string | null;
function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  options?: { nullable?: false; pattern?: RegExp }
): string;
function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  options: { nullable?: boolean; pattern?: RegExp } = {}
): string | null {
  if (options.nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > maximum || (options.pattern && !options.pattern.test(value))) {
    throw new NarutoMobileProtocolError(`${label} is invalid.`);
  }
  return value;
}

const boundedCount = (value: unknown, label: string) => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000_000) {
    throw new NarutoMobileProtocolError(`${label} is invalid.`);
  }
  return Number(value);
};

const parseOpinionInput = (raw: unknown, index: number): NarutoMobileOpinionInput => {
  const item = objectValue(raw, `batch[${index}]`);
  exactKeys(item, ['opinionId', 'content', 'opinion'], `batch[${index}]`);
  const opinionId = boundedString(
    item.opinionId,
    `batch[${index}].opinionId`,
    160,
    { pattern: /^[A-Za-z0-9._:-]+$/ }
  );

  const content = objectValue(item.content, `batch[${index}].content`);
  exactKeys(content, ['type', 'title', 'description', 'publishedAt'], `batch[${index}].content`);
  if (content.type !== 'video' && content.type !== 'dynamic') {
    throw new NarutoMobileProtocolError(`batch[${index}].content.type is invalid.`);
  }

  const opinion = objectValue(item.opinion, `batch[${index}].opinion`);
  exactKeys(
    opinion,
    ['sourceType', 'voiceType', 'text', 'parentText', 'likes', 'replies', 'publishedAt'],
    `batch[${index}].opinion`
  );
  if (!['comment', 'reply', 'danmaku', 'creator_view'].includes(String(opinion.sourceType))) {
    throw new NarutoMobileProtocolError(`batch[${index}].opinion.sourceType is invalid.`);
  }
  if (opinion.voiceType !== 'viewer' && opinion.voiceType !== 'creator') {
    throw new NarutoMobileProtocolError(`batch[${index}].opinion.voiceType is invalid.`);
  }

  return {
    opinionId,
    content: {
      type: content.type,
      title: boundedString(content.title, `batch[${index}].content.title`, 300),
      description: boundedString(content.description, `batch[${index}].content.description`, 900),
      publishedAt: boundedString(content.publishedAt, `batch[${index}].content.publishedAt`, 64, { nullable: true })
    },
    opinion: {
      sourceType: opinion.sourceType as NarutoMobileOpinionInput['opinion']['sourceType'],
      voiceType: opinion.voiceType,
      text: boundedString(opinion.text, `batch[${index}].opinion.text`, 2_400),
      parentText: boundedString(opinion.parentText, `batch[${index}].opinion.parentText`, 1_600, { nullable: true }),
      likes: boundedCount(opinion.likes, `batch[${index}].opinion.likes`),
      replies: boundedCount(opinion.replies, `batch[${index}].opinion.replies`),
      publishedAt: boundedString(opinion.publishedAt, `batch[${index}].opinion.publishedAt`, 64, { nullable: true })
    }
  };
};

/** Rejects arbitrary proxy payloads and returns the only protocol shape OpenAI may receive. */
export const parseNarutoMobileClassifyRequest = (raw: unknown): NarutoMobileClassifyRequest => {
  const request = objectValue(raw, 'request');
  exactKeys(request, ['protocolVersion', 'kind', 'batch'], 'request');
  if (request.protocolVersion !== NARUTO_MOBILE_PROTOCOL_VERSION) {
    throw new NarutoMobileProtocolError('Unsupported protocol version.');
  }
  if (request.kind !== 'triage' && request.kind !== 'detail') {
    throw new NarutoMobileProtocolError('Unsupported classification kind.');
  }
  if (!Array.isArray(request.batch) || request.batch.length === 0) {
    throw new NarutoMobileProtocolError('batch must contain at least one item.');
  }
  const maximum = request.kind === 'triage' ? 50 : 10;
  if (request.batch.length > maximum) {
    throw new NarutoMobileProtocolError(`batch exceeds the ${maximum}-item limit.`);
  }
  const batch = request.batch.map(parseOpinionInput);
  if (new Set(batch.map((item) => item.opinionId)).size !== batch.length) {
    throw new NarutoMobileProtocolError('batch contains duplicate opinion IDs.');
  }
  return { protocolVersion: 1, kind: request.kind, batch };
};
