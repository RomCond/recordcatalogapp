/*
 * Record storage and matching helpers.
 * Loaded as a plain script in the browser (window.RC.store) and with require() in Node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.RC = root.RC || {}).store = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEYS = {
    records: 'recordcatalog.records.v1',
    discographies: 'recordcatalog.discographies.v1',
    prefs: 'recordcatalog.prefs.v1',
  };

  const FORMATS = ['LP', 'Double LP', 'EP', '7" single', '12" single', 'Box set', 'CD', 'Cassette', 'Other'];

  // Buckets for the discography filters, in display order.
  const CATEGORIES = [
    { key: 'album', label: 'Studio albums' },
    { key: 'ep', label: 'EPs' },
    { key: 'single', label: 'Singles' },
    { key: 'live', label: 'Live' },
    { key: 'compilation', label: 'Compilations' },
    { key: 'other', label: 'Other' },
  ];

  const DAY = 24 * 60 * 60 * 1000;
  const DISCOGRAPHY_MAX_AGE = 7 * DAY;

  // ---------- Text matching ----------

  // Parenthetical notes like "(2009 Remaster)" are dropped so a reissue matches the original title.
  const EDITION_WORDS = /remaster|deluxe|edition|anniversary|expanded|reissue|version|bonus|mono|stereo/;

  // Letters that Unicode normalization leaves alone but people type as plain ASCII.
  const LETTERS = { æ: 'ae', œ: 'oe', ø: 'o', ß: 'ss', ð: 'd', þ: 'th', ł: 'l', đ: 'd', ı: 'i' };

  function fold(text) {
    return String(text || '')
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[æœøßðþłđı]/g, (ch) => LETTERS[ch])
      .replace(/&/g, ' and ');
  }

  function squash(text) {
    return text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  function normTitle(title) {
    const folded = fold(title).replace(/\s*[([][^)\]]*[)\]]/g, (note) => (EDITION_WORDS.test(note) ? '' : note));
    return squash(folded) || fold(title).trim();
  }

  function normArtist(name) {
    return squash(fold(name)).replace(/^the /, '') || fold(name).trim();
  }

  function parseYear(value) {
    const match = /^\s*(\d{4})/.exec(value == null ? '' : String(value));
    return match ? Number(match[1]) : null;
  }

  function newId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function cleanRecord(input) {
    const artist = String(input.artist || '').trim();
    const title = String(input.title || '').trim();
    if (!artist || !title) throw new Error('Artist and title are both required.');
    return {
      id: input.id ? String(input.id) : newId(),
      artist,
      title,
      year: parseYear(input.year),
      format: String(input.format || '').trim() || 'LP',
      notes: String(input.notes || '').trim(),
      artistId: input.artistId || null,
      releaseGroupId: input.releaseGroupId || null,
      releaseId: input.releaseId || null,
      addedAt: input.addedAt || new Date().toISOString(),
    };
  }

  // ---------- Collection helpers ----------

  function collectionArtists(records) {
    const byKey = new Map();
    for (const record of records) {
      const key = normArtist(record.artist);
      if (!byKey.has(key)) byKey.set(key, { key, name: record.artist, records: [] });
      byKey.get(key).records.push(record);
    }
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  function sameArtist(record, artist) {
    if (record.artistId && artist.id) return record.artistId === artist.id;
    return normArtist(record.artist) === normArtist(artist.name);
  }

  function categoryOf(group) {
    const secondary = (group.secondaryTypes || []).map((type) => type.toLowerCase());
    if (secondary.includes('live')) return 'live';
    if (secondary.includes('compilation')) return 'compilation';
    if (secondary.length) return 'other';
    const primary = (group.primaryType || '').toLowerCase();
    return ['album', 'ep', 'single'].includes(primary) ? primary : 'other';
  }

  const SINGLE_FORMATS = ['7" single', '12" single'];
  const CATEGORY_RANK = { album: 0, ep: 1, single: 2, live: 3, compilation: 4, other: 5 };

  // When a title matches more than one release group (an album and its title single),
  // a single-format record goes to the single and anything else goes to the album.
  function matchRank(group, wantSingle) {
    const category = categoryOf(group);
    return wantSingle && category === 'single' ? -1 : CATEGORY_RANK[category];
  }

  /*
   * Lines up an artist's release groups with the records you own.
   * A record matches by MusicBrainz release group id first, then by normalized title
   * for records by the same artist (covers manual entries).
   */
  function compareDiscography(groups, records, artist) {
    const owned = new Map(groups.map((group) => [group.id, []]));
    const byTitle = new Map();
    for (const group of groups) {
      const key = normTitle(group.title);
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push(group);
    }

    const unmatched = [];
    for (const record of records) {
      if (record.releaseGroupId && owned.has(record.releaseGroupId)) {
        owned.get(record.releaseGroupId).push(record);
        continue;
      }
      if (!sameArtist(record, artist)) continue;
      const candidates = byTitle.get(normTitle(record.title));
      if (!candidates) {
        unmatched.push(record);
        continue;
      }
      const wantSingle = SINGLE_FORMATS.includes(record.format);
      const best = candidates.slice().sort((a, b) => matchRank(a, wantSingle) - matchRank(b, wantSingle))[0];
      owned.get(best.id).push(record);
    }

    return { items: groups.map((group) => ({ group, records: owned.get(group.id) })), unmatched };
  }

  function pickRandom(pool, recentIds, random) {
    if (!pool.length) return null;
    const fresh = pool.filter((record) => !recentIds.includes(record.id));
    const from = fresh.length ? fresh : pool;
    return from[Math.floor((random || Math.random)() * from.length)];
  }

  // ---------- Persistence ----------

  function memoryStorage() {
    const data = new Map();
    return {
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => void data.set(key, String(value)),
      removeItem: (key) => void data.delete(key),
    };
  }

  /*
   * Pass window.localStorage in the browser. Pass nothing (or null) when storage is
   * blocked and the store keeps everything in memory for this visit only.
   */
  function createStore(storage) {
    const backend = storage || memoryStorage();
    const listeners = new Set();

    function read(key, fallback) {
      try {
        const raw = backend.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        return fallback;
      }
    }

    function write(key, value) {
      backend.setItem(key, JSON.stringify(value));
    }

    function loadRecords() {
      let raw = null;
      try {
        raw = backend.getItem(KEYS.records);
      } catch (e) {
        return [];
      }
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        // Keep the unreadable copy aside so the next save can't destroy it.
        try {
          backend.setItem(`${KEYS.records}.unreadable`, raw);
        } catch (ignored) {}
        return [];
      }
    }

    let records = loadRecords();

    function commit() {
      write(KEYS.records, records);
      listeners.forEach((listener) => listener());
    }

    function find(id) {
      return records.find((record) => record.id === id) || null;
    }

    return {
      persistent: Boolean(storage),

      all: () => records.slice(),
      get: find,

      add(input) {
        const record = cleanRecord(input);
        if (find(record.id)) record.id = newId();
        records.push(record);
        commit();
        return record;
      },

      update(id, patch) {
        const index = records.findIndex((record) => record.id === id);
        if (index < 0) throw new Error('That record no longer exists.');
        const before = records[index];
        const next = cleanRecord({ ...before, ...patch, id, addedAt: before.addedAt });
        // A different artist name means the old MusicBrainz artist link no longer applies.
        if (normArtist(next.artist) !== normArtist(before.artist)) next.artistId = null;
        records[index] = next;
        commit();
        return next;
      },

      remove(id) {
        const record = find(id);
        if (!record) return null;
        records = records.filter((r) => r.id !== id);
        commit();
        return record;
      },

      // Remembers which MusicBrainz artist a hand-typed artist name refers to.
      linkArtist(name, artistId) {
        const key = normArtist(name);
        let changed = 0;
        records = records.map((record) => {
          if (record.artistId || normArtist(record.artist) !== key) return record;
          changed++;
          return { ...record, artistId };
        });
        if (changed) commit();
        return changed;
      },

      exportJSON() {
        return JSON.stringify({ app: 'recordcatalog', version: 1, exportedAt: new Date().toISOString(), records }, null, 2);
      },

      importJSON(text) {
        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          throw new Error("That file isn't a valid backup.");
        }
        const list = Array.isArray(data) ? data : data && data.records;
        if (!Array.isArray(list)) throw new Error("That file doesn't look like a Record Catalog backup.");
        const ids = new Set(records.map((record) => record.id));
        let added = 0;
        let skipped = 0;
        for (const item of list) {
          let record;
          try {
            record = cleanRecord(item || {});
          } catch (e) {
            skipped++;
            continue;
          }
          if (ids.has(record.id)) {
            skipped++;
            continue;
          }
          ids.add(record.id);
          records.push(record);
          added++;
        }
        if (added) commit();
        return { added, skipped };
      },

      getDiscography(artistId) {
        const entry = read(KEYS.discographies, {})[artistId];
        if (!entry || Date.now() - entry.fetchedAt > DISCOGRAPHY_MAX_AGE) return null;
        return entry;
      },

      saveDiscography(artistId, data) {
        const cache = read(KEYS.discographies, {});
        for (const [id, entry] of Object.entries(cache)) {
          if (Date.now() - entry.fetchedAt > 4 * DISCOGRAPHY_MAX_AGE) delete cache[id];
        }
        cache[artistId] = { ...data, fetchedAt: Date.now() };
        try {
          write(KEYS.discographies, cache);
        } catch (e) {
          // Storage is full. Keep just this artist so the collection itself always has room.
          try {
            write(KEYS.discographies, { [artistId]: cache[artistId] });
          } catch (ignored) {}
        }
        return cache[artistId];
      },

      getPref(key, fallback) {
        const prefs = read(KEYS.prefs, {});
        return key in prefs ? prefs[key] : fallback;
      },

      setPref(key, value) {
        const prefs = read(KEYS.prefs, {});
        prefs[key] = value;
        try {
          write(KEYS.prefs, prefs);
        } catch (ignored) {}
      },

      onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  return {
    KEYS,
    FORMATS,
    CATEGORIES,
    fold,
    normTitle,
    normArtist,
    parseYear,
    cleanRecord,
    collectionArtists,
    sameArtist,
    categoryOf,
    compareDiscography,
    pickRandom,
    memoryStorage,
    createStore,
  };
});
