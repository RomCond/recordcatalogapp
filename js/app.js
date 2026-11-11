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

  // The main color of a cover, for tinting the screen behind it. A small copy is drawn to a canvas
  // and sampled, which needs the image server to allow cross-origin reads. When it doesn't, or there's
  // no cover, this falls back to the record's placeholder color.
  const albumColors = new Map();

  function albumColor(item) {
    const fallback = labelColor(item);
    if (!item.releaseGroupId) return Promise.resolve(fallback);
    if (!albumColors.has(item.releaseGroupId)) {
      albumColors.set(item.releaseGroupId, new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            resolve(mainColor(img) || fallback);
          } catch (e) {
            resolve(fallback); // the browser refused to read the pixels
          }
        };
        img.onerror = () => resolve(fallback);
        img.src = mb.coverUrl(item.releaseGroupId, 250);
      }));
    }
    return albumColors.get(item.releaseGroupId);
  }

  // Groups the pixels into color buckets and returns the average of the heaviest one. Colorful pixels
  // weigh more than greys, and near-black or near-white ones barely count, so a black sleeve with a
  // red logo comes out red.
  function mainColor(img) {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lightness = (max + min) / 510;
      const vividness = (max - min) / 255; // pale tints like cream score low, unlike HSL saturation
      const weight = (0.1 + vividness) * (lightness < 0.08 || lightness > 0.94 ? 0.1 : 1);
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, weight: 0 };
      bucket.r += r * weight;
      bucket.g += g * weight;
      bucket.b += b * weight;
      bucket.weight += weight;
      buckets.set(key, bucket);
    }
    let best = null;
    for (const bucket of buckets.values()) if (!best || bucket.weight > best.weight) best = bucket;
    if (!best || !best.weight) return null;
    const channel = (sum) => Math.round(sum / best.weight);
    return `rgb(${channel(best.r)} ${channel(best.g)} ${channel(best.b)})`;
  }

  // Tints an element's background with the record's main color (see .has-album in the CSS).
  // Skips the update if a different record has been shown in the meantime.
  function tintWithAlbum(el, record, extra) {
    el.dataset.albumFor = record.id;
    albumColor(record).then((color) => {
      if (el.dataset.albumFor !== record.id) return;
      el.style.setProperty('--album', color);
      el.classList.add('has-album');
      if (extra) extra(color);
    });
  }

  // Cover Art Archive sizes in pixels, about 3x the size shown so covers stay sharp on phone screens.
  const COVER_SIZES = { sm: [500], md: [500], grid: [500], lg: [1200, 500] };
  // Covers that have loaded once show straight away when a list is drawn again, instead of fading in.
  const loadedCovers = new Set();

  // Cover art from the Cover Art Archive, over a placeholder for when there is none: a vinyl label
  // for thumbnails, a plain sleeve with the title for the big random pick and the collection's covers.
  function cover(item, size) {
    const box = h('div', { class: `cover cover-${size}`, 'aria-hidden': 'true' });
    const placeholder = size === 'lg' || size === 'grid'
      ? h('div', { class: 'cover-ph' }, h('span', { class: 'sleeve-title' }, item.title), h('span', { class: 'sleeve-artist' }, item.artist))
      : h('div', { class: 'cover-ph' });
    placeholder.style.setProperty('--label', labelColor(item));
    box.append(placeholder);
    if (item.releaseGroupId) {
      const sizes = COVER_SIZES[size];
      let attempt = 0;
      const img = h('img', { src: mb.coverUrl(item.releaseGroupId, sizes[0]), alt: '', loading: 'lazy', decoding: 'async' });
      if (loadedCovers.has(img.src)) box.classList.add('loaded');
      img.addEventListener('load', () => {
        loadedCovers.add(img.src);
        box.classList.add('loaded');
      });
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

  // 45s and 10" records are left out unless the person turns them on, on the Add page or in the discography.
  const smallRecords = () => store.getPref('smallRecords', false);
  const offeredFormats = () => S.FORMATS.filter((format) => smallRecords() || !S.SMALL_FORMATS.includes(format));

  // Fills a format menu and keeps its current choice. Filter menus (the ones with an "any" option)
  // also list formats already used in the collection, like an older CD, so those can still be found.
  function fillFormatSelect(select, anyLabel) {
    const previous = select.value;
    let formats = offeredFormats();
    if (anyLabel) formats = [...new Set([...formats, ...store.all().map((record) => record.format).filter(Boolean)])];
    const options = formats.map((format) => h('option', { value: format }, format));
    if (anyLabel) options.unshift(h('option', { value: '' }, anyLabel));
    select.replaceChildren(...options);
    if (formats.includes(previous)) select.value = previous;
  }

  function fillFormatSelects() {
    fillFormatSelect($('#filter-format'), 'All formats');
    fillFormatSelect($('#random-format'), 'Any format');
    fillFormatSelect($('#add-format'));
    fillFormatSelect($('#list-format'));
    fillFormatSelect($('#manual-form').elements.format);
    fillFormatSelect($('#edit-form').elements.format);
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

  // Under a release MusicBrainz lists no vinyl pressing for: "Vinyl not confirmed" with a Confirm
  // button, or "Vinyl confirmed by you" with Undo once you have. Nothing when you own it on vinyl.
  function vinylNote(key, title, label = 'Vinyl not confirmed') {
    if (!key) return null;
    if (store.confirmedByYou(key)) {
      return h('span', { class: 'vinyl-note' }, h('span', {}, 'Vinyl confirmed by you'),
        h('button', { type: 'button', class: 'link small', onclick: () => setVinylConfirmed(key, title, false) }, 'Undo'));
    }
    if (store.isVinylConfirmed(key)) return null;
    return h('span', { class: 'vinyl-note' }, h('span', {}, label),
      h('button', { type: 'button', class: 'link small', onclick: () => setVinylConfirmed(key, title, true) }, 'Confirm'));
  }

  function setVinylConfirmed(key, title, on) {
    const change = (yes) => (yes ? store.confirmVinyl(key) : store.unconfirmVinyl(key));
    change(on);
    toast(on ? `Confirmed ${title} on vinyl` : `Removed your vinyl confirmation for ${title}`, { label: 'Undo', run: () => change(!on) });
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

  // A record in the cover view: its cover, with the title and artist underneath.
  function recordTile(record) {
    return h('li', {},
      h('button', { type: 'button', class: 'tile', onclick: () => openEditor(record.id) },
        cover(record, 'grid'),
        h('span', { class: 'tile-title' }, record.title),
        h('span', { class: 'tile-artist' }, record.artist)));
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

  // The collection shows as covers (grid) or as a list. The wishlist is always a list, since its
  // records have buttons.
  const collectionView = () => store.getPref('collectionView', 'grid');

  function setCollectionView(view) {
    store.setPref('collectionView', view);
    renderCollection();
  }

  // Where a record goes under the current sort: the first letter of the artist ("The" doesn't count)
  // or of the title, the decade for year order, and no headings for recently added.
  const letterOf = (text) => {
    const first = S.fold(text).charAt(0).toUpperCase();
    return /^[A-Z]$/.test(first) ? first : '#';
  };

  function sectionOf(record, sort) {
    if (sort === 'artist') return letterOf(S.normArtist(record.artist));
    if (sort === 'title') return letterOf(S.normTitle(record.title));
    if (sort === 'year') return record.year ? `${Math.floor(record.year / 10) * 10}s` : 'Year unknown';
    return '';
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
    $('#filter-format-field').hidden = wishlistMode;
    $('#view-switch').hidden = wishlistMode;
    $('#list-import-tools').hidden = !wishlistMode && !records.length; // the empty shelf has its own button
    renderLookup();
    $('#collection-empty').hidden = wishlistMode || all.length > 0;
    $('#wishlist-empty').hidden = !wishlistMode || all.length > 0;
    $('#collection-tools').hidden = all.length === 0;
    $('#browse').hidden = all.length === 0;
    $('#collection-summary').hidden = all.length === 0;
    if (!all.length) {
      $('#collection-filters').hidden = true;
      return;
    }

    const query = S.fold($('#filter-text').value.trim());
    const format = wishlistMode ? '' : $('#filter-format').value;
    const sort = $('#sort').value;
    const view = wishlistMode ? 'list' : collectionView();
    for (const button of document.querySelectorAll('#view-switch button')) button.setAttribute('aria-pressed', String(button.dataset.view === view));
    const filterButton = $('#filter-btn');
    filterButton.replaceChildren('Filter', ...(format ? [h('span', { class: 'count' }, '1')] : []));
    filterButton.classList.toggle('active', Boolean(format));

    const list = all
      .filter((r) => !format || r.format === format)
      .filter((r) => !query || S.fold(`${r.artist} ${r.title} ${r.notes} ${r.year || ''}`).includes(query))
      .sort(SORTS[sort] || SORTS.artist);

    const artistCount = S.collectionArtists(all).length;
    $('#collection-summary').textContent = list.length === all.length
      ? `${plural(all.length, 'record')} by ${plural(artistCount, 'artist')}`
      : `Showing ${list.length} of ${plural(all.length, 'record')}`;

    const target = $('#collection-list');
    target.className = view === 'grid' ? 'grid-view' : 'list-view';
    if (!list.length) {
      target.replaceChildren(h('p', { class: 'muted center' }, 'No records match that search.'));
      renderRail([]);
      return;
    }

    const sections = new Map();
    for (const record of list) {
      const key = sectionOf(record, sort);
      if (!sections.has(key)) sections.set(key, []);
      sections.get(key).push(record);
    }
    const row = wishlistMode ? (r) => wishRow(r, true) : view === 'grid' ? recordTile : (r) => recordRow(r, true);
    const listClass = wishlistMode ? 'results card' : view === 'grid' ? 'tiles' : 'records compact card';
    target.replaceChildren(...[...sections].map(([key, group]) => h('section', { class: 'shelf-section', 'data-section': key },
      key ? h('h2', { class: 'section-title' }, key) : null,
      h('ul', { class: listClass }, group.map(row)))));
    // The letters down the side are for long lists in alphabetical order.
    renderRail(!wishlistMode && list.length > 20 && (sort === 'artist' || sort === 'title') ? [...sections.keys()] : []);
  }

  // ---------- A to Z ----------

  const RAIL_LETTERS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

  function renderRail(letters) {
    const rail = $('#az-rail');
    const show = letters.length > 1;
    rail.hidden = !show;
    $('#browse').classList.toggle('with-rail', show);
    if (!show) return;
    rail.replaceChildren(...RAIL_LETTERS.map((letter) => h('span', { class: letters.includes(letter) ? '' : 'off', 'data-letter': letter }, letter)));
  }

  // Scrolls to a letter's heading, or the nearest one after it when nothing starts with that letter.
  function jumpToLetter(letter) {
    const sections = [...document.querySelectorAll('#collection-list .shelf-section')];
    const at = RAIL_LETTERS.indexOf(letter);
    const target = sections.find((el) => RAIL_LETTERS.indexOf(el.dataset.section) >= at) || sections[sections.length - 1];
    if (!target) return;
    const top = target.getBoundingClientRect().top + window.scrollY - $('.app-header').offsetHeight - 8;
    window.scrollTo(0, top);
    for (const el of $('#az-rail').children) el.classList.toggle('on', el.dataset.letter === letter);
  }

  // Tap a letter, or slide a finger along the letters, like a phone's contacts.
  function onRailPointer(event) {
    if (event.type === 'pointermove' && !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (event.type === 'pointerdown') event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    const letter = [...event.currentTarget.children].find((el) => {
      const box = el.getBoundingClientRect();
      return event.clientY >= box.top && event.clientY < box.bottom;
    });
    if (letter && letter.dataset.letter !== event.currentTarget.dataset.current) {
      event.currentTarget.dataset.current = letter.dataset.letter;
      jumpToLetter(letter.dataset.letter);
    }
  }

  function endRailPointer(event) {
    delete event.currentTarget.dataset.current;
    for (const el of event.currentTarget.children) el.classList.remove('on');
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
    dialog.classList.remove('has-album');
    tintWithAlbum(dialog, record);
    dialog.returnValue = '';
    dialog.showModal();
  }

  function onEditorClosed() {
    if ($('#edit-dialog').returnValue !== 'save' || !editingId) return;
    const fields = $('#edit-form').elements;
    const before = store.get(editingId);
    try {
      const saved = store.update(editingId, {
        artist: fields.artist.value,
        title: fields.title.value,
        year: fields.year.value,
        format: fields.format.value,
        notes: fields.notes.value,
      });
      // An imported record that wasn't found gets looked up again once its artist or title is fixed.
      if (before && lookupSession.unmatched.includes(saved.id) && (saved.artist !== before.artist || saved.title !== before.title)) {
        lookupSession.unmatched = lookupSession.unmatched.filter((id) => id !== saved.id);
        saveLookupSession();
        store.update(saved.id, { pendingLookup: true });
        toast('Saved. Looking it up again.');
        return;
      }
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
      const { results: found, hiddenNonVinyl, hiddenSmall } = await mb.search(text, controller.signal, { small: smallRecords() });
      if (controller !== searchController) return;
      results = found;
      let note = '';
      if (!found.length && hiddenSmall) note = 'That barcode is for a 45 or a 10" record. Turn on "Include 45s and 10" records" to add it.';
      else if (!found.length && hiddenNonVinyl) note = 'That barcode is for a CD or cassette, not a vinyl record.';
      else if (!found.length) note = 'No vinyl records found. Try fewer words, check the spelling, or add it by hand below.';
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
        h('span', { class: 'record-meta' }, meta(result.artist, result.year, typeLabel(result), result.media, store.findWish(result) && 'On your wishlist')),
        result.vinyl === false ? vinylNote(S.vinylKey(result.releaseGroupId, result.deluxe), result.title) : null),
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
    // The card behind the record fades from the cover's main color, and the record's label matches it.
    tintWithAlbum($('#view-random .random-card'), record, (color) => stage.style.setProperty('--label', color));
    $('#spin-sleeve').replaceChildren(cover(record, 'lg'));
    stage.classList.remove('spinning');
    void stage.offsetWidth; // restart the animation
    stage.classList.add('spinning');
    $('#spin-meta').replaceChildren(
      h('h2', { class: 'pick-title' }, record.title),
      h('p', { class: 'pick-artist' }, record.artist),
      h('p', { class: 'pick-meta' }, meta(record.year, record.format)),
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

    // Records you own always count. With "Vinyl only" on, a missing one needs an LP or 12" pressing on
    // MusicBrainz, or a 45 or 10" one when those are turned on. Studio albums are the exception: they
    // show even without one, marked "Vinyl not confirmed", because MusicBrainz is often missing the
    // vinyl pressings of albums that have them. Deluxe editions still need one (many are digital only).
    // A release you've confirmed, or own on vinyl, counts as having one.
    const small = smallRecords();
    const listedOnVinyl = (item) => item.vinyl || (small && item.small);
    const onVinyl = (item) => listedOnVinyl(item) || store.isVinylConfirmed(item.key);
    const studioAlbum = (item) => item.edition === 'standard' && S.categoryOf(item.group) === 'album';
    const eligible = items.filter((item) => !vinylOnly || item.records.length || onVinyl(item) || studioAlbum(item));
    const countIn = (key) => eligible.filter((item) => S.categoryOf(item.group) === key).length;

    $('#disco-filters').replaceChildren(
      h('label', { class: 'toggle' },
        h('input', { type: 'checkbox', checked: vinylOnly, onchange: (e) => { store.setPref('vinylOnly', e.target.checked); renderDiscography(); } }),
        'Vinyl only'),
      h('label', { class: 'toggle' },
        h('input', { type: 'checkbox', checked: small, onchange: (e) => setSmallRecords(e.target.checked) }),
        '45s and 10"'),
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
          h('span', { class: 'record-meta' }, meta(mb.yearOf(item.date), typeLabel(item.group))),
          listedOnVinyl(item) ? null : vinylNote(item.key, item.title, item.small ? 'Only on 45 or 10"' : 'Vinyl not confirmed')),
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

  // ---------- Importing a list ----------

  // Records to add from the list in the import dialog, minus albums already in the collection.
  let listItems = [];

  function openListImport() {
    $('#list-form').reset();
    $('#list-format').value = $('#add-format').value;
    previewList();
    const dialog = $('#list-dialog');
    dialog.returnValue = '';
    dialog.showModal();
  }

  // Says what the import will do, as the list is typed, pasted or loaded from a file.
  function previewList() {
    const { items, unreadable, merged } = S.parseRecordList($('#list-form').elements.list.value);
    listItems = items.filter((item) => !store.findCopy(item));
    const owned = items.length - listItems.length;
    const notes = [];
    if (owned) notes.push(`${plural(owned, 'record')} already in your collection ${owned === 1 ? 'is' : 'are'} skipped.`);
    if (merged) notes.push(`${plural(merged, 'line')} named an album already on the list, so ${merged === 1 ? 'it was' : 'they were'} combined into one record with a note like "2 copies".`);
    const summary = [];
    if (listItems.length) summary.push(h('p', { class: 'list-count' }, `${plural(listItems.length, 'record')} to add.`));
    if (notes.length) summary.push(h('p', { class: 'muted small' }, notes.join(' ')));
    if (unreadable.length) {
      const shown = unreadable.slice(0, 5);
      summary.push(h('div', { class: 'list-problem' },
        h('p', {}, `${plural(unreadable.length, 'line')} couldn't be read, so ${unreadable.length === 1 ? "it's" : "they're"} left out. Each line needs an artist, a dash with a space on each side, then the title.`),
        h('ul', {}, shown.map((line) => h('li', {}, line))),
        unreadable.length > shown.length ? h('p', { class: 'small' }, `and ${unreadable.length - shown.length} more`) : null));
    }
    $('#list-summary').replaceChildren(...summary);
    $('#list-submit').disabled = !listItems.length;
    $('#list-submit').textContent = listItems.length ? `Add ${plural(listItems.length, 'record')}` : 'Add records';
  }

  async function loadListFile(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      $('#list-form').elements.list.value = await file.text();
    } catch (e) {
      toast("Couldn't read that file.");
      return;
    }
    previewList();
  }

  function onListDialogClosed() {
    if ($('#list-dialog').returnValue === 'import') importList();
  }

  // Adds the records straight away, then looks each one up on MusicBrainz in the background.
  function importList() {
    const format = $('#list-format').value;
    const inputs = listItems.map((item) => ({
      artist: item.artist, title: item.title, notes: item.notes, format: item.format || format, pendingLookup: true,
    }));
    const wishes = inputs.map((input) => store.findWish(input)).filter(Boolean);
    const { added } = store.addMany(inputs);
    if (!added.length) {
      toast('Those records are already in your collection.');
      return;
    }
    // The lookups may have started already, from the change to the collection, and listed some.
    for (const record of added) if (!lookupSession.ids.includes(record.id)) lookupSession.ids.push(record.id);
    saveLookupSession();
    if (currentRoute() !== 'collection') location.hash = '#collection';
    toast(`Added ${plural(added.length, 'record')}`, {
      label: 'Undo',
      run: () => {
        store.removeMany(added.map((record) => record.id));
        for (const wish of wishes) {
          try {
            store.addToWishlist(wish);
          } catch (ignored) {} // already back, or added again since
        }
      },
    });
    runLookups();
  }

  // ---------- Looking up imported records ----------

  // The records from the latest import, and which of them MusicBrainz had nothing certain for.
  // Saved, so the list of records to fix is still there after the app is closed.
  let lookupSession = store.getPref('lookup', null) || { ids: [], unmatched: [] };
  const lookup = { running: false, error: null };
  let lookupListOpen = false;

  function saveLookupSession() {
    store.setPref('lookup', lookupSession);
  }

  function dismissLookup() {
    lookupSession = { ids: [], unmatched: [] };
    saveLookupSession();
    renderLookup();
  }

  // Works through the records waiting for a lookup, one at a time, since MusicBrainz allows about one
  // request a second. Stops if MusicBrainz can't be reached; the rest wait for "Try again", or for the
  // next time the app opens.
  async function runLookups() {
    if (lookup.running) return;
    lookup.running = true;
    lookup.error = null;
    renderLookup();
    try {
      let record;
      while ((record = store.all().find((r) => r.pendingLookup))) {
        if (!lookupSession.ids.includes(record.id)) {
          lookupSession.ids.push(record.id);
          saveLookupSession();
        }
        const candidates = await mb.searchAlbumCandidates(record.artist, record.title);
        finishLookup(record, candidates);
      }
    } catch (e) {
      lookup.error = e.message;
    } finally {
      lookup.running = false;
      renderLookup();
    }
  }

  function finishLookup(record, candidates) {
    const current = store.get(record.id);
    // Deleted, or edited while it was being looked up: the new artist and title get their own lookup.
    if (!current || !current.pendingLookup || current.artist !== record.artist || current.title !== record.title) return;
    const match = S.bestAlbumMatch(current, candidates);
    const patch = match && matchPatch(current, match);
    // A match that's another record already on the shelf is left for you to sort out.
    if (patch && !store.all().some((r) => r.id !== current.id && S.sameAlbum(r, { ...current, ...patch }))) {
      store.update(current.id, patch);
      return;
    }
    if (!lookupSession.unmatched.includes(current.id)) lookupSession.unmatched.push(current.id);
    saveLookupSession();
    store.update(current.id, { pendingLookup: false });
  }

  // What a match changes on an imported record: the MusicBrainz link that brings its cover, the year,
  // and MusicBrainz's spelling of the title, and of the artist when the typed one is only a typo away.
  // A deluxe edition keeps its typed title, so it stays on its own line in the discography.
  function matchPatch(record, match) {
    return {
      pendingLookup: false,
      releaseGroupId: match.releaseGroupId,
      artistId: match.artistId || null,
      year: record.year || match.year || null,
      title: S.isDeluxe(record.title) && !S.isDeluxe(match.title) ? record.title : match.title,
      artist: match.renameArtist ? match.artist : record.artist,
    };
  }

  // The panel above the collection: progress while records are looked up, then the ones not found.
  function renderLookup() {
    const panel = $('#lookup');
    const records = new Map(store.all().map((record) => [record.id, record]));
    const ids = lookupSession.ids.filter((id) => records.has(id));
    if (!ids.length && lookupSession.ids.length) dismissLookup(); // all removed, by Undo or by hand
    if (!ids.length || currentRoute() !== 'collection') {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const pending = ids.filter((id) => records.get(id).pendingLookup);
    const done = ids.length - pending.length;

    if (pending.length) {
      const paused = !lookup.running && lookup.error;
      const bar = h('div', { class: 'progress-bar' });
      bar.style.width = `${Math.round((done / ids.length) * 100)}%`;
      panel.replaceChildren(
        h('p', { class: 'lookup-head' }, paused ? 'Lookups paused' : `Looking up covers and years: ${done} of ${ids.length}`),
        h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Records looked up', 'aria-valuemin': '0', 'aria-valuemax': String(ids.length), 'aria-valuenow': String(done) }, bar),
        paused
          ? h('div', { class: 'lookup-row' },
            h('p', { class: 'muted small' }, `${lookup.error} ${plural(pending.length, 'record')} still to look up.`),
            h('button', { type: 'button', onclick: runLookups }, 'Try again'))
          : h('p', { class: 'muted small' }, 'About a second per record. You can keep using the app meanwhile.'));
      return;
    }

    const unmatched = lookupSession.unmatched.map((id) => records.get(id)).filter((record) => record && !record.releaseGroupId);
    const matched = ids.length - unmatched.length;
    const dismiss = h('button', { type: 'button', class: 'link small', onclick: dismissLookup }, 'Dismiss');
    if (!unmatched.length) {
      panel.replaceChildren(h('div', { class: 'lookup-row' },
        h('p', { class: 'lookup-head' }, ids.length === 1 ? 'Found your imported record on MusicBrainz.' : `Found all ${ids.length} imported records on MusicBrainz.`),
        dismiss));
      return;
    }
    const they = unmatched.length === 1 ? 'it has' : 'they have';
    const list = h('details', { class: 'lookup-list', ontoggle: (e) => { lookupListOpen = e.target.open; } },
      h('summary', {}, `Show ${unmatched.length === 1 ? 'it' : `the ${unmatched.length}`}`),
      h('ul', { class: 'records' }, unmatched.sort(SORTS.artist).map((record) => recordRow(record, true))));
    list.open = lookupListOpen;
    panel.replaceChildren(
      h('div', { class: 'lookup-row' },
        h('p', { class: 'lookup-head' }, `Found ${matched} of ${ids.length} imported records on MusicBrainz.`),
        dismiss),
      h('p', { class: 'muted small' }, `${plural(unmatched.length, 'record')} ${unmatched.length === 1 ? "wasn't" : "weren't"} matched for certain, so ${they} no cover or year. Tap ${unmatched.length === 1 ? 'it' : 'one'} to fix its artist or title and it's looked up again.`),
      list);
  }

  // Turns 45s and 10" records on or off everywhere: format menus, search and the discography.
  function setSmallRecords(on) {
    store.setPref('smallRecords', on);
    $('#small-records').checked = on;
    fillFormatSelects();
    renderDiscography();
    const text = searchText();
    if (text && readyToSearch(text)) {
      lastQuery = ''; // search again so the results match
      runSearch(text);
    }
  }

  // ---------- Wire up ----------

  fillFormatSelects();
  const savedAddFormat = store.getPref('addFormat', 'LP');
  if (offeredFormats().includes(savedAddFormat)) $('#add-format').value = savedAddFormat;
  $('#small-records').checked = smallRecords();
  $('#small-records').addEventListener('change', (e) => setSmallRecords(e.target.checked));

  $('#sort').value = store.getPref('sort', 'artist');
  $('#storage-warning').hidden = store.persistent;

  $('#filter-text').addEventListener('input', renderCollection);
  for (const button of document.querySelectorAll('#view-switch button')) {
    button.addEventListener('click', () => setCollectionView(button.dataset.view));
  }
  $('#filter-btn').addEventListener('click', () => {
    const panel = $('#collection-filters');
    panel.hidden = !panel.hidden;
    $('#filter-btn').setAttribute('aria-expanded', String(!panel.hidden));
  });
  const rail = $('#az-rail');
  rail.addEventListener('pointerdown', onRailPointer);
  rail.addEventListener('pointermove', onRailPointer);
  rail.addEventListener('pointerup', endRailPointer);
  rail.addEventListener('pointercancel', endRailPointer);
  // The A to Z letters stay below the header, whose height depends on the screen width.
  const headerHeight = () => document.documentElement.style.setProperty('--header-h', `${$('.app-header').offsetHeight}px`);
  headerHeight();
  window.addEventListener('resize', headerHeight);
  $('#filter-format').addEventListener('change', renderCollection);
  $('#sort').addEventListener('change', (e) => {
    store.setPref('sort', e.target.value);
    renderCollection();
  });
  for (const button of document.querySelectorAll('.list-import-btn')) button.addEventListener('click', openListImport);
  $('#list-form').elements.list.addEventListener('input', previewList);
  $('#list-file-btn').addEventListener('click', () => $('#list-file').click());
  $('#list-file').addEventListener('change', loadListFile);
  $('#list-cancel').addEventListener('click', () => $('#list-dialog').close('cancel'));
  $('#list-dialog').addEventListener('close', onListDialogClosed);
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
    fillFormatSelects();
    renderCollection();
    renderResults();
    renderDiscography();
    if (currentView() === 'random') renderRandomFilters();
    if (currentView() === 'discography') renderDiscoArtists();
    // Records waiting for a lookup, from a backup or an edit, start one. Not after an error, though:
    // that waits for "Try again".
    if (!lookup.running && !lookup.error && store.all().some((record) => record.pendingLookup)) runLookups();
  });

  window.addEventListener('hashchange', showView);
  renderCollection();
  showView();
  if (store.all().some((record) => record.pendingLookup)) runLookups();
})();
