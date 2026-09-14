const retryDelaysMs = [50, 100, 200, 400, 600] as const;

export const SOCIAL_TRANSACTION_ATTEMPTS = retryDelaysMs.length + 1;

/** Known-aborted transactions get at most 1,595 ms of backoff; jitter separates contending actors. */
export const waitForSocialTransactionRetry = async (attempt: number): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt] + Math.floor(Math.random() * 50)));
};
