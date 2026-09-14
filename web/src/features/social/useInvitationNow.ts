import { useEffect, useState } from 'react';

/** Removes logically expired private cards without coupling the timer to a realtime connection. */
export const useInvitationNow = (expiresAtMs?: number) => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = expiresAtMs === undefined ? setInterval(update, 1000)
      : setTimeout(update, Math.max(1, Math.min(2_147_483_647, expiresAtMs - Date.now() + 1)));
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearTimeout(timer); clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [expiresAtMs]);
  return now;
};
