/*
 * Small client for the MusicBrainz API and the Cover Art Archive. Both are free and need no key.
 * MusicBrainz asks for no more than one request per second, so every call goes through one queue.
 * API docs: https://musicbrainz.org/doc/MusicBrainz_API
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.RC = root.RC || {}).mb = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API = 'https://musicbrainz.org/ws/2/';
  const COVERS = 'https://coverartarchive.org/release-group/';
  const MIN_GAP_MS = 1100;
  const MAX_DISCOGRAPHY_PAGES = 15;
  const MAX_RELEASE_PAGES = 30;

  // The vinyl formats that count. Flexi-disc and VinylDisc (a CD/vinyl hybrid) don't.
  // MusicBrainz's search index stores each format as a single squashed, lowercase word
  // ('12" Vinyl' becomes "12vinyl"), so searching for plain "vinyl" would miss most pressings.
  const VINYL_FORMATS = ['vinyl', '7vinyl', '10vinyl', '12vinyl'];
  const VINYL_FORMAT_NAME = /^(\d+" )?Vinyl$/i;
  const SKIPPED_STATUSES = ['Bootleg', 'Pseudo-Release'];

  // Deluxe and expanded editions add songs, so they get their own line next to the original.
  // store.js uses the same words to spot them in records you typed in.
  const DELUXE_WORDS = /\b(deluxe|expanded)\b/i;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let queue = Promise.resolve();
  let lastCall = 0;

  const abortError = () => new DOMException('Search cancelled', 'AbortError');

  // A call cancelled while it waits its turn never reaches MusicBrainz, so it doesn't use up the rate limit.
  function throttled(task, signal) {
    const run = queue.then(async () => {
      const wait = lastCall + MIN_GAP_MS - Date.now();
      if (wait > 0 && !(signal && signal.aborted)) await sleep(wait);
      if (signal && signal.aborted) throw abortError();
      lastCall = Date.now();
      return task();
    });
    queue = run.catch(() => {});
    return run;
  }

  async function get(path, params, signal) {
    const url = new URL(path, API);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('fmt', 'json');

    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        res = await throttled(() => fetch(url, { signal }), signal);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw new Error("Couldn't reach MusicBrainz. Check your connection and try again.");
      }
      if (res.ok) return res.json();
      // 503 means we hit the rate limit. Back off and try again.
      if (res.status !== 503) throw new Error(`MusicBrainz returned an error (${res.status}). Try again in a moment.`);
      await sleep(1500 * (attempt + 1));
    }
    throw new Error('MusicBrainz is busy right now. Try again in a minute.');
  }

  // ---------- Search query building (Lucene syntax) ----------

  function escapeWord(word) {
    return word.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1');
  }

  // Lowercasing keeps words like AND, OR and NOT in a title from acting as operators.
  // With prefixLast, a half-typed last word also matches as a prefix, so "radioh" finds "Radiohead".
  function terms(text, prefixLast) {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean).map(escapeWord);
    const last = words[words.length - 1];
    if (prefixLast && last && last.length >= 3) words.push(`${last}*`);
    return words.join(' ');
  }

  function phrase(text) {
    return `"${text.replace(/["\\]/g, '\\$&')}"`;
  }

  // An exact phrase match ranks first; loose word matches still show up below it.
  function field(name, text, prefixLast) {
    return `(${name}:${phrase(text.trim())}^3 OR ${name}:(${terms(text, prefixLast)}))`;
  }

  // 8 to 14 digits (spaces and dashes allowed) is a barcode. Shorter numbers are titles like "1989".
  function looksLikeBarcode(text) {
    return /^\d{8,14}$/.test(text.replace(/[\s-]/g, ''));
  }

  // Tiebreak for results MusicBrainz scores the same: plain albums, then EPs, singles, and the rest.
  function typeRank(group) {
    if ((group['secondary-types'] || []).length) return 3;
    const rank = { Album: 0, EP: 1, Single: 2 }[group['primary-type']];
    return rank === undefined ? 4 : rank;
  }

  // ---------- Response mapping ----------

  function creditName(credit) {
    return (credit || []).map((part) => part.name + (part.joinphrase || '')).join('').trim();
  }

  function mainArtistId(credit) {
    return (credit && credit[0] && credit[0].artist && credit[0].artist.id) || null;
  }

  function yearOf(date) {
    const match = /^(\d{4})/.exec(date || '');
    return match ? Number(match[1]) : null;
  }

  function formatFromMedia(media, primaryType) {
    if (!media.length) return null;
    const every = (pattern) => media.every((format) => pattern.test(format));
    if (every(/CD/)) return 'CD';
    if (every(/Cassette/)) return 'Cassette';
    if (!every(VINYL_FORMAT_NAME)) return null;
    if (media.length >= 3) return 'Box set';
    if (media.length === 2) return 'Double LP';
    if (every(/7"/)) return '7" single';
    if (primaryType === 'Single') return '12" single';
    if (primaryType === 'EP') return 'EP';
    return 'LP';
  }

  function mediaLabel(media) {
    const counts = new Map();
    for (const format of media) counts.set(format, (counts.get(format) || 0) + 1);
    return [...counts].map(([format, n]) => (n > 1 ? `${n} x ${format}` : format)).join(' + ');
  }

  // ---------- Public calls ----------

  // Free text matched against both album titles and artist names, so any part of either works.
  async function searchReleaseGroups(text, signal) {
    const query = ['releasegroup', 'artist'].map((name) => field(name, text, true)).join(' OR ');
    const data = await get('release-group', { query, limit: 40 }, signal);
    const groups = (data['release-groups'] || []).slice().sort((a, b) =>
      (b.score || 0) - (a.score || 0)
      || typeRank(a) - typeRank(b)
      || (a['first-release-date'] || '9999').localeCompare(b['first-release-date'] || '9999'));
    return groups.map((group) => ({
      releaseGroupId: group.id,
      releaseId: null,
      title: group.title,
      artist: creditName(group['artist-credit']),
      artistId: mainArtistId(group['artist-credit']),
      year: yearOf(group['first-release-date']),
      primaryType: group['primary-type'] || null,
      secondaryTypes: group['secondary-types'] || [],
      formatHint: null,
      media: '',
    }));
  }

  async function searchBarcode(barcode, signal) {
    const data = await get('release', { query: `barcode:${barcode}`, limit: 10 }, signal);
    return (data.releases || []).map((release) => {
      const group = release['release-group'] || {};
      const media = (release.media || []).map((medium) => medium.format).filter(Boolean);
      // Keep "deluxe edition" and the like in the title so the record shows which version it is.
      const note = release.disambiguation || '';
      const title = DELUXE_WORDS.test(note) && !DELUXE_WORDS.test(release.title) ? `${release.title} (${note})` : release.title;
      return {
        releaseGroupId: group.id || null,
        releaseId: release.id,
        title,
        artist: creditName(release['artist-credit']),
        artistId: mainArtistId(release['artist-credit']),
        year: yearOf(release.date),
        primaryType: group['primary-type'] || null,
        secondaryTypes: group['secondary-types'] || [],
        formatHint: formatFromMedia(media, group['primary-type']),
        media: mediaLabel(media),
      };
    });
  }

  // What the single search box on the Add page calls.
  function search(text, signal) {
    return looksLikeBarcode(text) ? searchBarcode(text.replace(/\D/g, ''), signal) : searchReleaseGroups(text, signal);
  }

  async function searchArtists(name) {
    const data = await get('artist', { query: field('artist', name.trim()), limit: 8 });
    return (data.artists || []).map((artist) => ({
      id: artist.id,
      name: artist.name,
      disambiguation: artist.disambiguation || '',
      type: artist.type || '',
      country: artist.country || '',
      score: artist.score,
    }));
  }

  // The artist's releases that match a search condition, minus bootlegs.
  // vinyl is null when MusicBrainz didn't say what format a release is.
  async function searchArtistReleases(artistId, condition, onProgress) {
    const query = `arid:"${artistId}" AND ${condition}`;
    const releases = [];
    let seen = 0;
    let total = 0;
    for (let page = 0; page < MAX_RELEASE_PAGES; page++) {
      const data = await get('release', { query, limit: 100, offset: seen });
      total = data.count || 0;
      const batch = data.releases || [];
      seen += batch.length;
      for (const release of batch) {
        const group = release['release-group'];
        if (!group || SKIPPED_STATUSES.includes(release.status)) continue;
        const formats = (release.media || []).map((medium) => medium.format).filter(Boolean);
        const words = `${release.title || ''} ${release.disambiguation || ''}`;
        releases.push({
          id: release.id,
          groupId: group.id,
          date: release.date || '',
          vinyl: formats.length ? formats.some((format) => VINYL_FORMAT_NAME.test(format)) : null,
          edition: /\bdeluxe\b/i.test(words) ? 'Deluxe' : /\bexpanded\b/i.test(words) ? 'Expanded' : null,
        });
      }
      if (onProgress) onProgress(seen, total);
      if (!batch.length || seen >= total) break;
    }
    return { releases, complete: seen >= total };
  }

  /*
   * Every album, EP and single credited to the artist, paged 100 at a time. Each one says whether
   * the original has a vinyl pressing, and carries a `deluxe` entry when MusicBrainz has a deluxe
   * or expanded edition filed under it. onProgress gets { step, loaded, total }.
   */
  async function getDiscography(artistId, onProgress) {
    const report = (step) => (loaded, total) => onProgress && onProgress({ step, loaded, total });
    const groups = [];
    let total = 0;
    for (let page = 0; page < MAX_DISCOGRAPHY_PAGES; page++) {
      const data = await get('release-group', { artist: artistId, type: 'album|ep|single', limit: 100, offset: groups.length });
      total = data['release-group-count'] || 0;
      const batch = data['release-groups'] || [];
      for (const group of batch) {
        groups.push({
          id: group.id,
          title: group.title,
          date: group['first-release-date'] || '',
          primaryType: group['primary-type'] || null,
          secondaryTypes: group['secondary-types'] || [],
        });
      }
      report('releases')(groups.length, total);
      if (!batch.length || groups.length >= total) break;
    }
    const vinyl = await searchArtistReleases(artistId, `format:(${VINYL_FORMATS.join(' OR ')})`, report('vinyl'));
    const deluxe = await searchArtistReleases(artistId, '(release:(deluxe OR expanded) OR comment:(deluxe OR expanded))', report('deluxe'));

    const byId = new Map(groups.map((group) => [group.id, group]));
    for (const group of groups) {
      group.vinyl = false;
      group.deluxe = null;
    }
    // A release is a deluxe version of an album when it says deluxe and the album's own title doesn't.
    const deluxeOf = (release) => {
      const group = byId.get(release.groupId);
      return group && release.edition && !DELUXE_WORDS.test(group.title) ? group : null;
    };
    for (const release of vinyl.releases) {
      const group = byId.get(release.groupId);
      // The search already asked for vinyl, so a release with no format listed still counts.
      if (group && release.vinyl !== false && !deluxeOf(release)) group.vinyl = true;
    }
    // Every deluxe or expanded release of an album folds into one entry, named "Deluxe" if any says so.
    for (const release of deluxe.releases) {
      const group = deluxeOf(release);
      if (!group) continue;
      const entry = group.deluxe || (group.deluxe = { title: `${group.title} (Expanded Edition)`, date: '', vinyl: false, releaseIds: [] });
      entry.releaseIds.push(release.id);
      if (release.edition === 'Deluxe') entry.title = `${group.title} (Deluxe Edition)`;
      if (release.vinyl) entry.vinyl = true;
      if (release.date && (!entry.date || release.date < entry.date)) entry.date = release.date;
    }

    return { groups, total, truncated: groups.length < total, vinylComplete: vinyl.complete && deluxe.complete };
  }

  function coverUrl(releaseGroupId, size) {
    return `${COVERS}${releaseGroupId}/front-${size}`;
  }

  return {
    search,
    searchReleaseGroups,
    searchBarcode,
    searchArtists,
    looksLikeBarcode,
    getDiscography,
    coverUrl,
    yearOf,
    internals: { field, formatFromMedia, mediaLabel, creditName },
  };
});
