const minimumPasswordLength = 12;
const maximumPasswordLength = 256;

// This bounded denylist catches common compromised choices without transmitting passwords.
const commonCompromisedPasswords = new Set([
    '123456789012',
    'abcdefghijkl',
    'letmein123456',
    'password1234',
    'qwerty123456',
    'welcome123456'
]);

export interface PasswordPolicyResult {
    accepted: boolean;
    message?: string;
}

/** Enforces the server's shared password policy without logging or exporting the password. */
export const evaluatePassword = (value: unknown): PasswordPolicyResult => {
    if (typeof value !== 'string'
        || value.length < minimumPasswordLength
        || value.length > maximumPasswordLength) {
        return {
            accepted: false,
            message: `Use a password between ${minimumPasswordLength} and ${maximumPasswordLength} characters.`
        };
    }

    if (commonCompromisedPasswords.has(value.toLowerCase())) {
        return {
            accepted: false,
            message: 'Choose a less common password.'
        };
    }

    return { accepted: true };
};

/** Adapts the policy for express-validator while keeping one source of truth. */
export const requireAcceptablePassword = (value: unknown) => {
    const result = evaluatePassword(value);
    if (!result.accepted) {
        throw new Error(result.message);
    }
    return true;
};
