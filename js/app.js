/*
 * Record Catalog UI. Plain DOM, no framework, no build step.
 * Records live in localStorage through RC.store. Lookups go to MusicBrainz through RC.mb.
 */
(function () {
  'use strict';

  const S = RC.store;
  const mb = RC.mb;
  const store = S.createStore(browserStorage());

  // ---------- Helpers ----------

  function browserStorage() {
    try {
      const probe = '__recordcatalog_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return window.localStorage;
    } catch (e) {
      return null;
    }
  }

  const $ = (selector) => document.querySelector(selector);

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'checked') el.checked = Boolean(value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child != null && child !== false) el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;
  const compare = (a, b) => a.localeCompare(b);
  const byYear = (a, b) => (a.year ?? 9999) - (b.year ?? 9999);
  const typeLabel = (item) => [item.primaryType, ...(item.secondaryTypes || [])].filter(Boolean).join(' + ');
  const meta = (...parts) => parts.filter(Boolean).join(' · ');

  function hue(text) {
    let value = 0;
    for (const ch of text) value = (value * 31 + ch.codePointAt(0)) % 360;
    return value;
  }

  function labelColor(item) {
    return `hsl(${hue(`${item.artist || ''}${item.title || ''}`)} 55% 52%)`;
  }

  // Cover art from the Cover Art Archive, over a placeholder for when there is none:
  // a vinyl label for thumbnails, a plain sleeve with the title for the big random pick.
  function cover(item, size) {
    const box = h('div', { class: `cover cover-${size}`, 'aria-hidden': 'true' });
    const placeholder = size === 'lg'
      ? h('div', { class: 'cover-ph' }, h('span', { class: 'sleeve-title' }, item.title), h('span', { class: 'sleeve-artist' }, item.artist))
      : h('div', { class: 'cover-ph' });
    placeholder.style.setProperty('--label', labelColor(item));
    box.append(placeholder);
    if (item.releaseGroupId) {
      const img = h('img', { src: mb.coverUrl(item.releaseGroupId, size === 'lg' ? 500 : 250), alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('load', () => box.classList.add('loaded'));
      img.addEventListener('error', () => img.remove());
      box.append(img);
    }
    return box;
  }

  function fillFormatSelect(select, anyLabel) {
    const options = S.FORMATS.map((format) => h('option', { value: format }, format));
    if (anyLabel) options.unshift(h('option', { value: '' }, anyLabel));
    select.replaceChildren(...options);
  }

  function ensureOption(select, value) {
    if (value && ![...select.options].some((option) => option.value === value)) select.append(h('option', { value }, value));
  }

  function setStatus(selector, text, kind) {
    const el = $(selector);
    el.textContent = text || '';
    el.dataset.kind = kind || '';
    el.hidden = !text;
  }

  function ago(timestamp) {
    const minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 2) return 'just now';
    if (minutes < 60) return `${minutes} minutes ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return plural(hours, 'hour') + ' ago';
    return plural(Math.round(hours / 24), 'day') + ' ago';
  }

  let toastTimer;
  function toast(message, action) {
    const el = $('#toast');
    el.replaceChildren(h('span', {}, message));
    if (action) {
      el.append(h('button', { type: 'button', class: 'toast-action', onclick: () => { action.run(); hideToast(); } }, action.label));
    }
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 6000 : 3000);
  }

  function hideToast() {
    $('#toast').classList.remove('show');
  }

  function addWithUndo(input) {
    const record = store.add(input);
    toast(`Added ${record.title}`, { label: 'Undo', run: () => store.remove(record.id) });
    return record;
  }

  // ---------- Navigation ----------

  const VIEWS = ['collection', 'add', 'random', 'discography'];

  function currentView() {
    const view = location.hash.slice(1);
    return VIEWS.includes(view) ? view : 'collection';
  }

  function showView() {
    const view = currentView();
    for (const name of VIEWS) {
      $(`#view-${name}`).hidden = name !== view;
      const link = $(`.tabs a[href="#${name}"]`);
      if (name === view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (view === 'random') renderRandomFilters();
    if (view === 'discography') renderDiscoArtists();
    window.scrollTo(0, 0);
  }

  // ---------- Collection ----------

  const SORTS = {
    artist: (a, b) => compare(S.normArtist(a.artist), S.normArtist(b.artist)) || byYear(a, b) || compare(S.normTitle(a.title), S.normTitle(b.title)),
    added: (a, b) => compare(b.addedAt, a.addedAt),
    year: (a, b) => byYear(a, b) || SORTS.artist(a, b),
    title: (a, b) => compare(S.normTitle(a.title), S.normTitle(b.title)),
  };

  function recordRow(record, showArtist) {
    return h('li', {},
      h('button', { type: 'button', class: 'record', onclick: () => openEditor(record.id) },
        cover(record, 'sm'),
        h('span', { class: 'record-text' },
          h('span', { class: 'record-title' }, record.title),
          h('span', { class: 'record-meta' }, meta(showArtist && record.artist, record.year, record.format)))));
  }

  function renderCollection() {
    const all = store.all();
    $('#nav-count').textContent = all.length;
    $('#collection-empty').hidden = all.length > 0;
    $('#collection-tools').hidden = all.length === 0;
    $('#collection-list').hidden = all.length === 0;
    $('#collection-summary').hidden = all.length === 0;
    if (!all.length) return;

    const query = S.fold($('#filter-text').value.trim());
    const format = $('#filter-format').value;
    const sort = $('#sort').value;
    const list = all
      .filter((r) => !format || r.format === format)
      .filter((r) => !query || S.fold(`${r.artist} ${r.title} ${r.notes} ${r.year || ''}`).includes(query))
      .sort(SORTS[sort] || SORTS.artist);

    const artistCount = S.collectionArtists(all).length;
    $('#collection-summary').textContent = list.length === all.length
      ? `${plural(all.length, 'record')} by ${plural(artistCount, 'artist')}`
      : `Showing ${list.length} of ${plural(all.length, 'record')}`;

    const target = $('#collection-list');
    if (!list.length) {
      target.replaceChildren(h('p', { class: 'muted center' }, 'No records match that search.'));
      return;
    }

    if (sort !== 'artist') {
      target.replaceChildren(h('ul', { class: 'records' }, list.map((r) => recordRow(r, true))));
      return;
    }

    const groups = [];
    for (const record of list) {
      const key = S.normArtist(record.artist);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.records.push(record);
      else groups.push({ key, name: record.artist, records: [record] });
    }
    target.replaceChildren(...groups.map((group) => h('section', { class: 'artist-group' },
      h('div', { class: 'artist-head' },
        h('h2', { class: 'artist-name' }, group.name, h('span', { class: 'artist-count' }, group.records.length)),
        h('button', { type: 'button', class: 'link small', onclick: () => goToDiscography(group.name) }, 'Discography')),
      h('ul', { class: 'records' }, group.records.map((r) => recordRow(r, false))))));
  }

  // ---------- Edit dialog ----------

  let editingId = null;

  function openEditor(id) {
    const record = store.get(id);
    if (!record) return;
    editingId = id;
    const fields = $('#edit-form').elements;
    fields.artist.value = record.artist;
    fields.title.value = record.title;
    fields.year.value = record.year || '';
    ensureOption(fields.format, record.format);
    fields.format.value = record.format;
    fields.notes.value = record.notes;
    $('#edit-cover').replaceChildren(cover(record, 'md'));
    const dialog = $('#edit-dialog');
    dialog.returnValue = '';
    dialog.showModal();
  }

  function onEditorClosed() {
    if ($('#edit-dialog').returnValue !== 'save' || !editingId) return;
    const fields = $('#edit-form').elements;
    try {
      store.update(editingId, {
        artist: fields.artist.value,
        title: fields.title.value,
        year: fields.year.value,
        format: fields.format.value,
        notes: fields.notes.value,
      });
      toast('Saved');
    } catch (e) {
      toast(e.message);
    }
  }

  function deleteEditing() {
    const record = store.get(editingId);
    if (!record) return;
    store.remove(record.id);
    $('#edit-dialog').close('deleted');
    toast(`Deleted ${record.title}`, { label: 'Undo', run: () => store.add(record) });
  }

  // ---------- Add ----------

  let results = [];
  let searchToken = 0;

  async function runSearch(task, label) {
    const token = ++searchToken;
    results = [];
    renderResults();
    setStatus('#search-status', label, 'busy');
    try {
      const found = await task();
      if (token !== searchToken) return;
      results = found;
      setStatus('#search-status', found.length ? '' : 'Nothing found. Try fewer words, check the spelling, or add it by hand below.');
      renderResults();
    } catch (e) {
      if (token === searchToken) setStatus('#search-status', e.message, 'error');
    }
  }

  function renderResults() {
    const all = store.all();
    $('#search-results').replaceChildren(...results.map((result) => {
      const owned = result.releaseGroupId ? all.filter((r) => r.releaseGroupId === result.releaseGroupId).length : 0;
      return h('li', { class: 'result' },
        cover(result, 'sm'),
        h('div', { class: 'result-text' },
          h('span', { class: 'record-title' }, result.title),
          h('span', { class: 'record-meta' }, meta(result.artist, result.year, typeLabel(result), result.media)),
          owned ? h('span', { class: 'badge' }, owned > 1 ? `${owned} in collection` : 'In collection') : null),
        h('button', { type: 'button', class: owned ? '' : 'primary', onclick: () => addFromResult(result) }, owned ? 'Add again' : 'Add'));
    }));
  }

  function addFromResult(result) {
    addWithUndo({
      artist: result.artist,
      title: result.title,
      year: result.year,
      format: result.formatHint || $('#add-format').value,
      artistId: result.artistId,
      releaseGroupId: result.releaseGroupId,
      releaseId: result.releaseId,
    });
  }

  function onSearchSubmit(event) {
    event.preventDefault();
    const fields = event.target.elements;
    const artist = fields.artist.value.trim();
    const title = fields.album.value.trim();
    if (!artist && !title) {
      setStatus('#search-status', 'Type an artist, an album title, or both.', 'error');
      return;
    }
    runSearch(() => mb.searchReleaseGroups({ artist, title }), 'Searching MusicBrainz…');
  }

  function onBarcodeSubmit(event) {
    event.preventDefault();
    const code = event.target.elements.barcode.value.replace(/\D/g, '');
    if (code.length < 8) {
      setStatus('#search-status', 'Barcodes are usually 12 or 13 digits. Check the number on the back of the sleeve.', 'error');
      return;
    }
    runSearch(() => mb.searchBarcode(code), 'Looking up that barcode…');
  }

  function onManualSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const fields = form.elements;
    try {
      addWithUndo({
        artist: fields.artist.value,
        title: fields.title.value,
        year: fields.year.value,
        format: fields.format.value,
        notes: fields.notes.value,
      });
    } catch (e) {
      toast(e.message);
      return;
    }
    // Keep the artist filled in, since people often add several records by one artist.
    const artist = fields.artist.value;
    form.reset();
    fields.artist.value = artist;
    fields.title.focus();
  }

  // ---------- Random ----------

  const recentPicks = [];

  function renderRandomFilters() {
    const select = $('#random-artist');
    const previous = select.value;
    const artists = S.collectionArtists(store.all());
    select.replaceChildren(h('option', { value: '' }, 'Any artist'), ...artists.map((a) => h('option', { value: a.key }, a.name)));
    select.value = artists.some((a) => a.key === previous) ? previous : '';
  }

  function spin() {
    const all = store.all();
    const format = $('#random-format').value;
    const artistKey = $('#random-artist').value;
    const pool = all.filter((r) => (!format || r.format === format) && (!artistKey || S.normArtist(r.artist) === artistKey));
    if (!pool.length) {
      setStatus('#random-status', all.length ? 'No records match those filters.' : 'Add some records first, then come back for a pick.', 'error');
      return;
    }
    setStatus('#random-status', '');

    const pick = S.pickRandom(pool, recentPicks);
    // Avoid repeating the last few picks, as long as there are other records to choose from.
    recentPicks.push(pick.id);
    while (recentPicks.length > Math.min(5, pool.length - 1)) recentPicks.shift();
    showPick(pick);
  }

  function showPick(record) {
    const stage = $('#spin-stage');
    stage.style.setProperty('--label', labelColor(record));
    $('#spin-sleeve').replaceChildren(cover(record, 'lg'));
    stage.classList.remove('spinning');
    void stage.offsetWidth; // restart the animation
    stage.classList.add('spinning');
    $('#spin-meta').replaceChildren(
      h('h2', { class: 'pick-title' }, record.title),
      h('p', { class: 'pick-artist' }, record.artist),
      h('p', { class: 'muted' }, meta(record.year, record.format)),
      ...(record.notes ? [h('p', { class: 'pick-notes' }, record.notes)] : []));
    $('#spin-btn').textContent = 'Pick another';
  }

  // ---------- Discography ----------

  let disco = null; // { artist: { id, name }, groups, total, truncated, fetchedAt }
  let discoToken = 0;
  let currentMissing = [];

  function renderDiscoArtists() {
    const select = $('#disco-artist');
    const previous = select.value;
    const artists = S.collectionArtists(store.all());
    select.replaceChildren(
      h('option', { value: '' }, artists.length ? 'Choose an artist' : 'No artists yet'),
      ...artists.map((a) => h('option', { value: a.key }, `${a.name} (${a.records.length})`)));
    select.value = artists.some((a) => a.key === previous) ? previous : '';
    select.disabled = !artists.length;
  }

  function goToDiscography(name) {
    location.hash = 'discography';
    openCollectionArtist(name);
  }

  function mostCommon(values) {
    const counts = new Map();
    values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
    return [...counts].sort((a, b) => b[1] - a[1])[0][0];
  }

  // Uses the MusicBrainz id saved on the records, or looks the name up once and remembers it.
  async function openCollectionArtist(name) {
    const key = S.normArtist(name);
    renderDiscoArtists();
    const group = S.collectionArtists(store.all()).find((a) => a.key === key);
    $('#disco-artist').value = group ? key : '';

    const ids = group ? group.records.map((r) => r.artistId).filter(Boolean) : [];
    if (ids.length) {
      loadDiscography({ id: mostCommon(ids), name: group.name });
      return;
    }

    const token = ++discoToken;
    $('#artist-results').replaceChildren();
    $('#disco-panel').hidden = true;
    setStatus('#artist-status', `Looking up ${name} on MusicBrainz…`, 'busy');
    try {
      const found = await mb.searchArtists(name);
      if (token !== discoToken) return;
      const exact = found.filter((a) => S.normArtist(a.name) === key);
      if (exact.length === 1) {
        store.linkArtist(name, exact[0].id);
        loadDiscography(exact[0]);
        return;
      }
      if (!found.length) {
        setStatus('#artist-status', `Couldn't find ${name} on MusicBrainz. Check the spelling in your collection.`, 'error');
        return;
      }
      setStatus('#artist-status', exact.length > 1 ? `There's more than one ${name}. Which one do you mean?` : `Which artist do you mean by ${name}?`);
      renderArtistChoices(exact.length > 1 ? exact : found, name);
    } catch (e) {
      if (token === discoToken) setStatus('#artist-status', e.message, 'error');
    }
  }

  function renderArtistChoices(artists, linkName) {
    $('#artist-results').replaceChildren(...artists.map((artist) => h('li', {},
      h('button', {
        type: 'button',
        class: 'choice',
        onclick: () => {
          if (linkName) store.linkArtist(linkName, artist.id);
          loadDiscography(artist);
        },
      },
      h('span', { class: 'record-title' }, artist.name),
      h('span', { class: 'record-meta' }, meta(artist.disambiguation, artist.type, artist.country))))));
  }

  async function onArtistSearch(event) {
    event.preventDefault();
    const query = event.target.elements.q.value.trim();
    if (!query) return;
    const token = ++discoToken;
    $('#artist-results').replaceChildren();
    setStatus('#artist-status', 'Searching MusicBrainz…', 'busy');
    try {
      const found = await mb.searchArtists(query);
      if (token !== discoToken) return;
      setStatus('#artist-status', found.length ? 'Pick the right artist:' : 'No artists found. Check the spelling.');
      renderArtistChoices(found, null);
    } catch (e) {
      if (token === discoToken) setStatus('#artist-status', e.message, 'error');
    }
  }

  async function loadDiscography(artist, refresh) {
    const token = ++discoToken;
    $('#artist-results').replaceChildren();
    let data = refresh ? null : store.getDiscography(artist.id);
    if (!data) {
      $('#disco-panel').hidden = true;
      setStatus('#artist-status', `Loading the discography for ${artist.name}…`, 'busy');
      try {
        const fetched = await mb.getDiscography(artist.id, (loaded, total) => {
          if (token === discoToken && total > 100) {
            setStatus('#artist-status', `Loading the discography for ${artist.name}… ${loaded} of ${total}`, 'busy');
          }
        });
        data = store.saveDiscography(artist.id, { name: artist.name, ...fetched });
      } catch (e) {
        if (token === discoToken) setStatus('#artist-status', e.message, 'error');
        return;
      }
    }
    if (token !== discoToken) return;
    setStatus('#artist-status', '');
    disco = { ...data, artist: { id: artist.id, name: artist.name } };
    renderDiscography();
    $('#disco-panel').hidden = false;
  }

  function enabledCategories() {
    return new Set(store.getPref('discoTypes', ['album']));
  }

  function toggleCategory(key, on) {
    const enabled = enabledCategories();
    if (on) enabled.add(key);
    else enabled.delete(key);
    store.setPref('discoTypes', [...enabled]);
    renderDiscography();
  }

  function renderDiscography() {
    if (!disco) return;
    const enabled = enabledCategories();
    const { items, unmatched } = S.compareDiscography(disco.groups, store.all(), disco.artist);

    const presentCategories = S.CATEGORIES.filter((category) => disco.groups.some((g) => S.categoryOf(g) === category.key));
    $('#disco-filters').replaceChildren(...presentCategories.map((category) => {
      const count = disco.groups.filter((g) => S.categoryOf(g) === category.key).length;
      return h('label', { class: 'toggle' },
        h('input', { type: 'checkbox', checked: enabled.has(category.key), onchange: (e) => toggleCategory(category.key, e.target.checked) }),
        category.label,
        h('span', { class: 'toggle-count' }, count));
    }));

    const visible = items
      .filter((item) => enabled.has(S.categoryOf(item.group)))
      .sort((a, b) => compare(a.group.date || '9999', b.group.date || '9999'));
    const owned = visible.filter((item) => item.records.length);
    const missing = visible.filter((item) => !item.records.length);
    currentMissing = missing;

    $('#disco-name').textContent = disco.artist.name;
    $('#disco-progress-text').textContent = visible.length
      ? `You have ${owned.length} of ${visible.length}`
      : disco.groups.length ? 'Nothing of these types. Turn on another type below.' : 'MusicBrainz lists no releases for this artist yet.';
    $('#disco-bar').style.width = visible.length ? `${(owned.length / visible.length) * 100}%` : '0';
    $('#disco-updated').textContent = meta(
      `Updated ${ago(disco.fetchedAt)}`,
      disco.truncated && `Showing the first ${disco.groups.length} of ${disco.total} releases`);

    const groupCover = (group) => cover({ releaseGroupId: group.id, artist: disco.artist.name, title: group.title }, 'sm');

    $('#missing-heading').textContent = `Missing (${missing.length})`;
    $('#disco-copy').hidden = !missing.length;
    $('#disco-missing').replaceChildren(...missing.map(({ group }) => h('li', { class: 'result' },
      groupCover(group),
      h('div', { class: 'result-text' },
        h('span', { class: 'record-title' }, group.title),
        h('span', { class: 'record-meta' }, meta(mb.yearOf(group.date), typeLabel(group)))),
      h('button', { type: 'button', onclick: () => addFromGroup(group) }, 'Got it'))));
    const missingEmpty = $('#disco-missing-empty');
    missingEmpty.hidden = missing.length > 0 || !visible.length;
    missingEmpty.textContent = 'You have every one of these.';

    $('#owned-heading').textContent = `On your shelf (${owned.length})`;
    $('#disco-owned-card').hidden = !owned.length;
    $('#disco-owned').replaceChildren(...owned.map(({ group, records }) => h('li', { class: 'result' },
      groupCover(group),
      h('div', { class: 'result-text' },
        h('span', { class: 'record-title' }, group.title),
        h('span', { class: 'record-meta' }, meta(mb.yearOf(group.date), typeLabel(group), `You have: ${records.map((r) => r.format).join(', ')}`))))));

    $('#disco-unmatched-card').hidden = !unmatched.length;
    $('#disco-unmatched').replaceChildren(...unmatched.map((r) => recordRow(r, false)));
  }

  function addFromGroup(group) {
    addWithUndo({
      artist: disco.artist.name,
      artistId: disco.artist.id,
      title: group.title,
      year: mb.yearOf(group.date),
      format: $('#add-format').value,
      releaseGroupId: group.id,
    });
  }

  async function copyMissing() {
    const lines = currentMissing.map(({ group }) => {
      const year = mb.yearOf(group.date);
      return `${disco.artist.name} - ${group.title}${year ? ` (${year})` : ''}`;
    });
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast(`Copied ${plural(lines.length, 'title')}`);
    } catch (e) {
      toast("Couldn't copy. Your browser blocked the clipboard.");
    }
  }

  // ---------- Backup ----------

  function exportBackup() {
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    const link = h('a', { href: URL.createObjectURL(blob), download: `record-catalog-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  async function importBackup(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      const { added, skipped } = store.importJSON(await file.text());
      toast(skipped ? `Imported ${plural(added, 'record')}. Skipped ${skipped} already here or incomplete.` : `Imported ${plural(added, 'record')}`);
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- Wire up ----------

  fillFormatSelect($('#filter-format'), 'All formats');
  fillFormatSelect($('#random-format'), 'Any format');
  fillFormatSelect($('#add-format'));
  fillFormatSelect($('#manual-form').elements.format);
  fillFormatSelect($('#edit-form').elements.format);

  $('#sort').value = store.getPref('sort', 'artist');
  $('#add-format').value = store.getPref('addFormat', 'LP');
  $('#storage-warning').hidden = store.persistent;

  $('#filter-text').addEventListener('input', renderCollection);
  $('#filter-format').addEventListener('change', renderCollection);
  $('#sort').addEventListener('change', (e) => {
    store.setPref('sort', e.target.value);
    renderCollection();
  });
  $('#export-btn').addEventListener('click', exportBackup);
  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', importBackup);

  $('#edit-dialog').addEventListener('close', onEditorClosed);
  $('#edit-cancel').addEventListener('click', () => $('#edit-dialog').close('cancel'));
  $('#edit-delete').addEventListener('click', deleteEditing);
  $('#edit-discography').addEventListener('click', () => {
    const record = store.get(editingId);
    $('#edit-dialog').close('discography');
    if (record) goToDiscography(record.artist);
  });

  $('#search-form').addEventListener('submit', onSearchSubmit);
  $('#barcode-form').addEventListener('submit', onBarcodeSubmit);
  $('#manual-form').addEventListener('submit', onManualSubmit);
  $('#add-format').addEventListener('change', (e) => store.setPref('addFormat', e.target.value));

  $('#spin-btn').addEventListener('click', spin);

  $('#disco-artist').addEventListener('change', (e) => {
    const artist = S.collectionArtists(store.all()).find((a) => a.key === e.target.value);
    if (artist) openCollectionArtist(artist.name);
  });
  $('#artist-search-form').addEventListener('submit', onArtistSearch);
  $('#disco-refresh').addEventListener('click', () => disco && loadDiscography(disco.artist, true));
  $('#disco-copy').addEventListener('click', copyMissing);

  store.onChange(() => {
    renderCollection();
    renderResults();
    renderDiscography();
    if (currentView() === 'random') renderRandomFilters();
    if (currentView() === 'discography') renderDiscoArtists();
  });

  window.addEventListener('hashchange', showView);
  renderCollection();
  showView();
})();
