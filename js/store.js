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
    wishlist: 'recordcatalog.wishlist.v1',
    confirmed: 'recordcatalog.confirmed.v1', // releases you've confirmed came out on vinyl
    discographies: 'recordcatalog.discographies.v5', // v5: LP and 45/10" pressings tracked separately
    prefs: 'recordcatalog.prefs.v1',
  };
  const OLD_KEYS = ['recordcatalog.discographies.v1', 'recordcatalog.discographies.v2', 'recordcatalog.discographies.v3', 'recordcatalog.discographies.v4'];

  // Vinyl only. Records saved earlier as CD or Cassette keep that format until you change it.
  const FORMATS = ['LP', 'Double LP', 'EP', '45', '10"', '12" single', 'Box set', 'Other'];
  // 45s (7") and 10" records are only offered when the person turns them on.
  const SMALL_FORMATS = ['45', '10"'];
  // Owning a record in one of these formats shows its release came out on vinyl ("Other" might not be vinyl).
  const VINYL_RECORD_FORMATS = FORMATS.filter((format) => format !== 'Other');

  // Formats renamed since earlier versions, fixed up when records are read.
  const RENAMED_FORMATS = { '7" single': '45' };
  const currentFormat = (format) => RENAMED_FORMATS[format] || format;

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
      format: currentFormat(String(input.format || '').trim()) || 'LP',
      notes: String(input.notes || '').trim(),
      artistId: input.artistId || null,
      releaseGroupId: input.releaseGroupId || null,
      releaseId: input.releaseId || null,
      // Imported records wait for a MusicBrainz lookup to fill in covers and years.
      pendingLookup: Boolean(input.pendingLookup),
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

  const SINGLE_FORMATS = ['45', '12" single'];
  const CATEGORY_RANK = { album: 0, ep: 1, single: 2, live: 3, compilation: 4, other: 5 };

  // When a title matches more than one release group (an album and its title single),
  // a single-format record goes to the single and anything else goes to the album.
  function matchRank(group, wantSingle) {
    const category = categoryOf(group);
    return wantSingle && category === 'single' ? -1 : CATEGORY_RANK[category];
  }

  // Deluxe and expanded editions add songs, so they get their own line next to the original.
  // musicbrainz.js uses the same words to find them.
  const DELUXE_WORDS = /\b(deluxe|expanded)\b/i;

  // What a vinyl confirmation is about: a release group, plus ":deluxe" for its deluxe edition.
  // Matches the keys of compareDiscography's lines.
  function vinylKey(releaseGroupId, deluxe) {
    return releaseGroupId ? `${releaseGroupId}${deluxe ? ':deluxe' : ''}` : null;
  }

  // You keep one copy of each album: the same release group, or the same artist and title when
  // either was typed in by hand, in the same edition (the original and its deluxe are different albums).
  function sameAlbum(a, b) {
    if (DELUXE_WORDS.test(a.title) !== DELUXE_WORDS.test(b.title)) return false;
    if (a.releaseGroupId && b.releaseGroupId) return a.releaseGroupId === b.releaseGroupId;
    return normArtist(a.artist) === normArtist(b.artist) && normTitle(a.title) === normTitle(b.title);
  }

  function isDeluxeRecord(record, group) {
    if (!group.deluxe) return false;
    if (record.releaseId && group.deluxe.releaseIds.includes(record.releaseId)) return true;
    return DELUXE_WORDS.test(record.title) && !DELUXE_WORDS.test(group.title);
  }

  /*
   * Lines up an artist's release groups with the records you own. Each release group is one
   * entry, plus a second one for its deluxe edition when it has one. A record matches by
   * MusicBrainz release group id first, then by normalized title for records by the same
   * artist (covers manual entries). Owning one edition doesn't count as owning the other.
   */
  function compareDiscography(groups, records, artist) {
    const byId = new Map(groups.map((group) => [group.id, group]));
    const standard = new Map(groups.map((group) => [group.id, []]));
    const deluxe = new Map(groups.filter((group) => group.deluxe).map((group) => [group.id, []]));
    const place = (record, group) => (isDeluxeRecord(record, group) ? deluxe : standard).get(group.id).push(record);
    const byTitle = new Map();
    for (const group of groups) {
      const key = normTitle(group.title);
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push(group);
    }

    const unmatched = [];
    for (const record of records) {
      if (record.releaseGroupId && byId.has(record.releaseGroupId)) {
        place(record, byId.get(record.releaseGroupId));
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
      place(record, best);
    }

    const items = [];
    for (const group of groups) {
      items.push({
        key: group.id, group, edition: 'standard', title: group.title, date: group.date, vinyl: Boolean(group.vinyl), small: Boolean(group.small), records: standard.get(group.id),
      });
      if (group.deluxe) {
        items.push({
          key: `${group.id}:deluxe`, group, edition: 'deluxe', title: group.deluxe.title, date: group.deluxe.date, vinyl: Boolean(group.deluxe.vinyl), small: Boolean(group.deluxe.small), records: deluxe.get(group.id),
        });
      }
    }
    return { items, unmatched };
  }

  // ---------- Importing a typed list ----------

  // "Artist - Title" (any dash with spaces around it) or "Artist<tab>Title", as pasted from a spreadsheet.
  const LIST_SEPARATOR = /\s+[-–—]\s+|\t/;
  // Numbering or bullets at the start of a line: "1. ", "2) ", "- ", "* ", "• ".
  const LIST_BULLET = /^\s*(?:\d+[.)]|[-*•])\s+/;
  const TRAILING_BRACKETS = /\s*[([]([^()[\]]*)[)\]]\s*$/;

  function formatFromNote(note) {
    if (/\b45\b|\bsingle\b|7"/i.test(note)) return '45';
    if (/10"/.test(note)) return '10"';
    if (/\bbox\b/i.test(note)) return 'Box set';
    return null;
  }

  // A note that only names the format, like "(45)" or "(Single/45)", isn't kept as a note too.
  const FORMAT_WORD = '(?:45s?|singles?|7"|7 ?inch|10"|10 ?inch|box set|box|lp)';
  const FORMAT_ONLY_NOTE = new RegExp(`^\\s*${FORMAT_WORD}(?:(?:\\s*[/,&+]\\s*|\\s+and\\s+|\\s+)${FORMAT_WORD})*\\s*$`, 'i');

  /*
   * Reads a pasted list of records, one per line. Brackets at the end of a title become notes, like
   * "(Signed)" or "(I have 2)", except deluxe or expanded editions, which stay in the title; "(Single)"
   * or "(45)" also makes it a 45. Lines naming the same album become one record, since you keep one
   * copy per album; their notes are combined, plus "2 copies" and so on.
   * Returns { items: [{ artist, title, notes, format, line }], unreadable: [line], merged }, where
   * merged counts the lines folded into an earlier one.
   */
  function parseRecordList(text) {
    const byAlbum = new Map();
    const unreadable = [];
    let merged = 0;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.replace(LIST_BULLET, '').trim();
      if (!line) continue;
      const at = line.search(LIST_SEPARATOR);
      if (at <= 0) {
        unreadable.push(raw.trim());
        continue;
      }
      const artist = line.slice(0, at).trim();
      let title = line.slice(at).replace(LIST_SEPARATOR, '').trim();
      const notes = [];
      let format = null;
      let match;
      while ((match = TRAILING_BRACKETS.exec(title)) && match.index > 0) {
        const note = match[1].trim();
        if (DELUXE_WORDS.test(note)) break;
        title = title.slice(0, match.index).trim();
        if (note && !FORMAT_ONLY_NOTE.test(note)) notes.unshift(note);
        format = format || formatFromNote(note);
      }
      if (!title) {
        unreadable.push(raw.trim());
        continue;
      }
      const key = `${normArtist(artist)}|${normTitle(title)}|${DELUXE_WORDS.test(title) ? 'deluxe' : ''}`;
      const item = byAlbum.get(key);
      if (item) {
        merged += 1;
        item.copies += 1;
        for (const note of notes) if (!item.notes.includes(note)) item.notes.push(note);
        item.format = item.format || format;
      } else {
        byAlbum.set(key, { artist, title, notes, format, copies: 1, line: raw.trim() });
      }
    }
    const items = [...byAlbum.values()].map(({ copies, notes, ...item }) => ({
      ...item,
      notes: [...notes, ...(copies > 1 ? [`${copies} copies`] : [])].join('; '),
    }));
    return { items, unreadable, merged };
  }

  // How alike two strings are, from 0 to 1: one minus the edit distance over the longer length.
  // Swapping two neighbouring letters ("Maladriot") counts as one edit, like a missing or wrong one.
  function similarity(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    let before = [];
    let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const current = [i];
      for (let j = 1; j <= b.length; j++) {
        current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) current[j] = Math.min(current[j], before[j - 2] + 1);
      }
      before = previous;
      previous = current;
    }
    return 1 - previous[b.length] / Math.max(a.length, b.length);
  }

  /*
   * How a typed artist name compares with one on MusicBrainz: fit from 0 to 1, and whether to use
   * MusicBrainz's spelling. Typos and initials ("Mike O." for Mike Oldfield) take it. A name inside a
   * longer credit ("Prince" in "Prince and the Revolution", "Jimi Hendrix" in "The Jimi Hendrix
   * Experience") still fits but keeps your spelling, so it stays grouped with your other records.
   */
  function artistFit(typed, found) {
    const a = normArtist(typed);
    const b = normArtist(found);
    const close = similarity(a, b);
    if (close >= 0.8) return { fit: close, rename: true };
    const typedWords = a.split(' ');
    const foundWords = b.split(' ');
    const initials = typedWords.length === foundWords.length
      && typedWords.every((word, i) => word === foundWords[i] || (word.length === 1 && foundWords[i].startsWith(word)));
    if (initials) return { fit: 0.9, rename: true };
    const [shorter, longer] = [typedWords, foundWords].sort((x, y) => x.length - y.length);
    const inside = shorter.every((word) => longer.includes(word)) && (shorter.length >= 2 || longer[0] === shorter[0]);
    return { fit: inside ? 0.9 : close, rename: false };
  }

  // Titles compared without "deluxe" or "expanded", which a typed list writes in many ways.
  const plainTitle = (title) => normTitle(title).replace(/\b(deluxe|expanded)( edition)?\b/g, ' ').replace(/\s+/g, ' ').trim();

  // Digits and roman numerals in a title. They have to agree: "Toto I" isn't "Toto IV", however close.
  const ROMAN = /^(i{1,3}|iv|vi{0,3}|ix|xi{0,3}|xiv|xv)$/;
  const numbersIn = (title) => [...(title.match(/\d+/g) || []).map((n) => String(Number(n))), ...title.split(' ').filter((w) => ROMAN.test(w))].sort().join(',');

  // How alike a typed title and a MusicBrainz title are, from 0 to 1, and whether it took leaving off
  // the MusicBrainz title's subtitle ("Get Yer Ya-Ya's Out! The Rolling Stones in Concert" for "Get
  // Yer Ya-Ya's Out!"), which costs a little. Numbers have to agree: "Toto" isn't "Toto IV".
  const SUBTITLE = /[:!?]\s+|\s+[-–—]\s+/;

  function titleFit(typed, found) {
    const fit = (a, b) => (numbersIn(a) === numbersIn(b) ? similarity(a, b) : 0);
    const a = plainTitle(typed);
    const whole = fit(a, plainTitle(found));
    const cut = found.search(SUBTITLE);
    const short = cut > 0 ? fit(a, plainTitle(found.slice(0, cut))) - 0.05 : 0;
    return short > whole ? { fit: short, subtitle: true } : { fit: whole, subtitle: false };
  }

  // Which kinds of release a typed record most likely is, best first: studio albums, then soundtracks
  // (often original albums, like Purple Rain), other albums (live, compilations), EPs, singles, and
  // anything else. A 45 can only be a single (first) or an EP, so anything else is ruled out (null).
  function kindRank(candidate, typedFormat) {
    const secondary = candidate.secondaryTypes || [];
    if (typedFormat === '45') return candidate.primaryType === 'Single' ? 0 : candidate.primaryType === 'EP' ? 1 : null;
    if (candidate.primaryType === 'Album') return !secondary.length ? 0 : secondary.every((type) => type === 'Soundtrack') ? 1 : 2;
    return { EP: 3, Single: 4 }[candidate.primaryType] ?? 5;
  }

  /*
   * Picks the MusicBrainz release a typed-in record most likely means, or null when nothing fits well
   * enough or it's too close to call. Small typos are fine: artist and title each need to be at least
   * 80% alike, and numbers have to agree. Of the releases scoring nearly as well as the best one, the
   * likeliest kind wins (see kindRank), so an album beats a single of the same name, but a loose typo
   * never beats an exact title. If two different releases are left that fit about as well (like
   * Weezer's several albums called "Weezer"), it's too close to call.
   * Candidates found by the artist's MusicBrainz id (artistFound) fit by artist already.
   * Returns the candidate plus renameArtist, whether to switch to MusicBrainz's spelling of the artist.
   */
  function bestAlbumMatch(typed, candidates) {
    const fits = candidates
      .map((candidate) => {
        const artist = candidate.artistFound ? { fit: 1, rename: false } : artistFit(typed.artist, candidate.artist);
        const title = titleFit(typed.title, candidate.title);
        return { candidate, artist, title, score: artist.fit + title.fit, kind: kindRank(candidate, typed.format) };
      })
      .filter((fit) => fit.kind !== null && fit.artist.fit >= 0.8 && fit.title.fit >= 0.8);
    // A title that only fits without its subtitle is a weaker clue. It can pick between releases when
    // another one fits outright (Get Yer Ya-Ya's Out! is the live album, not a later EP of that name),
    // and it can stand alone for the likeliest kinds, a studio album or soundtrack (Labyrinth) or a 45's
    // single, but not for anything else: Chicago II isn't "Chicago II: Live on Soundstage".
    const outright = fits.some((fit) => !fit.title.subtitle);
    const usable = fits.filter((fit) => !fit.title.subtitle || outright || fit.kind <= 1);
    if (!usable.length) return null;
    const top = Math.max(...usable.map((fit) => fit.score));
    const contenders = usable.filter((fit) => fit.score >= top - 0.15);
    const kind = Math.min(...contenders.map((fit) => fit.kind));
    const [first, second] = contenders.filter((fit) => fit.kind === kind).sort((a, b) => b.score - a.score);
    if (second && second.candidate.releaseGroupId !== first.candidate.releaseGroupId && first.score - second.score < 0.2) return null;
    return { ...first.candidate, renameArtist: first.artist.rename };
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

    function loadList(key) {
      let raw = null;
      try {
        raw = backend.getItem(key);
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
          backend.setItem(`${key}.unreadable`, raw);
        } catch (ignored) {}
        return [];
      }
    }

    const withCurrentFormat = (record) => (RENAMED_FORMATS[record.format] ? { ...record, format: currentFormat(record.format) } : record);
    let records = loadList(KEYS.records).map(withCurrentFormat);
    let wishes = loadList(KEYS.wishlist).map(withCurrentFormat);
    const confirmed = new Set(read(KEYS.confirmed, []).filter((key) => typeof key === 'string'));
    for (const key of OLD_KEYS) {
      try {
        backend.removeItem(key);
      } catch (ignored) {}
    }

    function commit() {
      write(KEYS.records, records);
      write(KEYS.wishlist, wishes);
      write(KEYS.confirmed, [...confirmed]);
      listeners.forEach((listener) => listener());
    }

    // Getting a record ticks it off the wishlist.
    function dropWishesYouOwn() {
      wishes = wishes.filter((wish) => !records.some((record) => sameAlbum(record, wish)));
    }

    function find(id) {
      return records.find((record) => record.id === id) || null;
    }

    return {
      persistent: Boolean(storage),

      all: () => records.slice(),
      get: find,

      // The record you already have for this album, if any.
      findCopy(input) {
        return records.find((record) => sameAlbum(record, input)) || null;
      },

      add(input) {
        const record = cleanRecord(input);
        const copy = records.find((r) => sameAlbum(r, record));
        if (copy) throw new Error(`"${copy.title}" is already in your collection.`);
        if (find(record.id)) record.id = newId();
        records.push(record);
        dropWishesYouOwn();
        commit();
        return record;
      },

      // ----- Wishlist: records you're looking for, kept apart from the collection -----

      wishlist: () => wishes.slice(),

      findWish(input) {
        return wishes.find((wish) => sameAlbum(wish, input)) || null;
      },

      addToWishlist(input) {
        const wish = cleanRecord(input);
        const copy = records.find((r) => sameAlbum(r, wish));
        if (copy) throw new Error(`"${copy.title}" is already in your collection.`);
        const wanted = wishes.find((w) => sameAlbum(w, wish));
        if (wanted) throw new Error(`"${wanted.title}" is already on your wishlist.`);
        if (wishes.some((w) => w.id === wish.id)) wish.id = newId();
        wishes.push(wish);
        commit();
        return wish;
      },

      // ----- Vinyl confirmations: releases MusicBrainz lists no vinyl pressing for, but you know have one -----

      // Whether you've confirmed it, or own it in a vinyl format.
      isVinylConfirmed(key) {
        if (!key) return false;
        if (confirmed.has(key)) return true;
        return records.some((record) => VINYL_RECORD_FORMATS.includes(record.format)
          && vinylKey(record.releaseGroupId, DELUXE_WORDS.test(record.title)) === key);
      },

      confirmedByYou: (key) => confirmed.has(key),

      confirmVinyl(key) {
        if (!key || confirmed.has(key)) return;
        confirmed.add(key);
        commit();
      },

      unconfirmVinyl(key) {
        if (confirmed.delete(key)) commit();
      },

      removeFromWishlist(id) {
        const wish = wishes.find((w) => w.id === id) || null;
        if (!wish) return null;
        wishes = wishes.filter((w) => w.id !== id);
        commit();
        return wish;
      },

      update(id, patch) {
        const index = records.findIndex((record) => record.id === id);
        if (index < 0) throw new Error('That record no longer exists.');
        const before = records[index];
        const next = cleanRecord({ ...before, ...patch, id, addedAt: before.addedAt });
        // A different artist name means the old MusicBrainz artist link no longer applies,
        // unless the change comes with a new one.
        if (!('artistId' in patch) && normArtist(next.artist) !== normArtist(before.artist)) next.artistId = null;
        records[index] = next;
        commit();
        return next;
      },

      // Adds several records at once, skipping albums you already have. Returns { added, skipped }.
      addMany(inputs) {
        const added = [];
        const skipped = [];
        for (const input of inputs) {
          let record;
          try {
            record = cleanRecord(input);
          } catch (e) {
            skipped.push(input);
            continue;
          }
          if (records.some((r) => sameAlbum(r, record))) {
            skipped.push(input);
            continue;
          }
          if (find(record.id)) record.id = newId();
          records.push(record);
          added.push(record);
        }
        if (added.length) {
          dropWishesYouOwn();
          commit();
        }
        return { added, skipped };
      },

      removeMany(ids) {
        const gone = new Set(ids);
        const before = records.length;
        records = records.filter((r) => !gone.has(r.id));
        if (records.length !== before) commit();
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
        return JSON.stringify({
          app: 'recordcatalog', version: 3, exportedAt: new Date().toISOString(), records, wishlist: wishes, vinylConfirmed: [...confirmed],
        }, null, 2);
      },

      // Merges a backup in. Albums you already have, or already want, are skipped.
      importJSON(text) {
        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          throw new Error("That file isn't a valid backup.");
        }
        const list = Array.isArray(data) ? data : data && data.records;
        if (!Array.isArray(list)) throw new Error("That file doesn't look like a Record Catalog backup.");

        const ids = new Set([...records, ...wishes].map((record) => record.id));
        const merge = (items, into, alsoSkip = []) => {
          let count = 0;
          let skipped = 0;
          for (const item of items) {
            let record;
            try {
              record = cleanRecord(item || {});
            } catch (e) {
              skipped++;
              continue;
            }
            if (ids.has(record.id) || into.some((r) => sameAlbum(r, record)) || alsoSkip.some((r) => sameAlbum(r, record))) {
              skipped++;
              continue;
            }
            ids.add(record.id);
            into.push(record);
            count++;
          }
          return { count, skipped };
        };

        const fromRecords = merge(list, records);
        const fromWishlist = merge(Array.isArray(data.wishlist) ? data.wishlist : [], wishes, records);
        dropWishesYouOwn();
        const confirmedBefore = confirmed.size;
        for (const key of Array.isArray(data.vinylConfirmed) ? data.vinylConfirmed : []) if (typeof key === 'string') confirmed.add(key);
        if (fromRecords.count || fromWishlist.count || confirmed.size > confirmedBefore) commit();
        return { added: fromRecords.count, skipped: fromRecords.skipped, wishes: fromWishlist.count };
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
    SMALL_FORMATS,
    CATEGORIES,
    fold,
    normTitle,
    normArtist,
    parseYear,
    cleanRecord,
    collectionArtists,
    sameArtist,
    sameAlbum,
    isDeluxe: (title) => DELUXE_WORDS.test(title),
    vinylKey,
    categoryOf,
    compareDiscography,
    pickRandom,
    parseRecordList,
    similarity,
    bestAlbumMatch,
    memoryStorage,
    createStore,
  };
});
