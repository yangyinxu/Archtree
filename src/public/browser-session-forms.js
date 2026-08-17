(() => {
  const pendingLogoutViewerKey = 'finitude:pending-logout-viewer';
  const sessionTransitionLockName = 'finitude:browser-session-transition';
  const sessionChangeStorageKey = 'finitude:browser-session-change';

  /** Notifies other same-origin tabs without publishing account data. */
  const publishSessionChange = (reason) => {
    const id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const change = { id, reason };
    try {
      const channel = new BroadcastChannel(sessionChangeStorageKey);
      channel.postMessage(change);
      channel.close();
    } catch {
      // The storage event remains the cross-tab fallback.
    }
    try {
      window.localStorage.setItem(sessionChangeStorageKey, JSON.stringify(change));
    } catch {
      // The redirect still gives this tab authoritative server-rendered state.
    }
  };

  /** Keeps a form-provided redirect on the current origin. */
  const safeSameOriginDestination = (value) => {
    try {
      const destination = new URL(String(value ?? '/'), window.location.origin);
      if (destination.origin !== window.location.origin) return '/';
      return `${destination.pathname}${destination.search}${destination.hash}`;
    } catch {
      return '/';
    }
  };

  /** Accepts only a bounded server message for inline form feedback. */
  const responseErrorMessage = async (response, fallback) => {
    try {
      const payload = await response.json();
      if (typeof payload?.message === 'string' && payload.message.length <= 500) {
        return payload.message;
      }
    } catch {
      // Fall through to a bounded generic message for non-JSON failures.
    }
    return fallback;
  };

  /** Clears only the departing viewer's device-local state after confirmed logout. */
  const completeLogout = (viewerId) => {
    try {
      if (viewerId) window.localStorage.removeItem(`finitude:search-history:${viewerId}`);
      window.sessionStorage.removeItem(pendingLogoutViewerKey);
    } catch {
      // Server-side logout remains authoritative when storage is unavailable.
    }
    publishSessionChange('logout');
  };

  /** Displays a bounded account-transition error without navigating away. */
  const showFormError = (form, message) => {
    let error = form.querySelector('[data-session-error]');
    if (!(error instanceof HTMLElement)) {
      error = document.createElement('p');
      error.className = 'alert alert--error';
      error.setAttribute('data-session-error', '');
      error.setAttribute('role', 'alert');
      error.setAttribute('tabindex', '-1');
      form.prepend(error);
    }
    error.textContent = message;
    error.hidden = false;
    error.focus();
  };

  const currentLocation = new URL(window.location.href);
  if (currentLocation.searchParams.get('sessionTransition') === 'logout') {
    currentLocation.searchParams.delete('sessionTransition');
    window.history.replaceState(window.history.state, '', currentLocation);
    let viewerId = '';
    try {
      viewerId = window.sessionStorage.getItem(pendingLogoutViewerKey)?.trim() ?? '';
    } catch {
      // The cross-tab event still reconciles the authoritative signed-out state.
    }
    completeLogout(viewerId.length <= 200 ? viewerId : '');
  }

  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)
      || form.getAttribute('action') !== '/auth/logout-web') return;
    const viewerId = String(new FormData(form).get('viewerId') ?? '').trim();
    if (!viewerId || viewerId.length > 200) return;
    try {
      window.sessionStorage.setItem(pendingLogoutViewerKey, viewerId);
    } catch {
      // Server-side revocation remains safe when browser storage is unavailable.
    }
    const locks = navigator.locks;
    if (!locks) return;

    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    form.setAttribute('aria-busy', 'true');
    if (submit instanceof HTMLButtonElement) submit.disabled = true;
    try {
      await locks.request(sessionTransitionLockName, { mode: 'exclusive' }, async () => {
        let response;
        try {
          response = await fetch('/auth/browser/logout', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'X-Finitude-Account-Viewer': viewerId,
              'X-Finitude-Session-Transition': 'web-locks-v1'
            },
            body: '{}'
          });
        } catch {
          throw new Error('Archtree could not log you out. Please try again.');
        }
        if (!response.ok) {
          throw new Error(await responseErrorMessage(
            response,
            'Archtree could not log you out. Please try again.'
          ));
        }
        completeLogout(viewerId);
        window.location.assign('/');
      });
    } catch (logoutError) {
      try {
        window.sessionStorage.removeItem(pendingLogoutViewerKey);
      } catch {
        // A future successful logout overwrites any stale pending marker.
      }
      showFormError(
        form,
        logoutError instanceof Error
          ? logoutError.message
          : 'Archtree could not log you out. Please try again.'
      );
    } finally {
      form.removeAttribute('aria-busy');
      if (submit instanceof HTMLButtonElement) submit.disabled = false;
    }
  }, true);

  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-browser-session-login]')) {
      return;
    }
    event.preventDefault();
    const error = form.querySelector('[data-login-error]');
    const submit = form.querySelector('button[type="submit"]');
    const locks = navigator.locks;
    if (!locks) {
      if (error instanceof HTMLElement) {
        error.textContent = 'This browser cannot safely coordinate login across tabs.';
        error.hidden = false;
        error.focus();
      }
      return;
    }

    if (error instanceof HTMLElement) {
      error.textContent = '';
      error.hidden = true;
    }
    form.setAttribute('aria-busy', 'true');
    if (submit instanceof HTMLButtonElement) submit.disabled = true;

    const fields = new FormData(form);
    try {
      await locks.request(sessionTransitionLockName, { mode: 'exclusive' }, async () => {
        const response = await fetch('/auth/browser/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Finitude-Session-Transition': 'web-locks-v1'
          },
          body: JSON.stringify({
            identifier: String(fields.get('identifier') ?? ''),
            password: String(fields.get('password') ?? '')
          })
        });
        if (!response.ok) throw new Error(await responseErrorMessage(
          response,
          'Archtree could not log you in. Please try again.'
        ));
        publishSessionChange('login');
        window.location.assign(safeSameOriginDestination(fields.get('returnTo')));
      });
    } catch (loginError) {
      if (error instanceof HTMLElement) {
        error.textContent = loginError instanceof Error
          ? loginError.message
          : 'Archtree could not log you in. Please try again.';
        error.hidden = false;
        error.focus();
      }
    } finally {
      form.removeAttribute('aria-busy');
      if (submit instanceof HTMLButtonElement) submit.disabled = false;
    }
  });
})();
