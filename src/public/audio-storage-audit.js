(() => {
  document.querySelectorAll('form button[data-confirm]').forEach((button) => {
    const form = button.closest('form');
    if (!form) return;
    form.addEventListener('submit', (event) => {
      if (!window.confirm(button.dataset.confirm || 'Continue with this action?')) {
        event.preventDefault();
      }
    });
  });
})();
