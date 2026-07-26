(() => {
  const filter = document.getElementById('track-filter');
  if (!filter) return;

  const items = [...document.querySelectorAll('[data-track-item]')];
  const count = document.getElementById('track-filter-count');
  const empty = document.getElementById('track-filter-empty');
  filter.addEventListener('input', () => {
    const query = filter.value.trim().toLowerCase();
    let visible = 0;
    items.forEach((item) => {
      const matches = !query || item.dataset.search.includes(query);
      item.hidden = !matches;
      if (matches) visible += 1;
    });
    count.textContent = visible + ' shown';
    empty.hidden = visible !== 0 || items.length === 0;
  });
})();
