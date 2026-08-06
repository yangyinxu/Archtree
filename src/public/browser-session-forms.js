(() => {
  const pendingLogoutViewerKey = 'finitude:pending-logout-viewer';
  document.addEventListener('submit', (event) => {
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
  }, true);
})();
