/**
 * Serializes verification-email work for one normalized address within this
 * process (production runs a single instance).
 *
 * Registration responds before it hashes the password, creates the account
 * and sends the code. Without ordering, a resend pressed in that window looks
 * up an account that does not exist yet and is dropped; if the registration
 * email then fails, nothing is delivered. Registration therefore queues its
 * attempt here in the same synchronous turn as its response, without
 * awaiting the password hash first, so the address already has queued work
 * when the client's next request is handled. Work for an address runs one
 * task at a time, and a resend that arrives while a verification email for
 * the address is queued, being prepared (password hash, account write, code
 * write) or being sent waits for it: when that delivery succeeds the resend
 * coalesces into it (one email, one valid code), and only when it fails does
 * the resend issue and send its own code.
 *
 * After the wait limit below, later work runs alongside the stuck task. If
 * the stuck send completes after that work issued a newer code, the email it
 * delivers carries a code that is already void, so the user sees it rejected
 * and can resend.
 */
interface AddressLane {
    tail: Promise<void>;
    /** Resolves true when the newest queued verification email reached the mail provider. */
    verification?: Promise<boolean>;
}

const lanes = new Map<string, AddressLane>();

/**
 * Longest a task waits for earlier work on its address. The SES client has no
 * request timeout, and one stuck send must not block the address indefinitely.
 */
export const earlierWorkWaitLimitMs = 30_000;

/** Resolves with the promise's outcome, or `fallback` once the wait limit passes. */
const waitAtMost = <T>(promise: Promise<T>, fallback: T) => new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), earlierWorkWaitLimitMs);
    timer.unref?.();
    void promise.then(resolve, () => resolve(fallback)).finally(() => clearTimeout(timer));
});

/** Queues a registration attempt or resend; `work` resolves true when it sent a code. */
export const queueVerificationDelivery = (address: string, work: () => Promise<boolean>): Promise<boolean> => {
    const lane = lanes.get(address) ?? { tail: Promise.resolve() };
    lanes.set(address, lane);
    // Earlier work reports its own failure; this work runs after it either way.
    const result = waitAtMost(lane.tail, undefined).then(work);
    const settled = result.then(() => undefined, () => undefined);
    const sent = result.then(Boolean, () => false);
    lane.tail = settled;
    lane.verification = sent;
    void settled.then(() => {
        if (lanes.get(address)?.tail === settled) lanes.delete(address);
    });
    return result;
};

/** Resends a code unless a verification email already queued or in flight for the address is delivered. */
export const queueVerificationResend = async (address: string, work: () => Promise<boolean>) => {
    const pending = lanes.get(address)?.verification;
    if (pending && await waitAtMost(pending, false)) return true;
    return queueVerificationDelivery(address, work);
};
