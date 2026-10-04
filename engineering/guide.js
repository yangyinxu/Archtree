/* Enhance navigation and command copying without making reading depend on JavaScript. */
(() => {
  const menu = document.querySelector('.sidebar-menu');
  const compact = window.matchMedia('(max-width: 900px)');
  const updateMenu = () => { if (menu) menu.open = !compact.matches; };
  updateMenu();
  compact.addEventListener('change', updateMenu);

  // Language belongs to the URL, so deep links work without browser storage or JavaScript.
  document.querySelectorAll('[data-language-link]').forEach(link => {
    link.addEventListener('click', () => {
      const destination = new URL(link.href);
      destination.hash = window.location.hash;
      link.href = destination.href;
    });
  });

  if (navigator.clipboard?.writeText) {
    document.querySelectorAll('[data-copy-code]').forEach(button => {
      button.hidden = false;
      button.addEventListener('click', async () => {
        const text = button.closest('.code-example')?.querySelector('code')?.textContent;
        const status = document.getElementById('copy-status');
        if (!text || !status) return;
        try {
          await navigator.clipboard.writeText(text);
          status.textContent = button.dataset.copySuccess;
          button.textContent = button.dataset.copiedLabel;
          window.setTimeout(() => { button.textContent = button.dataset.copyLabel; }, 2000);
        } catch {
          status.textContent = button.dataset.copyFailure;
        }
      });
    });
  }

  const links = [...document.querySelectorAll('.page-outline nav a')];
  if ('IntersectionObserver' in window && links.length) {
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      links.forEach(link => {
        if (link.hash === `#${visible.target.id}`) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    }, { rootMargin: '-8% 0px -65% 0px' });
    document.querySelectorAll('.guide-section').forEach(section => observer.observe(section));
  }
})();
