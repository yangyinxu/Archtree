/** Emits structured security events without credentials, tokens, or email addresses. */
export const recordSecurityEvent = (
    event: string,
    context: { userId?: string; sessionId?: string } = {}
) => {
    console.info(JSON.stringify({
        category: 'security',
        event,
        occurredAt: new Date().toISOString(),
        ...context
    }));
};

export type AuthenticationMethod = 'password' | 'email' | 'apple' | 'google' | 'passkey';
export type AuthenticationOutcome = 'started' | 'succeeded' | 'rejected';

/** Records bounded funnel dimensions without identity, email, token, or network address. */
export const recordAuthFunnelEvent = (
    stage: 'registration' | 'verification' | 'login' | 'recovery' | 'link',
    method: AuthenticationMethod,
    outcome: AuthenticationOutcome
) => {
    console.info(JSON.stringify({
        category: 'authentication_funnel',
        stage,
        method,
        outcome,
        occurredAt: new Date().toISOString()
    }));
};
