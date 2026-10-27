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

  // Cover Art Archive sizes in pixels, about 3x the size shown so covers stay sharp on phone screens.
  const COVER_SIZES = { sm: [500], md: [500], lg: [1200, 500] };

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
      const sizes = COVER_SIZES[size];
      let attempt = 0;
      const img = h('img', { src: mb.coverUrl(item.releaseGroupId, sizes[0]), alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('load', () => box.classList.add('loaded'));
      // Try the next size down if the big one isn't there, then leave the placeholder showing.
      img.addEventListener('error', () => {
        attempt += 1;
        if (attempt < sizes.length) img.src = mb.coverUrl(item.releaseGroupId, sizes[attempt]);
        else img.remove();
      });
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
      el.append(h('button', {
        type: 'button',
        class: 'toast-action',
        onclick: () => {
          hideToast();
          try {
            action.run();
          } catch (e) {
            toast(e.message); // e.g. undoing a delete after adding that album again
          }
        },
      }, action.label));
    }
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 6000 : 3000);
  }

  function hideToast() {
    $('#toast').classList.remove('show');
  }

  // Returns the new record, or null after telling the person why it couldn't be added.
  // Adding a record takes it off the wishlist; Undo puts it back there.
  function addWithUndo(input) {
    const wish = store.findWish(input);
    let record;
    try {
      record = store.add(input);
    } catch (e) {
      toast(e.message);
      return null;
    }
    toast(`Added ${record.title}`, {
      label: 'Undo',
      run: () => {
        store.remove(record.id);
        if (wish) store.addToWishlist(wish);
      },
    });
    return record;
  }

  function wishWithUndo(input) {
    let wish;
    try {
      wish = store.addToWishlist(input);
    } catch (e) {
      toast(e.message);
      return null;
    }
    toast(`Added ${wish.title} to your wishlist`, { label: 'Undo', run: () => store.removeFromWishlist(wish.id) });
    return wish;
  }

  function unwishWithUndo(wish) {
    store.removeFromWishlist(wish.id);
    toast(`Removed ${wish.title} from your wishlist`, { label: 'Undo', run: () => store.addToWishlist(wish) });
  }

  // ---------- Navigation ----------

  const VIEWS = ['collection', 'add', 'random', 'discography'];

  // #wishlist is the Collection tab showing the wishlist instead of your records.
  function currentRoute() {
    const route = location.hash.slice(1);
    return route === 'wishlist' || VIEWS.includes(route) ? route : 'collection';
  }

  function currentView() {
    return currentRoute() === 'wishlist' ? 'collection' : currentRoute();
  }

  function showView() {
    const view = currentView();
    for (const name of VIEWS) {
      $(`#view-${name}`).hidden = name !== view;
      const link = $(`.tabs a[href="#${name}"]`);
      if (name === view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (view === 'collection') renderCollection();
    if (view === 'random') renderRandomFilters();
    if (view === 'discography') renderDiscoArtists();
    window.scrollTo(0, 0);
  }

  // ---------- Collection and wishlist ----------

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

  function wishRow(wish, showArtist) {
    return h('li', { class: 'result' },
      cover(wish, 'sm'),
      h('div', { class: 'result-text' },
        h('span', { class: 'record-title' }, wish.title),
        h('span', { class: 'record-meta' }, meta(showArtist && wish.artist, wish.year)),
        h('button', { type: 'button', class: 'link small inline-link', onclick: () => unwishWithUndo(wish) }, 'Remove')),
      h('button', { type: 'button', onclick: () => gotWish(wish) }, 'Got it'));
  }

  // Moves a wishlist record into the collection, in the format chosen under "Add as".
  function gotWish(wish) {
    addWithUndo({ ...wish, id: null, addedAt: null, format: $('#add-format').value });
  }

  function renderCollection() {
    const wishlistMode = currentRoute() === 'wishlist';
    const records = store.all();
    const all = wishlistMode ? store.wishlist() : records;
    $('#nav-count').textContent = records.length;
    $('#count-collection').textContent = records.length;
    $('#count-wishlist').textContent = store.wishlist().length;
    $('#collection-heading').textContent = wishlistMode ? 'Your wishlist' : 'Your collection';
    for (const link of document.querySelectorAll('.segmented a')) {
      if (link.getAttribute('href') === (wishlistMode ? '#wishlist' : '#collection')) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    $('#filter-format').hidden = wishlistMode;
    $('#collection-empty').hidden = wishlistMode || all.length > 0;
    $('#wishlist-empty').hidden = !wishlistMode || all.length > 0;
    $('#collection-tools').hidden = all.length === 0;
    $('#collection-list').hidden = all.length === 0;
    $('#collection-summary').hidden = all.length === 0;
    if (!all.length) return;

    const query = S.fold($('#filter-text').value.trim());
    const format = wishlistMode ? '' : $('#filter-format').value;
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

    const row = wishlistMode ? wishRow : recordRow;
    const listClass = wishlistMode ? 'results' : 'records';
    if (sort !== 'artist') {
      target.replaceChildren(h('ul', { class: listClass }, list.map((r) => row(r, true))));
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
      h('ul', { class: listClass }, group.records.map((r) => row(r, false))))));
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

  // Search waits for a short pause in typing. MusicBrainz allows about one request a second,
  // so a search per keystroke would just queue up.
  const SEARCH_DELAY_MS = 450;
  let results = [];
  let searchTimer = null;
  let searchController = null;
  let lastQuery = '';

  function searchText() {
    return $('#search-form').elements.q.value.trim();
  }

  // Short numbers are titles like "1989". Longer ones wait until they are a whole barcode.
  function readyToSearch(text) {
    const digits = text.replace(/[\s-]/g, '');
    if (/^\d+$/.test(digits)) return digits.length <= 4 || mb.looksLikeBarcode(text);
    return text.length >= 2;
  }

  function onSearchInput() {
    clearTimeout(searchTimer);
    const text = searchText();
    if (!text) {
      if (searchController) searchController.abort();
      searchController = null;
      lastQuery = '';
      results = [];
      renderResults();
      setStatus('#search-status', '');
      return;
    }
    if (readyToSearch(text)) searchTimer = setTimeout(() => runSearch(text), SEARCH_DELAY_MS);
  }

  async function runSearch(text) {
    clearTimeout(searchTimer);
    if (text === lastQuery) return;
    lastQuery = text;
    if (searchController) searchController.abort();
    const controller = new AbortController();
    searchController = controller;
    // The previous results stay up until the new ones arrive, so the list doesn't flicker while typing.
    setStatus('#search-status', mb.looksLikeBarcode(text) ? 'Looking up that barcode…' : 'Searching…', 'busy');
    try {
      const { results: found, hiddenNonVinyl } = await mb.search(text, controller.signal);
      if (controller !== searchController) return;
      results = found;
      let note = '';
      if (!found.length && hiddenNonVinyl) note = 'That barcode is for a CD or cassette, not a vinyl record.';
      else if (!found.length) note = 'Nothing found. Try fewer words, check the spelling, or add it by hand below.';
      setStatus('#search-status', note);
      renderResults();
    } catch (e) {
      if (e.name === 'AbortError' || controller !== searchController) return;
      lastQuery = ''; // let the same search be tried again
      setStatus('#search-status', e.message, 'error');
    }
  }

  function renderResults() {
    $('#search-results').replaceChildren(...results.map((result) => h('li', { class: 'result' },
      cover(result, 'sm'),
      h('div', { class: 'result-text' },
        h('span', { class: 'record-title' }, result.title),
        h('span', { class: 'record-meta' }, meta(result.artist, result.year, typeLabel(result), result.media, store.findWish(result) && 'On your wishlist'))),
      store.findCopy(result)
        ? h('button', { type: 'button', disabled: true }, 'In collection')
        : h('button', { type: 'button', class: 'primary', onclick: () => addFromResult(result) }, 'Add'))));
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
    const text = searchText();
    if (!text) {
      setStatus('#search-status', 'Type part of an album or artist name, or a barcode.', 'error');
      return;
    }
    event.target.elements.q.blur(); // closes the phone keyboard so the results are visible
    runSearch(text);
  }

  function onManualSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const fields = form.elements;
    const added = addWithUndo({
      artist: fields.artist.value,
      title: fields.title.value,
      year: fields.year.value,
      format: fields.format.value,
      notes: fields.notes.value,
    });
    if (!added) return;
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
        const fetched = await mb.getDiscography(artist.id, ({ step, loaded, total }) => {
          if (token !== discoToken) return;
          const doing = {
            releases: `Loading the discography for ${artist.name}`,
            vinyl: 'Checking which releases came out on vinyl',
            deluxe: 'Looking for deluxe editions',
          }[step];
          setStatus('#artist-status', total > 100 ? `${doing}… ${loaded} of ${total}` : `${doing}…`, 'busy');
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
    const vinylOnly = store.getPref('vinylOnly', true);
    const { items, unmatched } = S.compareDiscography(disco.groups, store.all(), disco.artist);

    // Records you own always count. With "Vinyl only" on, a missing one needs a vinyl pressing on MusicBrainz.
    const eligible = items.filter((item) => !vinylOnly || item.records.length || item.vinyl);
    const countIn = (key) => eligible.filter((item) => S.categoryOf(item.group) === key).length;

    $('#disco-filters').replaceChildren(
      h('label', { class: 'toggle' },
        h('input', { type: 'checkbox', checked: vinylOnly, onchange: (e) => { store.setPref('vinylOnly', e.target.checked); renderDiscography(); } }),
        'Vinyl only'),
      h('span', { class: 'toggle-divider', 'aria-hidden': 'true' }),
      ...S.CATEGORIES.filter((category) => countIn(category.key)).map((category) => h('label', { class: 'toggle' },
        h('input', { type: 'checkbox', checked: enabled.has(category.key), onchange: (e) => toggleCategory(category.key, e.target.checked) }),
        category.label,
        h('span', { class: 'toggle-count' }, countIn(category.key)))));

    // Oldest first, with a deluxe edition right after its original.
    const visible = eligible
      .filter((item) => enabled.has(S.categoryOf(item.group)))
      .sort((a, b) => compare(a.group.date || '9999', b.group.date || '9999')
        || compare(a.group.id, b.group.id)
        || (a.edition === 'deluxe') - (b.edition === 'deluxe'));
    const owned = visible.filter((item) => item.records.length);
    const missing = visible.filter((item) => !item.records.length);
    currentMissing = missing;

    let progress = `You have ${owned.length} of ${visible.length}`;
    if (!visible.length) {
      if (!disco.groups.length) progress = 'MusicBrainz lists no releases for this artist yet.';
      else if (vinylOnly && !eligible.length) progress = 'MusicBrainz lists no vinyl releases for this artist. Turn off Vinyl only to see everything.';
      else progress = 'Nothing of these types. Turn on another type below.';
    }
    $('#disco-name').textContent = disco.artist.name;
    $('#disco-progress-text').textContent = progress;
    $('#disco-bar').style.width = visible.length ? `${(owned.length / visible.length) * 100}%` : '0';
    $('#disco-updated').textContent = meta(
      `Updated ${ago(disco.fetchedAt)}`,
      disco.truncated && `Showing the first ${disco.groups.length} of ${disco.total} releases`,
      disco.vinylComplete === false && 'This artist has a huge number of vinyl releases, so a few may be missed');

    const itemCover = (item) => cover({ releaseGroupId: item.group.id, artist: disco.artist.name, title: item.title }, 'sm');

    $('#missing-heading').textContent = `Missing (${missing.length})`;
    $('#disco-copy').hidden = !missing.length;
    $('#disco-missing').replaceChildren(...missing.map((item) => {
      const input = itemInput(item);
      const wish = store.findWish(input);
      return h('li', { class: 'result' },
        itemCover(item),
        h('div', { class: 'result-text' },
          h('span', { class: 'record-title' }, item.title),
          h('span', { class: 'record-meta' }, meta(mb.yearOf(item.date), typeLabel(item.group), !item.vinyl && 'No vinyl listed'))),
        h('div', { class: 'actions' },
          wish
            ? h('button', { type: 'button', class: 'small wished', onclick: () => unwishWithUndo(wish) }, 'On wishlist')
            : h('button', { type: 'button', class: 'small', onclick: () => wishWithUndo(input) }, 'Wishlist'),
          h('button', { type: 'button', class: 'small', onclick: () => addWithUndo({ ...input, format: $('#add-format').value }) }, 'Got it')));
    }));
    const missingEmpty = $('#disco-missing-empty');
    missingEmpty.hidden = missing.length > 0 || !visible.length;
    missingEmpty.textContent = 'You have every one of these.';

    $('#owned-heading').textContent = `On your shelf (${owned.length})`;
    $('#disco-owned-card').hidden = !owned.length;
    $('#disco-owned').replaceChildren(...owned.map((item) => h('li', { class: 'result' },
      itemCover(item),
      h('div', { class: 'result-text' },
        h('span', { class: 'record-title' }, item.title),
        h('span', { class: 'record-meta' }, meta(mb.yearOf(item.date), typeLabel(item.group), `You have: ${item.records.map((r) => r.format).join(', ')}`))))));

    $('#disco-unmatched-card').hidden = !unmatched.length;
    $('#disco-unmatched').replaceChildren(...unmatched.map((r) => recordRow(r, false)));
  }

  // A discography line as a record. The deluxe title ("... (Deluxe Edition)") is what files it
  // under the deluxe line.
  function itemInput(item) {
    return {
      artist: disco.artist.name,
      artistId: disco.artist.id,
      title: item.title,
      year: mb.yearOf(item.date),
      releaseGroupId: item.group.id,
    };
  }

  async function copyMissing() {
    const lines = currentMissing.map((item) => {
      const year = mb.yearOf(item.date);
      return `${disco.artist.name} - ${item.title}${year ? ` (${year})` : ''}`;
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
      const { added, skipped, wishes } = store.importJSON(await file.text());
      let message = `Imported ${plural(added, 'record')}`;
      if (wishes) message += ` and ${wishes} for your wishlist`;
      if (skipped) message += `. Skipped ${skipped} already here or incomplete.`;
      toast(message);
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- Theme ----------

  // The page head applies the saved theme (RC.applyLook) before anything draws; this is the picker.
  const LOOK_OPTIONS = {
    palette: [
      { key: 'orange', label: 'Burnt orange' },
      { key: 'cobalt', label: 'Cobalt' },
      { key: 'olive', label: 'Olive' },
      { key: 'magenta', label: 'Magenta' },
    ],
    font: [
      { key: 'classic', label: 'Classic' },
      { key: 'retro', label: 'Retro' },
      { key: 'modern', label: 'Modern' },
      { key: 'poster', label: 'Poster' },
    ],
    mode: [
      { key: 'auto', label: 'Match device' },
      { key: 'light', label: 'Light' },
      { key: 'dark', label: 'Dark' },
    ],
  };

  function currentLook() {
    return { palette: 'orange', font: 'classic', mode: 'auto', ...store.getPref('look', {}) };
  }

  function setLook(change) {
    const look = { ...currentLook(), ...change };
    store.setPref('look', look);
    RC.applyLook(look);
    renderLookChoices();
  }

  // Each choice previews itself: swatches carry their own palette, font names their own font.
  function renderLookChoices() {
    const look = currentLook();
    const scheme = document.documentElement.getAttribute('data-scheme');
    for (const [kind, options] of Object.entries(LOOK_OPTIONS)) {
      $(`#look-${kind}`).replaceChildren(...options.map((option) => h('label', { class: 'look-choice' },
        h('input', {
          type: 'radio', name: `look-${kind}`, value: option.key, checked: look[kind] === option.key, onchange: () => setLook({ [kind]: option.key }),
        }),
        kind === 'palette' ? h('span', { class: 'swatch', 'data-palette': option.key, 'data-scheme': scheme, 'aria-hidden': 'true' }) : null,
        kind === 'font' ? h('span', { class: 'font-sample', 'data-font': option.key }, option.label) : option.label)));
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
  $('#search-form').elements.q.addEventListener('input', onSearchInput);
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

  $('#theme-btn').addEventListener('click', () => {
    renderLookChoices();
    $('#look-dialog').showModal();
  });
  // "Match device" follows the phone switching between light and dark.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      RC.applyLook(currentLook());
      renderLookChoices();
    });
  }

  window.addEventListener('hashchange', showView);
  renderCollection();
  showView();
})();
