(() => {
  const compositionDataElement = document.getElementById('composition-data');
  const compositionData = compositionDataElement
    ? JSON.parse(compositionDataElement.textContent || '')
    : { pages: [], carousels: [], contentCollections: [], albums: [], audioTracks: [] };
  const carouselNames = new Map(compositionData.carousels.map((carousel) => [carousel.id, carousel.name]));
  const collectionNames = new Map(
    (compositionData.contentCollections || []).map((collection) => [collection.id, collection.name])
  );
  const albumTitles = new Map(compositionData.albums.map((album) => [album.id, album.title]));
  const trackTitles = new Map(compositionData.audioTracks.map((track) => [track.id, track.title]));
  const uploadResultsKey = 'archtree.bulkUploadResults';
  const uploadResultsPanel = document.getElementById('bulk-upload-results');

  // Safety controls initialize before optional workspace enhancements so a
  // broken enhancement cannot silently remove destructive confirmations.
  document.querySelectorAll('button[data-danger]').forEach((button) => {
    const form = button.closest('form');
    if (!form || form.matches('[data-batch-track-delete]')) return;
    form.addEventListener('submit', (event) => {
      const action = button.textContent.trim() || 'Delete this item';
      if (!window.confirm(action + '? This action cannot be undone.')) {
        event.preventDefault();
      }
    });
  });

  document.querySelectorAll('[data-confirm-attribution-unknown]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!window.confirm('Mark attribution as not documented? This removes every current Credit from this item.')) {
        event.preventDefault();
      }
    });
  });

  document.querySelectorAll('[data-copy-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const value = button.dataset.copyId || '';
      if (!value) return;
      const originalLabel = button.textContent;
      try {
        await navigator.clipboard.writeText(value);
        button.textContent = 'Copied';
      } catch (error) {
        const fallback = document.createElement('textarea');
        fallback.value = value;
        fallback.setAttribute('readonly', '');
        fallback.style.position = 'fixed';
        fallback.style.opacity = '0';
        document.body.append(fallback);
        fallback.select();
        document.execCommand('copy');
        fallback.remove();
        button.textContent = 'Copied';
      }
      window.setTimeout(() => { button.textContent = originalLabel; }, 1600);
    });
  });

  document.querySelectorAll('[data-reference-picker]').forEach((picker) => {
    const type = picker.dataset.referenceType;
    const typeLabel = type === 'artist'
      ? 'Artist'
      : type === 'organization'
        ? 'Organization'
        : type === 'audioTrack' ? 'Soundtrack' : 'Album';
    const query = picker.querySelector('[data-reference-query]');
    const searchButton = picker.querySelector('[data-reference-search]');
    const results = picker.querySelector('[data-reference-results]');
    const status = picker.querySelector('[data-reference-status]');
    const form = picker.closest('form');
    const submitButton = form ? form.querySelector('[data-reference-submit]') : null;
    if (!query || !searchButton || !results || !status) return;

    const setReady = (ready) => {
      results.disabled = !ready;
      if (submitButton) submitButton.disabled = !ready || !results.value;
    };
    results.addEventListener('change', () => setReady(results.options.length > 1));
    query.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        searchButton.click();
      }
    });
    searchButton.addEventListener('click', async () => {
      const searchQuery = query.value.trim();
      if (!searchQuery) {
        status.textContent = 'Enter a title to search.';
        query.focus();
        return;
      }
      searchButton.disabled = true;
      status.textContent = 'Searching…';
      results.replaceChildren(new Option('Searching…', ''));
      setReady(false);
      try {
        const response = await fetch(`/content/manage/reference-search?type=${encodeURIComponent(type)}&q=${encodeURIComponent(searchQuery)}`, {
          headers: { Accept: 'application/json' }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || 'Search failed.');
        const items = Array.isArray(payload.items) ? payload.items : [];
        results.replaceChildren(new Option(
          items.length > 0 ? `Select a ${typeLabel}` : `No matching ${typeLabel}s`,
          ''
        ));
        items.forEach((item) => results.append(new Option(item.label, item.id)));
        setReady(items.length > 0);
        status.textContent = items.length > 0
          ? `${items.length} result${items.length === 1 ? '' : 's'} found.`
          : `No matching ${typeLabel}s found.`;
        if (items.length > 0) results.focus();
      } catch (error) {
        results.replaceChildren(new Option('Search unavailable', ''));
        status.textContent = error.message || 'Search failed.';
        setReady(false);
      } finally {
        searchButton.disabled = false;
      }
    });
  });

  const releaseSetupForm = document.querySelector('[data-release-setup]');
  if (releaseSetupForm) {
    const artistMode = releaseSetupForm.querySelector('[data-artist-mode]');
    const existingArtist = releaseSetupForm.querySelector('[data-existing-artist]');
    const newArtist = releaseSetupForm.querySelector('[data-new-artist]');
    const createCarousel = releaseSetupForm.querySelector('[data-create-carousel]');
    const carouselConfig = releaseSetupForm.querySelector('[data-carousel-config]');
    const review = releaseSetupForm.querySelector('[data-release-review]');
    const submitButton = releaseSetupForm.querySelector('button[type="submit"]');
    const draftKey = 'archtree.artistReleaseDraft';
    let isSubmittingRelease = false;
    if (new URLSearchParams(window.location.search).get('workflowComplete') === '1') {
      sessionStorage.removeItem(draftKey);
    }

    const fieldsIn = (container) => [...container.querySelectorAll('input, select, textarea')];
    const updateMode = () => {
      const isNew = artistMode.value === 'new';
      existingArtist.hidden = isNew;
      newArtist.hidden = !isNew;
      fieldsIn(existingArtist).forEach((field) => { field.disabled = isNew; });
      fieldsIn(newArtist).forEach((field) => { field.disabled = !isNew; });
      const artistName = newArtist.querySelector('input[name="artistName"]');
      if (artistName) artistName.required = isNew;
      const existingId = existingArtist.querySelector('select[name="existingArtistId"]');
      if (existingId) existingId.required = !isNew;
    };
    const updateCarousel = () => {
      carouselConfig.hidden = !createCarousel.checked;
      fieldsIn(carouselConfig).forEach((field) => { field.disabled = !createCarousel.checked; });
    };
    const selectedText = (select) => select && select.value
      ? select.options[select.selectedIndex]?.textContent || select.value
      : 'not selected';
    const updateReview = () => {
      const isNew = artistMode.value === 'new';
      const artist = isNew
        ? releaseSetupForm.elements.artistName.value.trim() || 'new Artist (name required)'
        : selectedText(releaseSetupForm.elements.existingArtistId);
      const album = releaseSetupForm.elements.albumTitle.value.trim() || 'Album title required';
      const presentation = createCarousel.checked
        ? `dynamic Album carousel${releaseSetupForm.elements.pageSlug.value ? ` on ${releaseSetupForm.elements.pageSlug.value}` : ''}`
        : 'no Carousel or Page change';
      review.textContent = `Artist: ${artist}. Album: ${album}. Presentation: ${presentation}.`;
    };
    const saveDraft = () => {
      const draft = {};
      [...releaseSetupForm.elements].forEach((field) => {
        if (!field.name || field.type === 'file' || field.name === 'idempotencyToken') return;
        draft[field.name] = field.type === 'checkbox' ? field.checked : field.value;
      });
      try { sessionStorage.setItem(draftKey, JSON.stringify(draft)); } catch (error) {
        // Draft persistence is a progressive enhancement.
      }
    };
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
      if (draft) {
        Object.entries(draft).forEach(([name, value]) => {
          const field = releaseSetupForm.elements[name];
          if (!field) return;
          if (field.type === 'checkbox') field.checked = Boolean(value);
          else field.value = String(value);
        });
      }
    } catch (error) {
      // A malformed or unavailable session store does not block setup.
    }
    artistMode.addEventListener('change', updateMode);
    createCarousel.addEventListener('change', updateCarousel);
    releaseSetupForm.addEventListener('input', () => {
      updateMode();
      updateCarousel();
      updateReview();
      saveDraft();
    });
    releaseSetupForm.addEventListener('change', () => {
      updateReview();
      saveDraft();
    });
    releaseSetupForm.addEventListener('submit', () => {
      isSubmittingRelease = true;
      submitButton.disabled = true;
      submitButton.textContent = 'Creating Artist, Album, and presentation…';
    });
    window.addEventListener('beforeunload', (event) => {
      const hasSelectedFile = [...releaseSetupForm.querySelectorAll('input[type="file"]')]
        .some((input) => input.files && input.files.length > 0);
      if (!isSubmittingRelease && hasSelectedFile) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    updateMode();
    updateCarousel();
    updateReview();
  }

  const renderUploadResults = (results) => {
    if (!uploadResultsPanel || !results) return;

    const grid = uploadResultsPanel.querySelector('.upload-results__grid');
    grid.replaceChildren();

    const addResultList = (title, entries, className, renderEntry) => {
      if (entries.length === 0) return;
      const section = document.createElement('div');
      section.className = className;
      const heading = document.createElement('h3');
      heading.textContent = `${title} (${entries.length})`;
      const list = document.createElement('ul');
      entries.forEach((entry) => list.append(renderEntry(entry)));
      section.append(heading, list);
      grid.append(section);
    };

    addResultList('Succeeded', results.succeeded || [], 'upload-results__success', (fileName) => {
      const item = document.createElement('li');
      item.textContent = fileName;
      return item;
    });
    addResultList('Failed', results.failed || [], 'upload-results__failure', (failure) => {
      const item = document.createElement('li');
      const fileName = document.createElement('strong');
      fileName.textContent = failure.name;
      const reason = document.createElement('small');
      reason.textContent = failure.error;
      item.append(fileName, document.createElement('br'), reason);
      return item;
    });
    addResultList('Per-item lifecycle outcomes', results.outcomes || [], 'upload-results__outcomes', (outcome) => {
      const item = document.createElement('li');
      const fileName = document.createElement('strong');
      fileName.textContent = outcome.originalFileName || 'Unnamed file';
      const lifecycle = document.createElement('small');
      const trackId = outcome.audioTrackId ? `Track ${outcome.audioTrackId}; ` : '';
      const error = outcome.error ? `; ${outcome.error}` : '';
      lifecycle.textContent = `${trackId}upload=${outcome.uploadStatus}; publication=${outcome.publicationStatus}${error}`;
      item.append(fileName, document.createElement('br'), lifecycle);
      return item;
    });

    uploadResultsPanel.hidden = grid.children.length === 0;
  };

  try {
    const storedUploadResults = sessionStorage.getItem(uploadResultsKey);
    if (storedUploadResults) {
      sessionStorage.removeItem(uploadResultsKey);
      renderUploadResults(JSON.parse(storedUploadResults));
    }
  } catch (error) {
    // Upload completion still works when session storage is unavailable.
  }

  document.querySelectorAll('.carousel-mode').forEach((selector) => {
    const form = selector.closest('form');
    const artistConfig = form.querySelector('.artist-carousel-config');
    const personalizedConfig = form.querySelector('.personalized-carousel-config');
    const artistFields = [...artistConfig.querySelectorAll('select, input')];
    const personalizedFields = [...personalizedConfig.querySelectorAll('select, input')];
    const updateMode = () => {
      const isArtist = selector.value === 'artist';
      const isPersonalized = selector.value === 'personalized';
      artistConfig.hidden = !isArtist;
      personalizedConfig.hidden = !isPersonalized;
      artistFields.forEach((field) => {
        field.disabled = !isArtist;
        field.required = isArtist;
      });
      personalizedFields.forEach((field) => {
        field.disabled = !isPersonalized;
        field.required = isPersonalized;
      });
    };
    selector.addEventListener('change', updateMode);
    updateMode();
  });

  document.querySelectorAll('.update-artist-carousel').forEach((form) => {
    const selector = form.querySelector('.artist-carousel-selector');
    selector.addEventListener('change', () => {
      const carousel = compositionData.carousels.find((item) => item.id === selector.value);
      if (!carousel || !carousel.artistConfig) return;
      form.querySelector('input[name="name"]').value = carousel.name;
      form.querySelector('select[name="artistId"]').value = carousel.artistConfig.artistId;
      form.querySelector('select[name="artistContentType"]').value = carousel.artistConfig.contentType;
      form.querySelector('select[name="artistScope"]').value = carousel.artistConfig.scope || 'discography';
      form.querySelector('select[name="artistSort"]').value = carousel.artistConfig.sort;
      form.querySelector('input[name="artistLimit"]').value = String(carousel.artistConfig.limit);
    });
  });

  document.querySelectorAll('.update-personalized-carousel').forEach((form) => {
    const selector = form.querySelector('.personalized-carousel-selector');
    selector.addEventListener('change', () => {
      const carousel = compositionData.carousels.find((item) => item.id === selector.value);
      if (!carousel || !carousel.personalizedConfig) return;
      form.querySelector('input[name="name"]').value = carousel.name;
      form.querySelector('select[name="personalizedSource"]').value = carousel.personalizedConfig.source;
      form.querySelector('input[name="personalizedLimit"]').value = String(carousel.personalizedConfig.limit);
    });
  });

  document.querySelectorAll('.rename-manual-carousel').forEach((form) => {
    const selector = form.querySelector('.manual-carousel-selector');
    selector.addEventListener('change', () => {
      const carousel = compositionData.carousels.find((item) => item.id === selector.value);
      form.querySelector('input[name="name"]').value = carousel ? carousel.name : '';
    });
  });

  const labelForCarouselItem = (item) => {
    if (item.contentType === 'album') return 'Album: ' + (albumTitles.get(item.contentId) || item.contentId);
    if (item.contentType === 'audioTrack') return 'Track: ' + (trackTitles.get(item.contentId) || item.contentId);
    return item.contentType + ': ' + item.contentId;
  };

  const labelForPageItem = (item) => {
    if (item.itemType === 'grid' || item.itemType === 'list') {
      const type = item.itemType === 'grid' ? 'Grid' : 'List';
      return `${type}: ${collectionNames.get(item.collectionId) || item.collectionId || 'Unavailable reference'}`;
    }
    return `Carousel: ${carouselNames.get(item.carouselId) || item.carouselId || 'Unavailable reference'}`;
  };

  document.querySelectorAll('.drag-reorder').forEach((form) => {
    const kind = form.dataset.kind;
    const selector = form.querySelector('.reorder-selector');
    const list = form.querySelector('.drag-list');
    const fromInput = form.querySelector('.from-index');
    const toInput = form.querySelector('.to-index');
    const saveButton = form.querySelector('.save-reorder');
    let draggedItem = null;

    // Each reorder endpoint persists one item move, so keep a pending edit scoped to that item.
    const updateMoveButtons = () => {
      const activeOriginalIndex = fromInput.value;
      [...list.children].forEach((element, index) => {
        const locked = Boolean(activeOriginalIndex)
          && element.dataset.originalIndex !== activeOriginalIndex;
        const buttons = element.querySelectorAll('.drag-item__actions button');
        if (buttons[0]) buttons[0].disabled = locked || index === 0;
        if (buttons[1]) buttons[1].disabled = locked || index === list.children.length - 1;
        element.draggable = !locked;
      });
    };

    const selectMove = (element, targetIndex) => {
      const currentIndex = [...list.children].indexOf(element);
      if (targetIndex < 0 || targetIndex >= list.children.length || targetIndex === currentIndex) return;
      const reference = targetIndex > currentIndex
        ? list.children[targetIndex].nextSibling
        : list.children[targetIndex];
      list.insertBefore(element, reference);
      fromInput.value = element.dataset.originalIndex || '';
      toInput.value = String([...list.children].indexOf(element));
      saveButton.disabled = fromInput.value === toInput.value;
      updateMoveButtons();
      element.querySelector('.drag-item__label')?.focus();
    };

    const renderItems = () => {
      list.replaceChildren();
      fromInput.value = '';
      toInput.value = '';
      saveButton.disabled = true;
      if (!selector.value) return;

      const source = kind === 'page'
        ? compositionData.pages.find((page) => page.slug === selector.value)
        : compositionData.carousels.find((carousel) => carousel.id === selector.value);
      const items = source ? [...source.items].sort((a, b) => a.order - b.order) : [];
      items.forEach((item, index) => {
        const element = document.createElement('li');
        element.className = 'drag-item';
        element.draggable = true;
        element.dataset.originalIndex = String(index);
        const label = document.createElement('span');
        label.className = 'drag-item__label';
        label.tabIndex = -1;
        label.textContent = kind === 'page'
          ? labelForPageItem(item)
          : labelForCarouselItem(item);
        const actions = document.createElement('span');
        actions.className = 'drag-item__actions';
        const moveUp = document.createElement('button');
        moveUp.className = 'button--secondary';
        moveUp.type = 'button';
        moveUp.textContent = 'Move up';
        moveUp.disabled = index === 0;
        moveUp.addEventListener('click', () => selectMove(element, [...list.children].indexOf(element) - 1));
        const moveDown = document.createElement('button');
        moveDown.className = 'button--secondary';
        moveDown.type = 'button';
        moveDown.textContent = 'Move down';
        moveDown.disabled = index === items.length - 1;
        moveDown.addEventListener('click', () => selectMove(element, [...list.children].indexOf(element) + 1));
        actions.append(moveUp, moveDown);
        element.append(label, actions);
        list.append(element);
      });
    };

    selector.addEventListener('change', renderItems);
    list.addEventListener('dragstart', (event) => {
      const candidate = event.target.closest('.drag-item');
      if (fromInput.value && candidate?.dataset.originalIndex !== fromInput.value) return;
      draggedItem = candidate;
      if (draggedItem) draggedItem.classList.add('dragging');
    });
    list.addEventListener('dragend', () => {
      if (draggedItem) draggedItem.classList.remove('dragging');
      draggedItem = null;
      list.querySelectorAll('.drag-over').forEach((item) => item.classList.remove('drag-over'));
    });
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      const target = event.target.closest('.drag-item');
      if (target && target !== draggedItem) target.classList.add('drag-over');
    });
    list.addEventListener('dragleave', (event) => {
      const target = event.target.closest('.drag-item');
      if (target) target.classList.remove('drag-over');
    });
    list.addEventListener('drop', (event) => {
      event.preventDefault();
      const target = event.target.closest('.drag-item');
      if (!draggedItem || !target || target === draggedItem) return;
      const targetBounds = target.getBoundingClientRect();
      list.insertBefore(draggedItem, event.clientY > targetBounds.top + targetBounds.height / 2 ? target.nextSibling : target);
      fromInput.value = draggedItem.dataset.originalIndex || '';
      toInput.value = String([...list.children].indexOf(draggedItem));
      saveButton.disabled = fromInput.value === toInput.value;
      updateMoveButtons();
      target.classList.remove('drag-over');
    });
  });

  document.querySelectorAll('.move-carousel-items').forEach((form) => {
    const sourceSelector = form.querySelector('.move-source-carousel');
    const targetSelector = form.querySelector('.move-target-carousel');
    const itemList = form.querySelector('.move-item-list');
    const submitButton = form.querySelector('.move-selected-items');

    const updateButton = () => {
      submitButton.disabled = !sourceSelector.value
        || !targetSelector.value
        || sourceSelector.value === targetSelector.value
        || itemList.querySelectorAll('input[name="fromIndexes"]:checked').length === 0;
    };

    const renderMoveChoices = () => {
      itemList.replaceChildren();
      if (targetSelector.options) {
        [...targetSelector.options].forEach((option) => {
          option.disabled = Boolean(option.value) && option.value === sourceSelector.value;
        });
      }
      if (targetSelector.value === sourceSelector.value) targetSelector.value = '';

      const source = compositionData.carousels.find((carousel) => carousel.id === sourceSelector.value);
      const items = source ? [...source.items].sort((a, b) => a.order - b.order) : [];
      if (items.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty-linked-content';
        empty.textContent = source ? 'This carousel has no items.' : 'Choose a source carousel to see its items.';
        itemList.append(empty);
        updateButton();
        return;
      }

      items.forEach((item, index) => {
        const listItem = document.createElement('li');
        const label = document.createElement('label');
        label.className = 'move-item-choice';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = 'fromIndexes';
        checkbox.value = String(index);
        const text = document.createElement('span');
        text.textContent = labelForCarouselItem(item);
        label.append(checkbox, text);
        listItem.append(label);
        itemList.append(listItem);
      });
      updateButton();
    };

    sourceSelector.addEventListener('change', renderMoveChoices);
    targetSelector.addEventListener('change', updateButton);
    itemList.addEventListener('change', updateButton);
  });

  const bulkUploadForm = document.getElementById('bulk-audio-upload-form');
  if (bulkUploadForm) {
    const status = document.getElementById('bulk-upload-status');
    const progress = document.getElementById('bulk-upload-progress');
    const progressLabel = document.getElementById('bulk-upload-progress-label');
    const button = bulkUploadForm.querySelector('button[type="submit"]');

    const showStatus = (message, percentage) => {
      status.hidden = false;
      if (typeof percentage === 'number') progress.value = percentage;
      progressLabel.textContent = message;
    };

    const uploadFile = (
      file,
      artistId,
      albumId,
      artistRole,
      organizationId,
      organizationRole,
      inheritAlbumPrimaryCredits,
      attributionUnknown,
      promoteToAlbumPrimary,
      fileIndex,
      fileCount,
      onProgress
    ) => {
      return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        const formData = new FormData();
        formData.append('audioFiles', file);
        if (artistId) formData.append('artistId', artistId);
        if (albumId) formData.append('albumId', albumId);
        formData.append('artistRole', artistRole);
        if (organizationId) formData.append('organizationId', organizationId);
        formData.append('organizationRole', organizationRole);
        if (inheritAlbumPrimaryCredits) formData.append('inheritAlbumPrimaryCredits', 'true');
        if (attributionUnknown) formData.append('attributionUnknown', 'true');
        if (promoteToAlbumPrimary) formData.append('promoteToAlbumPrimary', 'true');

        request.open('POST', bulkUploadForm.action);
        request.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
        request.upload.addEventListener('progress', (progressEvent) => {
          if (progressEvent.lengthComputable) {
            onProgress(progressEvent.loaded / progressEvent.total);
          }
        });
        request.addEventListener('load', () => {
          let response = {};
          try {
            response = JSON.parse(request.responseText);
          } catch (error) {
            // Proxy and other non-JSON responses use the HTTP status message.
          }

          if (request.status >= 200 && request.status < 300) {
            resolve(response);
            return;
          }
          reject(new Error(response.message || `Upload ${fileIndex + 1} of ${fileCount} failed.`));
        });
        request.addEventListener('error', () => {
          reject(new Error(`Upload ${fileIndex + 1} of ${fileCount} failed before reaching the server.`));
        });
        request.send(formData);
      });
    };

    bulkUploadForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const files = bulkUploadForm.querySelector('input[name="audioFiles"]').files;
      if (!files || files.length === 0) return;

      button.disabled = true;
      showStatus('Starting upload…', 0);
      const artistId = bulkUploadForm.querySelector('select[name="artistId"]').value;
      const albumId = bulkUploadForm.querySelector('select[name="albumId"]').value;
      const artistRole = bulkUploadForm.querySelector('select[name="artistRole"]').value;
      const organizationId = bulkUploadForm.querySelector('select[name="organizationId"]').value;
      const organizationRole = bulkUploadForm.querySelector('select[name="organizationRole"]').value;
      const inheritAlbumPrimaryCredits = bulkUploadForm
        .querySelector('input[name="inheritAlbumPrimaryCredits"]').checked;
      const attributionUnknown = bulkUploadForm
        .querySelector('input[name="attributionUnknown"]').checked;
      const promoteToAlbumPrimary = bulkUploadForm
        .querySelector('input[name="promoteToAlbumPrimary"]').checked;
      if (!artistId && !organizationId && !(albumId && inheritAlbumPrimaryCredits) && !attributionUnknown) {
        showStatus('Choose an Artist, Organization, inherited Album Artist, or undocumented attribution.', 0);
        button.disabled = false;
        return;
      }
      if (attributionUnknown && (artistId || organizationId || (albumId && inheritAlbumPrimaryCredits))) {
        showStatus('Undocumented attribution cannot be combined with selected or inherited Credits.', 0);
        button.disabled = false;
        return;
      }
      const failures = [];
      const succeeded = [];
      const outcomes = [];

      for (let index = 0; index < files.length; index += 1) {
        try {
          const response = await uploadFile(
            files[index],
            artistId,
            albumId,
            artistRole,
            organizationId,
            organizationRole,
            inheritAlbumPrimaryCredits,
            attributionUnknown,
            promoteToAlbumPrimary,
            index,
            files.length,
            (fileProgress) => {
            const percentage = Math.round(((index + fileProgress) / files.length) * 100);
            showStatus(`Uploading ${index + 1} of ${files.length}… ${percentage}%`, percentage);
            }
          );
          const itemOutcomes = Array.isArray(response.outcomes) ? response.outcomes : [];
          outcomes.push(...itemOutcomes);
          const publicationFailed = itemOutcomes.some((outcome) =>
            outcome.uploadStatus !== 'ready' || outcome.publicationStatus !== 'ready'
          );
          if (publicationFailed) {
            const firstFailure = itemOutcomes.find((outcome) => outcome.error) || itemOutcomes[0];
            failures.push({
              name: files[index].name,
              error: firstFailure
                ? `${firstFailure.audioTrackId ? `Track ${firstFailure.audioTrackId}: ` : ''}${firstFailure.error || `upload=${firstFailure.uploadStatus}, publication=${firstFailure.publicationStatus}`}`
                : 'Publication did not complete.'
            });
          } else {
            succeeded.push(files[index].name);
          }
        } catch (error) {
          failures.push({
            name: files[index].name,
            error: error.message
          });
        }

        showStatus(`Processed ${index + 1} of ${files.length} files…`, Math.round(((index + 1) / files.length) * 100));
      }

      const results = { succeeded, failed: failures, outcomes };
      if (succeeded.length > 0) {
        try {
          sessionStorage.setItem(uploadResultsKey, JSON.stringify(results));
        } catch (error) {
          // The count summary still appears when session storage is unavailable.
        }
        const message = `${succeeded.length} audio track${succeeded.length === 1 ? '' : 's'} uploaded and published.${failures.length > 0 ? ` ${failures.length} require attention; their Track IDs and lifecycle outcomes are listed below.` : ''}`;
        window.location.assign(`/content/manage?message=${encodeURIComponent(message)}`);
        return;
      }

      renderUploadResults(results);
      showStatus(failures[0]?.error || 'Every upload failed. Please try again.', 0);
      button.disabled = false;
    });
  }

  const labels = {
    slug: 'Page',
    carouselId: 'Carousel',
    sourceCarouselId: 'Source carousel',
    targetCarouselId: 'Target carousel',
    contentType: 'Content type',
    mode: 'Carousel type',
    artistId: 'Artist',
    artistContentType: 'Generated content',
    artistSort: 'Sort order',
    artistLimit: 'Maximum items',
    albumId: 'Album',
    birthDate: 'Birth date',
    releaseDate: 'Release date',
    audioFiles: 'Audio files',
    audioFile: 'Audio file',
    coverArtFile: 'Cover art (JPG, PNG, or WebP)'
  };

  document.querySelectorAll('form input, form select, form textarea').forEach((field, index) => {
    if (field.type === 'hidden' || field.type === 'submit' || field.type === 'button') return;
    if (field.labels && field.labels.length > 0) return;

    const labelText = field.dataset.label || field.getAttribute('placeholder') || labels[field.name];
    if (!labelText) return;

    const id = field.id || 'content-field-' + index;
    field.id = id;
    const label = document.createElement('label');
    label.className = 'field-label';
    label.htmlFor = id;
    label.textContent = labelText;
    field.before(label);
  });

  document.querySelectorAll('[data-batch-track-delete]').forEach((form) => {
    const button = form.querySelector('.batch-delete-button');
    const selectAllButton = form.querySelector('.select-all-tracks');
    const trackCheckboxes = [...form.querySelectorAll('input[name="audioTrackIds"]')];
    if (!button || !selectAllButton || trackCheckboxes.length === 0) return;
    const selectedTracks = () => form.querySelectorAll('input[name="audioTrackIds"]:checked');
    const updateBatchControls = () => {
      button.disabled = selectedTracks().length === 0;
      selectAllButton.textContent = selectedTracks().length === trackCheckboxes.length ? 'Clear selection' : 'Select all';
    };
    form.addEventListener('change', updateBatchControls);
    selectAllButton.addEventListener('click', () => {
      const selectAll = selectedTracks().length !== trackCheckboxes.length;
      trackCheckboxes.forEach((checkbox) => {
        checkbox.checked = selectAll;
      });
      updateBatchControls();
    });
    form.addEventListener('submit', (event) => {
      const count = selectedTracks().length;
      if (count === 0 || !window.confirm('Delete ' + count + ' selected audio track' + (count === 1 ? '' : 's') + '? This also removes their uploaded files.')) {
        event.preventDefault();
      }
    });
  });

})();
