import { useEffect, useState } from 'react';

/** Offline is a distinct state, never a successful empty inventory. */
export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => { const update = () => setOnline(navigator.onLine !== false); window.addEventListener('online', update); window.addEventListener('offline', update); return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); }; }, []);
  return online;
}
