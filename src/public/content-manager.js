(() => {
  const compositionDataElement = document.getElementById('composition-data');
  const compositionData = compositionDataElement
    ? JSON.parse(compositionDataElement.textContent || '')
    : { pages: [], carousels: [], albums: [], audioTracks: [] };
  const carouselNames = new Map(compositionData.carousels.map((carousel) => [carousel.id, carousel.name]));
  const albumTitles = new Map(compositionData.albums.map((album) => [album.id, album.title]));
  const trackTitles = new Map(compositionData.audioTracks.map((track) => [track.id, track.title]));
  const uploadResultsKey = 'archtree.bulkUploadResults';
  const uploadResultsPanel = document.getElementById('bulk-upload-results');

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
    const config = form.querySelector('.artist-carousel-config');
    const configFields = [...config.querySelectorAll('select, input')];
    const updateMode = () => {
      const isArtist = selector.value === 'artist';
      config.hidden = !isArtist;
      configFields.forEach((field) => {
        field.disabled = !isArtist;
        field.required = isArtist;
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
      form.querySelector('select[name="artistSort"]').value = carousel.artistConfig.sort;
      form.querySelector('input[name="artistLimit"]').value = String(carousel.artistConfig.limit);
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

  document.querySelectorAll('.drag-reorder').forEach((form) => {
    const kind = form.dataset.kind;
    const selector = form.querySelector('.reorder-selector');
    const list = form.querySelector('.drag-list');
    const fromInput = form.querySelector('.from-index');
    const toInput = form.querySelector('.to-index');
    const saveButton = form.querySelector('.save-reorder');
    let draggedItem = null;

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
        element.textContent = kind === 'page'
          ? (carouselNames.get(item.carouselId) || item.carouselId)
          : labelForCarouselItem(item);
        list.append(element);
      });
    };

    selector.addEventListener('change', renderItems);
    list.addEventListener('dragstart', (event) => {
      draggedItem = event.target.closest('.drag-item');
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
      [...targetSelector.options].forEach((option) => {
        option.disabled = Boolean(option.value) && option.value === sourceSelector.value;
      });
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

    const uploadFile = (file, albumId, fileIndex, fileCount, onProgress) => {
      return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        const formData = new FormData();
        formData.append('audioFiles', file);
        if (albumId) formData.append('albumId', albumId);

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
      const albumId = bulkUploadForm.querySelector('select[name="albumId"]').value;
      const failures = [];
      const succeeded = [];

      for (let index = 0; index < files.length; index += 1) {
        try {
          await uploadFile(files[index], albumId, index, files.length, (fileProgress) => {
            const percentage = Math.round(((index + fileProgress) / files.length) * 100);
            showStatus(`Uploading ${index + 1} of ${files.length}… ${percentage}%`, percentage);
          });
          succeeded.push(files[index].name);
        } catch (error) {
          failures.push({
            name: files[index].name,
            error: error.message
          });
        }

        showStatus(`Processed ${index + 1} of ${files.length} files…`, Math.round(((index + 1) / files.length) * 100));
      }

      const results = { succeeded, failed: failures };
      if (succeeded.length > 0) {
        try {
          sessionStorage.setItem(uploadResultsKey, JSON.stringify(results));
        } catch (error) {
          // The count summary still appears when session storage is unavailable.
        }
        const message = `${succeeded.length} audio track${succeeded.length === 1 ? '' : 's'} created and uploaded.${failures.length > 0 ? ` ${failures.length} failed.` : ''}`;
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
    audioFile: 'Audio file'
  };

  document.querySelectorAll('form input, form select, form textarea').forEach((field, index) => {
    if (field.type === 'hidden' || field.type === 'submit' || field.type === 'button') return;

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

  document.querySelectorAll('button[data-danger]').forEach((button) => {
    const form = button.closest('form');
    if (!form || form.matches('[data-batch-track-delete]')) return;
    form.addEventListener('submit', (event) => {
      if (!window.confirm('Delete this item? This action cannot be undone.')) {
        event.preventDefault();
      }
    });
  });
})();
