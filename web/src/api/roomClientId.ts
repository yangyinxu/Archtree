let clientId: string | undefined;
/** A fresh document cannot inherit the controller identity copied by Duplicate Tab. */
export const roomClientId = () => {
  if (clientId) return clientId;
  clientId = crypto.randomUUID();
  return clientId;
};
