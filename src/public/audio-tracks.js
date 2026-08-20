(() => {
  const filter = document.getElementById('track-filter');
  if (!filter) return;

  const statusFilter = document.getElementById('track-status-filter');
  const albumFilter = document.getElementById('track-album-filter');
  const reset = document.getElementById('track-filter-reset');
  const items = [...document.querySelectorAll('[data-track-item]')];
  const count = document.getElementById('track-filter-count');
  const empty = document.getElementById('track-filter-empty');
  const applyFilters = () => {
    const query = filter.value.trim().toLowerCase();
    const status = statusFilter?.value || '';
    const album = albumFilter?.value || '';
    let visible = 0;
    items.forEach((item) => {
      const matchesSearch = !query || item.dataset.search.includes(query);
      const matchesStatus = !status || item.dataset.status === status;
      const matchesAlbum = !album || item.dataset.album === album;
      const matches = matchesSearch && matchesStatus && matchesAlbum;
      item.hidden = !matches;
      if (matches) visible += 1;
    });
    count.textContent = visible + ' shown';
    empty.hidden = visible !== 0 || items.length === 0;
  };

  filter.addEventListener('input', applyFilters);
  statusFilter?.addEventListener('change', applyFilters);
  albumFilter?.addEventListener('change', applyFilters);
  reset?.addEventListener('click', () => {
    filter.value = '';
    if (statusFilter) statusFilter.value = '';
    if (albumFilter) albumFilter.value = '';
    applyFilters();
    filter.focus();
  });

  document.querySelectorAll('[data-copy-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const value = button.dataset.copyId || '';
      if (!value) return;
      const originalLabel = button.textContent;
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        const input = document.createElement('textarea');
        input.value = value;
        document.body.append(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      button.textContent = 'Copied';
      window.setTimeout(() => { button.textContent = originalLabel; }, 1200);
    });
  });
})();
