import { z } from 'zod';
import { apiRequest } from './client';
import { socialReadRequest } from './socialReadRequest';
import { captureAccountOperation, isAccountOperationCurrent } from './accountEpoch';

const base = '/api/social/v1';
export { socialIdSchema, socialRevisionSchema, socialCardSchema, socialProfileSchema, socialPageSchema, socialOutcomeSchema } from './socialSchemas';
import { socialIdSchema, socialRevisionSchema, socialCardSchema, socialProfileSchema, socialPageSchema, socialOutcomeSchema } from './socialSchemas';
const scopeSchema = z.object({ scopeToken: z.string().min(20).max(1024), expiresAt: z.string().datetime() }).strict();
export type SocialCard = z.infer<typeof socialCardSchema>;
export type SocialProfile = z.infer<typeof socialProfileSchema>;
export type SocialPage = z.infer<typeof socialPageSchema>;
export type SocialOutcome = z.infer<typeof socialOutcomeSchema>;
export type SocialListKind = 'friends' | 'incoming' | 'outgoing' | 'blocks';
export type SocialAction = { action: 'profile'; handle: string; alias: string; discoverable: boolean; expectedRevision: number }
  | { action: 'deactivate' }
  | { action: 'block'; targetSocialId: string }
  | { action: 'request' | 'accept' | 'decline' | 'cancel' | 'remove' | 'unblock'; targetSocialId: string; expectedRevision: number };
export type SocialCommand = SocialAction & { readonly scopeToken: string; readonly commandId: string };

export const getSocialProfile = (viewerId: string, signal?: AbortSignal) =>
  socialReadRequest(`${base}/me/profile`, z.object({ profile: socialProfileSchema.nullable() }).strict(), { accountViewer: viewerId, signal });
export const lookupSocialProfile = (viewerId: string, handle: string, signal?: AbortSignal) =>
  socialReadRequest(`${base}/profiles?${new URLSearchParams({ handle: handle.toLowerCase().trim() })}`,
    z.object({ profile: socialCardSchema.nullable() }).strict(), { accountViewer: viewerId, signal });
export const getSocialPage = (viewerId: string, kind: SocialListKind, cursor?: string, signal?: AbortSignal) => {
  const query = new URLSearchParams({ kind, limit: '20' });
  if (cursor) query.set('cursor', cursor);
  return socialReadRequest(`${base}/relationships?${query}`, socialPageSchema, { accountViewer: viewerId, signal });
};
export const getSocialRelationship = (viewerId: string, socialId: string) =>
  socialReadRequest(`${base}/relationships/${socialIdSchema.parse(socialId)}`, z.object({ relationship: z.object({
    socialId: socialIdSchema, state: z.enum(['none', 'incoming', 'outgoing', 'friends', 'blocked']), revision: socialRevisionSchema
  }).strict().nullable() }).strict(), { accountViewer: viewerId });

let cachedScope: { viewerId: string; guard: ReturnType<typeof captureAccountOperation>; scope: z.infer<typeof scopeSchema> } | undefined;
/** A fresh gesture may obtain a scope; retrying an existing command never changes its identity. */
export const prepareMutationIdentity = async (viewerId: string) => {
  const guard = captureAccountOperation(viewerId);
  if (!cachedScope || cachedScope.viewerId !== viewerId || !isAccountOperationCurrent(cachedScope.guard)
    || Date.parse(cachedScope.scope.expiresAt) <= Date.now() + 5000) {
    const scope = await apiRequest(`${base}/mutation-scopes`, scopeSchema, {
      method: 'POST', body: '{}', accountViewer: viewerId
    });
    if (!isAccountOperationCurrent(guard)) throw new Error('Account changed.');
    cachedScope = { viewerId, guard, scope };
  }
  return Object.freeze({ scopeToken: cachedScope.scope.scopeToken, commandId: crypto.randomUUID() });
};
export const prepareSocialCommand = async (viewerId: string, action: SocialAction): Promise<SocialCommand> => {
  const captured = Object.freeze({ ...action });
  return Object.freeze({ ...captured, ...await prepareMutationIdentity(viewerId) });
};

/** Sends exactly the original gesture; domain conflicts never become a rebased mutation. */
export const sendSocialCommand = (viewerId: string, command: SocialCommand) => {
  const { action, ...input } = command;
  let path = '/me/deactivate';
  let method = 'POST';
  let body: Record<string, unknown> = input;
  if (action === 'profile') { path = '/me/profile'; method = 'PATCH'; }
  else if (action === 'request') path = '/friend-requests';
  else if ('targetSocialId' in input) {
    path = `/relationships/${socialIdSchema.parse(input.targetSocialId)}/${action}`;
    const { targetSocialId: _target, ...remaining } = input;
    body = remaining;
  }
  return apiRequest(`${base}${path}`, socialOutcomeSchema, {
    method, body: JSON.stringify(body), accountViewer: viewerId
  });
};
export const getSocialOutcome = (viewerId: string, command: Pick<SocialCommand, 'scopeToken' | 'commandId'>) =>
  apiRequest(`${base}/mutation-outcomes`, z.object({ outcome: socialOutcomeSchema.nullable() }).strict(), {
    method: 'POST', accountViewer: viewerId,
    body: JSON.stringify({ scopeToken: command.scopeToken, commandId: command.commandId })
  });
