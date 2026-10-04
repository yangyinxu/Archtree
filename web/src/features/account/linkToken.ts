import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

const linkTokenFragment = /^#token=([A-Za-z0-9_-]{43})$/;

/**
 * Reads an emailed link token from a URL fragment. Only `#token=<43 base64url
 * characters>` is accepted; any other fragment yields `null`, so a malformed
 * link lands on the page's invalid-link state without a request.
 */
export const readLinkToken = (hash: string): string | null => linkTokenFragment.exec(hash)?.[1] ?? null;

/**
 * Captures the token of an emailed link and immediately strips the fragment.
 *
 * The token lives only in React state: the lazy initializer captures it once
 * (and survives StrictMode's repeated effects), and the replace navigation
 * removes it from the address bar and the history entry. It never enters
 * router state, storage, telemetry or logs. A different link pasted into the
 * same tab (a fragment-only navigation) replaces the captured token.
 */
export const useLinkToken = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [token, setToken] = useState(() => readLinkToken(location.hash));

  useEffect(() => {
    if (!location.hash) return;
    const next = readLinkToken(location.hash);
    if (next) setToken(next);
    navigate(
      { pathname: location.pathname, search: location.search, hash: '' },
      { replace: true, state: null }
    );
  }, [location.hash, location.pathname, location.search, navigate]);

  return token;
};
