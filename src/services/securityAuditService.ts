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
