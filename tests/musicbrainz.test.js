const test = require('node:test');
const assert = require('node:assert/strict');
const mb = require('../js/musicbrainz.js');

const { field, formatFromMedia, mediaLabel, creditName } = mb.internals;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('search fields escape Lucene syntax and neutralize operators', () => {
  assert.equal(field('artist', 'AC/DC'), '(artist:"AC/DC"^3 OR artist:(ac\\/dc))');
  assert.equal(field('releasegroup', 'Love AND Theft'), '(releasegroup:"Love AND Theft"^3 OR releasegroup:(love and theft))');
  assert.equal(field('releasegroup', 'Say "Hi"'), '(releasegroup:"Say \\"Hi\\""^3 OR releasegroup:(say \\"hi\\"))');
});

test('a half-typed last word also matches as a prefix', () => {
  assert.equal(field('artist', 'radioh', true), '(artist:"radioh"^3 OR artist:(radioh radioh*))');
  assert.equal(field('artist', 'ok co', true), '(artist:"ok co"^3 OR artist:(ok co))');
});

test('looksLikeBarcode tells barcodes from numeric titles', () => {
  assert.equal(mb.looksLikeBarcode('0 724352 775324'), true);
  assert.equal(mb.looksLikeBarcode('5099-9029-5562-0'), true);
  assert.equal(mb.looksLikeBarcode('1989'), false);
  assert.equal(mb.looksLikeBarcode('radiohead 2000'), false);
});

test('formatFromMedia maps MusicBrainz media to collection formats', () => {
  assert.equal(formatFromMedia(['12" Vinyl'], 'Album'), 'LP');
  assert.equal(formatFromMedia(['12" Vinyl', '12" Vinyl'], 'Album'), 'Double LP');
  assert.equal(formatFromMedia(['Vinyl', 'Vinyl', 'Vinyl'], 'Album'), 'Box set');
  assert.equal(formatFromMedia(['7" Vinyl'], 'Single'), '7" single');
  assert.equal(formatFromMedia(['12" Vinyl'], 'Single'), '12" single');
  assert.equal(formatFromMedia(['12" Vinyl'], 'EP'), 'EP');
  assert.equal(formatFromMedia(['CD', 'Enhanced CD'], 'Album'), null, 'CDs are not a collection format');
  assert.equal(formatFromMedia(['Cassette'], 'Album'), null, 'nor are cassettes');
  assert.equal(formatFromMedia(['CD', '12" Vinyl'], 'Album'), null);
  assert.equal(formatFromMedia(['VinylDisc'], 'Album'), null);
  assert.equal(formatFromMedia(['Flexi-disc'], 'Single'), null);
  assert.equal(formatFromMedia([], 'Album'), null);
});

test('mediaLabel and creditName read like the sleeve', () => {
  assert.equal(mediaLabel(['12" Vinyl', '12" Vinyl', 'CD']), '2 x 12" Vinyl + CD');
  assert.equal(creditName([{ name: 'Simon', joinphrase: ' & ' }, { name: 'Garfunkel' }]), 'Simon & Garfunkel');
});

test('search looks for the text in titles and artist names, and maps results', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(new URL(url));
    return jsonResponse({
      'release-groups': [{
        id: 'rg1',
        title: 'OK Computer',
        score: 100,
        'primary-type': 'Album',
        'first-release-date': '1997-05-21',
        'artist-credit': [{ name: 'Radiohead', artist: { id: 'a1', name: 'Radiohead' } }],
      }],
    });
  });
  const { results } = await mb.search('radiohead ok comp');
  assert.equal(calls[0].pathname, '/ws/2/release-group');
  assert.equal(calls[0].searchParams.get('fmt'), 'json');
  assert.equal(calls[0].searchParams.get('query'),
    '(releasegroup:"radiohead ok comp"^3 OR releasegroup:(radiohead ok comp comp*))'
    + ' OR (artist:"radiohead ok comp"^3 OR artist:(radiohead ok comp comp*))');
  assert.deepEqual(results[0], {
    releaseGroupId: 'rg1',
    releaseId: null,
    title: 'OK Computer',
    artist: 'Radiohead',
    artistId: 'a1',
    year: 1997,
    primaryType: 'Album',
    secondaryTypes: [],
    formatHint: null,
    media: '',
  });
});

test('equal scores put plain albums first, then EPs and singles, oldest first', async (t) => {
  const group = (id, score, type, date, secondary = []) => ({
    id, title: id, score, 'primary-type': type, 'secondary-types': secondary, 'first-release-date': date, 'artist-credit': [],
  });
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    'release-groups': [
      group('single', 100, 'Single', '1992'),
      group('live', 100, 'Album', '1994', ['Live']),
      group('later-album', 100, 'Album', '2000'),
      group('ep', 100, 'EP', '1993'),
      group('early-album', 100, 'Album', '1993'),
      group('weaker-match', 80, 'Album', '1990'),
    ],
  }));
  const { results } = await mb.search('radiohead');
  assert.deepEqual(results.map((r) => r.releaseGroupId), ['early-album', 'later-album', 'ep', 'single', 'live', 'weaker-match']);
});

