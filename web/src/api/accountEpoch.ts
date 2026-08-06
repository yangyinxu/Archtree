export interface AccountOperationGuard {
  epoch: number;
  viewerId: string;
}

let accountEpoch = 0;

/** Invalidates every account-owned callback captured before an identity transition. */
export const advanceAccountEpoch = () => {
  accountEpoch += 1;
  return accountEpoch;
};

/** Captures the account identity and transition generation owned by one operation. */
export const captureAccountOperation = (
  viewerId: string,
  epoch = accountEpoch
): AccountOperationGuard => ({
  epoch,
  viewerId
});

/** Prevents late callbacks from affecting a replacement account or a later epoch. */
export const isAccountOperationCurrent = (
  guard: AccountOperationGuard | undefined,
  currentViewerId = guard?.viewerId
) => Boolean(
  guard
  && guard.epoch === accountEpoch
  && guard.viewerId === currentViewerId
);
