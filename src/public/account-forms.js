// Drives the Kashewt account pages (/account/*) against the browser JSON
// endpoints under /auth/browser. Each page is a static shell with one
// [data-state] block per step; this script reveals exactly one at a time.
(() => {
  const root = document.querySelector('[data-account-page]');
  if (!root) return;
  const page = root.getAttribute('data-account-page');

  const tokenPattern = /^#token=([A-Za-z0-9_-]{43})$/;
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const controlCharacters = /[\u0000-\u001f\u007f]/;
  const genericError = 'Something went wrong. Please try again.';
  const resetEmailKey = 'kashewt:reset-email';

  /** Posts JSON same-origin; never throws for HTTP errors. */
  const postJson = async (path, body) => {
    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      const retryAfter = Number(response.headers.get('Retry-After'));
      return { status: response.status, payload, retryAfter: Number.isFinite(retryAfter) ? Math.min(retryAfter, 60) : null };
    } catch {
      return { status: 0, payload: null, retryAfter: null };
    }
  };

  const code = (result) => (result.payload && typeof result.payload.code === 'string' ? result.payload.code : '');

  /** Maps the responses every form shares; specific codes are handled by callers first. */
  const describeFailure = (result) => {
    if (result.status === 429) {
      return result.retryAfter ? `Too many attempts. Try again in ${result.retryAfter} seconds.` : 'Too many attempts. Please wait a moment and try again.';
    }
    if (code(result) === 'email_domain_undeliverable') return 'This email domain can’t receive mail. Check the spelling and try again.';
    return genericError;
  };

  const showState = (name, { focus = true } = {}) => {
    root.querySelectorAll('[data-state]').forEach((element) => {
      element.hidden = element.getAttribute('data-state') !== name;
    });
    const heading = root.querySelector(`[data-state="${name}"] h1:not([hidden])`);
    if (heading && focus) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  };

  const message = (form, selector, text) => {
    const element = form.querySelector(selector);
    if (!element) return;
    element.textContent = text || '';
    element.hidden = !text;
    if (text) element.focus();
  };
  /** Shows a form error; with `field`, marks that input invalid and describes it by the error. */
  const showError = (form, text, field) => {
    const error = form.querySelector('[data-form-error]');
    if (error && !error.id) error.id = `${form.getAttribute('data-form')}-error`;
    form.querySelectorAll('[aria-invalid="true"]').forEach((input) => {
      input.removeAttribute('aria-invalid');
      if (error && input.getAttribute('aria-describedby') === error.id) input.removeAttribute('aria-describedby');
    });
    const input = field ? form.querySelector(`[name="${field}"]`) : null;
    if (text && input && error) {
      input.setAttribute('aria-invalid', 'true');
      if (!input.hasAttribute('aria-describedby')) input.setAttribute('aria-describedby', error.id);
      message(form, '[data-form-error]', text);
      input.focus();
      return;
    }
    message(form, '[data-form-error]', text);
  };
  /** Errors that belong to the email field, so it is marked invalid and keeps focus. */
  const showEmailError = (form, result) => showError(form, describeFailure(result), code(result) === 'email_domain_undeliverable' ? 'email' : undefined);
  const showStatus = (form, text) => message(form, '[data-form-status]', text);

  /** Disables the submit button and swaps its label while a request runs. */
  const busy = (form, isBusy) => {
    const submit = form.querySelector('button[type="submit"]');
    if (!submit) return;
    if (isBusy) {
      submit.dataset.idleLabel = submit.textContent;
      submit.textContent = submit.getAttribute('data-busy-label') || submit.textContent;
    } else if (submit.dataset.idleLabel) {
      submit.textContent = submit.dataset.idleLabel;
    }
    submit.disabled = isBusy;
    form.setAttribute('aria-busy', String(isBusy));
  };

  const readEmail = (form) => String(new FormData(form).get('email') || '').trim().toLowerCase();

  /** Wires a form to an async handler with busy state and a single in-flight request. */
  const handle = (selector, handler) => {
    const form = root.querySelector(`form[data-form="${selector}"]`);
    if (!form) return null;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (form.getAttribute('aria-busy') === 'true') return;
      showError(form, '');
      busy(form, true);
      try {
        await handler(form);
      } finally {
        busy(form, false);
      }
    });
    return form;
  };

  // A link opened while its page is already showing changes only the fragment;
  // reload so the new token is read from a fresh page.
  if (page === 'register-complete' || page === 'verify-email') {
    window.addEventListener('hashchange', () => {
      if (tokenPattern.test(window.location.hash)) window.location.reload();
    });
  }

  /** Reads the one-time link token once, then removes it from the address bar and history. */
  const takeLinkToken = () => {
    const match = tokenPattern.exec(window.location.hash);
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    return match ? match[1] : null;
  };

  const validatePasswords = (form) => {
    const data = new FormData(form);
    const password = String(data.get('password') || '');
    if (password.length < 12 || password.length > 256) return { error: 'Use a password between 12 and 256 characters.' };
    if (password !== String(data.get('confirmPassword') || '')) return { error: 'The passwords do not match.' };
    return { password };
  };

  const goToLogin = (notice) => window.location.assign(`/auth/login-web?notice=${encodeURIComponent(notice)}`);

  const setEmail = (stateName, email) => {
    const input = root.querySelector(`[data-state="${stateName}"] [data-account-email]`);
    if (input) input.value = email;
  };

  // Typo suggestions for email fields; typing again also clears an earlier field error.
  const suggest = globalThis.kashewtSuggestEmailCorrection;
  root.querySelectorAll('[data-email-suggestion]').forEach((button) => {
    const input = button.previousElementSibling;
    if (!(input instanceof HTMLInputElement)) return;
    let timer = null;
    const hide = () => {
      button.hidden = true;
      button.textContent = '';
      delete button.dataset.value;
    };
    input.addEventListener('input', () => {
      hide();
      window.clearTimeout(timer);
      if (input.getAttribute('aria-invalid') === 'true' && input.form) showError(input.form, '');
      timer = window.setTimeout(() => {
        const suggestion = typeof suggest === 'function' ? suggest(input.value) : null;
        if (!suggestion || suggestion === input.value.trim()) return;
        button.dataset.value = suggestion;
        button.textContent = `Did you mean ${suggestion}?`;
        button.hidden = false;
      }, 500);
    });
    button.addEventListener('click', () => {
      if (button.dataset.value) input.value = button.dataset.value;
      hide();
      input.focus();
    });
    input.form?.addEventListener('submit', () => {
      window.clearTimeout(timer);
      hide();
    }, true);
  });

  if (page === 'register') {
    let lastEmail = '';
    handle('register', async (form) => {
      const email = readEmail(form);
      if (!emailPattern.test(email)) return showError(form, 'Enter a valid email address.', 'email');
      const result = await postJson('/auth/browser/registration/request', { email });
      if (result.status !== 202) return showEmailError(form, result);
      lastEmail = email;
      const target = root.querySelector('[data-sent-email]');
      if (target) target.textContent = lastEmail;
      showState('sent');
    });
    root.querySelector('[data-action="restart"]')?.addEventListener('click', () => {
      showState('form', { focus: false });
      const input = root.querySelector('#register-email');
      if (input) {
        input.value = '';
        input.focus();
      }
    });
    (async () => {
      try {
        const response = await fetch('/auth/browser/capabilities', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        const capabilities = response.ok ? await response.json() : null;
        if (capabilities && capabilities.emailRegistration === false) showState('unavailable', { focus: false });
      } catch {
        // Leave the form up; the request endpoint still refuses when sign-up is unavailable.
      }
    })();
  }

  if (page === 'register-complete') {
    const token = takeLinkToken();
    const inspect = async () => {
      if (!token) return showState('invalid');
      showState('checking');
      const result = await postJson('/auth/browser/registration/inspect', { token });
      if (result.status === 200 && result.payload && typeof result.payload.email === 'string') {
        setEmail('form', result.payload.email);
        return showState('form');
      }
      if (result.status === 400) return showState('invalid');
      if (result.status === 409) return showState('exists');
      return showState('error');
    };
    root.querySelector('[data-action="retry"]')?.addEventListener('click', inspect);
    handle('register-complete', async (form) => {
      const displayName = String(new FormData(form).get('displayName') || '').trim();
      if (!displayName || displayName.length > 80 || controlCharacters.test(displayName)) {
        return showError(form, 'Enter a display name between 1 and 80 characters.');
      }
      const checked = validatePasswords(form);
      if (checked.error) return showError(form, checked.error);
      const result = await postJson('/auth/browser/registration/complete', { token, password: checked.password, displayName });
      if (result.status === 201) return goToLogin('registered');
      if (result.status === 400) return showState('invalid');
      if (result.status === 409) return showState('exists');
      if (code(result) === 'invalid_password') return showError(form, 'Choose a different password. Use 12–256 characters and avoid common passwords.');
      if (code(result) === 'invalid_display_name') return showError(form, 'Enter a display name between 1 and 80 characters.');
      return showError(form, describeFailure(result));
    });
    inspect();
  }

  if (page === 'verify-email') {
    const token = takeLinkToken();
    const showRequest = (variant) => {
      root.querySelectorAll('[data-state="request"] [data-variant]').forEach((element) => {
        element.hidden = element.getAttribute('data-variant') !== variant;
      });
      showState('request');
    };
    handle('verify-request', async (form) => {
      showStatus(form, '');
      const email = readEmail(form);
      if (!emailPattern.test(email)) return showError(form, 'Enter a valid email address.', 'email');
      const result = await postJson('/auth/browser/email-verification/request', { email });
      if (result.status !== 202) return showEmailError(form, result);
      showStatus(form, 'If this address needs verification, we sent a link. Check your email.');
    });
    handle('verify-confirm', async (form) => {
      const result = await postJson('/auth/browser/email-verification/confirm', { token });
      if (result.status === 204) return goToLogin('verified');
      if (result.status === 400) return showRequest('invalid');
      return showError(form, describeFailure(result));
    });
    (async () => {
      if (!token) return showRequest('request');
      const result = await postJson('/auth/browser/email-verification/inspect', { token });
      if (result.status === 200 && result.payload && typeof result.payload.email === 'string') {
        setEmail('confirm', result.payload.email);
        return showState('confirm');
      }
      return showRequest('invalid');
    })();
  }

  if (page === 'forgot-password') {
    handle('forgot-password', async (form) => {
      showStatus(form, '');
      const email = readEmail(form);
      if (!emailPattern.test(email)) return showError(form, 'Enter a valid email address.', 'email');
      const result = await postJson('/auth/browser/password/forgot', { email });
      if (result.status !== 202) return showEmailError(form, result);
      try { window.sessionStorage.setItem(resetEmailKey, email); } catch { /* optional prefill only */ }
      showStatus(form, 'If this address can reset a password, we sent a recovery email with a six-digit code.');
      const next = root.querySelector('[data-reveal-on-sent]');
      if (next) next.hidden = false;
    });
  }

  if (page === 'reset-password') {
    const form = handle('reset-password', async (target) => {
      const email = readEmail(target);
      const resetCode = String(new FormData(target).get('code') || '').trim();
      if (!emailPattern.test(email)) return showError(target, 'Enter a valid email address.', 'email');
      if (!/^\d{6}$/.test(resetCode)) return showError(target, 'Enter the six-digit code from your email.');
      const checked = validatePasswords(target);
      if (checked.error) return showError(target, checked.error);
      const result = await postJson('/auth/browser/password/reset', { email, code: resetCode, password: checked.password });
      if (result.status === 204) {
        try { window.sessionStorage.removeItem(resetEmailKey); } catch { /* ignore */ }
        return goToLogin('password_reset');
      }
      if (result.status === 400) return showError(target, 'That reset code is invalid or has expired. Request another code.');
      if (result.status === 422) return showError(target, 'Check the email, code, and password, then try again. Passwords need 12–256 characters and can’t be a common password.');
      return showError(target, describeFailure(result));
    });
    try {
      const saved = window.sessionStorage.getItem(resetEmailKey);
      const input = form?.querySelector('input[name="email"]');
      if (saved && input && !input.value) input.value = saved;
    } catch { /* storage unavailable */ }
  }
})();