test('a barcode in the search box looks up vinyl pressings only', async (t) => {
  const calls = [];
  const release = (id, note, ...formats) => ({ id, title: 'Pinkerton', disambiguation: note, 'release-group': { id: 'g1' }, media: formats.map((format) => ({ format })) });
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(new URL(url));
    return jsonResponse({
      releases: [
        release('r1', 'deluxe edition', '12" Vinyl'),
        release('r2', 'Japan', 'CD'),
        release('r3', '', 'Cassette'),
        release('r4', 'bundle', 'CD', '12" Vinyl'),
      ],
    });
  });
  const { results, hiddenNonVinyl } = await mb.search('0 724352 775324');
  assert.equal(calls[0].pathname, '/ws/2/release');
  assert.equal(calls[0].searchParams.get('query'), 'barcode:0724352775324');
  assert.deepEqual(results.map((r) => r.releaseId), ['r1', 'r4'], 'the CD and the cassette are left out');
  assert.equal(hiddenNonVinyl, 2);
  assert.deepEqual(results.map((r) => r.title), ['Pinkerton (deluxe edition)', 'Pinkerton'], 'only deluxe notes go in the title');
});

test('a cancelled search never reaches MusicBrainz', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse({ 'release-groups': [] }));
  const controller = new AbortController();
  const pending = mb.search('radiohead', controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('getDiscography marks vinyl albums and finds deluxe editions', async (t) => {
  const calls = [];
  const release = (id, group, { status = 'Official', title = `Title ${group.slice(1)}`, note = '', date = '' }, ...formats) => ({
    id, status, title, disambiguation: note, date, 'release-group': { id: group }, media: formats.map((format) => ({ format })),
  });
  const vinylReleases = [
    release('r1', 'g0', {}, '12" Vinyl', '12" Vinyl'),
    release('r2', 'g0', {}, '7" Vinyl'),
    release('r3', 'g1', { status: 'Bootleg' }, '12" Vinyl'), // bootlegs don't count
    release('r4', 'g2', {}, 'CD'), // a non-vinyl match is ignored
    release('r5', 'g3', {}, 'Flexi-disc'), // flexi-discs don't count
    release('r6', 'g4', {}, 'VinylDisc'), // a CD/vinyl hybrid isn't a vinyl pressing
    release('r7', 'g5', { status: 'Promotion' }, 'CD', 'Vinyl'),
    release('r8', 'g6', { title: 'Title 6 (Deluxe Edition)' }, '12" Vinyl'), // an album that is itself a deluxe edition
    release('r9', 'g7', { note: 'deluxe edition' }, '12" Vinyl'), // only the deluxe is on vinyl
  ];
  const deluxeReleases = [
    release('r9', 'g7', { note: 'deluxe edition', date: '2010-11-02' }, '12" Vinyl'),
    release('r10', 'g7', { note: '2010 Deluxe Edition', date: '2010-11-01' }, 'CD', 'CD'),
    release('r11', 'g8', { title: 'Title 8 (Expanded Edition)', date: '2004' }, 'CD'),
    release('r12', 'g6', { title: 'Title 6 (Deluxe Edition)' }, '12" Vinyl'),
    release('r13', 'g9', { status: 'Bootleg', note: 'deluxe' }, '12" Vinyl'),
  ];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    calls.push(u);
    const offset = Number(u.searchParams.get('offset'));
    if (u.pathname === '/ws/2/release-group') {
      const size = offset === 0 ? 100 : 20;
      return jsonResponse({
        'release-group-count': 120,
        'release-groups': Array.from({ length: size }, (_, i) => ({
          id: `g${offset + i}`, title: offset + i === 6 ? 'Title 6 (Deluxe Edition)' : `Title ${offset + i}`, 'primary-type': 'Album',
        })),
      });
    }
    const releases = u.searchParams.get('query').includes('format:') ? vinylReleases : deluxeReleases;
    return jsonResponse({ count: releases.length, releases });
  });
  const progress = [];
  const result = await mb.getDiscography('a1', (step) => progress.push(step));

  assert.deepEqual(calls.map((u) => `${u.pathname}@${u.searchParams.get('offset')}`),
    ['/ws/2/release-group@0', '/ws/2/release-group@100', '/ws/2/release@0', '/ws/2/release@0']);
  assert.equal(calls[2].searchParams.get('query'), 'arid:"a1" AND format:(vinyl OR 7vinyl OR 10vinyl OR 12vinyl)');
  assert.equal(calls[3].searchParams.get('query'), 'arid:"a1" AND (release:(deluxe OR expanded) OR comment:(deluxe OR expanded))');
  assert.deepEqual(progress, [
    { step: 'releases', loaded: 100, total: 120 },
    { step: 'releases', loaded: 120, total: 120 },
    { step: 'vinyl', loaded: 9, total: 9 },
    { step: 'deluxe', loaded: 5, total: 5 },
  ]);
  assert.equal(result.groups.length, 120);
  assert.deepEqual(result.groups.slice(0, 10).map((g) => g.vinyl),
    [true, false, false, false, false, true, true, false, false, false]);
  assert.deepEqual(result.groups[7].deluxe, { title: 'Title 7 (Deluxe Edition)', date: '2010-11-01', vinyl: true, releaseIds: ['r9', 'r10'] });
  assert.deepEqual(result.groups[8].deluxe, { title: 'Title 8 (Expanded Edition)', date: '2004', vinyl: false, releaseIds: ['r11'] });
  assert.equal(result.groups[6].deluxe, null, 'an album that is already a deluxe edition gets no second deluxe line');
  assert.equal(result.groups[9].deluxe, null, 'bootleg deluxe editions do not count');
  assert.equal(result.truncated, false);
  assert.equal(result.vinylComplete, true);
});

test('network and server errors become readable messages', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(mb.searchArtists('Low'), /Couldn't reach MusicBrainz/);
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({}, 400));
  await assert.rejects(mb.searchArtists('Low'), /error \(400\)/);
});
