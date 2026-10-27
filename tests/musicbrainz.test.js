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
  assert.equal(formatFromMedia(['CD', 'Enhanced CD'], 'Album'), 'CD');
  assert.equal(formatFromMedia(['Cassette'], 'Album'), 'Cassette');
  assert.equal(formatFromMedia(['CD', '12" Vinyl'], 'Album'), null);
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
  const results = await mb.search('radiohead ok comp');
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
  const results = await mb.search('radiohead');
  assert.deepEqual(results.map((r) => r.releaseGroupId), ['early-album', 'later-album', 'ep', 'single', 'live', 'weaker-match']);
});

test('a barcode in the search box looks up the release', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(new URL(url));
    return jsonResponse({ releases: [] });
  });
  await mb.search('0 724352 775324');
  assert.equal(calls[0].pathname, '/ws/2/release');
  assert.equal(calls[0].searchParams.get('query'), 'barcode:0724352775324');
});

test('a cancelled search never reaches MusicBrainz', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse({ 'release-groups': [] }));
  const controller = new AbortController();
  const pending = mb.search('radiohead', controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('getDiscography pages through release groups and counts vinyl releases', async (t) => {
  const calls = [];
  const release = (group, status, ...formats) => ({ status, 'release-group': { id: group }, media: formats.map((format) => ({ format })) });
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    calls.push(u);
    const offset = Number(u.searchParams.get('offset'));
    if (u.pathname === '/ws/2/release-group') {
      const size = offset === 0 ? 100 : 20;
      return jsonResponse({
        'release-group-count': 120,
        'release-groups': Array.from({ length: size }, (_, i) => ({ id: `g${offset + i}`, title: `Title ${offset + i}`, 'primary-type': 'Album' })),
      });
    }
    return jsonResponse({
      count: 5,
      releases: [
        release('g0', 'Official', '12" Vinyl', '12" Vinyl'),
        release('g0', 'Official', '7" Vinyl'),
        release('g1', 'Bootleg', '12" Vinyl'), // bootlegs don't count
        release('g2', 'Official', 'CD'), // a non-vinyl match is ignored
        release('g3', 'Promotion', 'Flexi-disc'),
      ],
    });
  });
  const progress = [];
  const result = await mb.getDiscography('a1', (step) => progress.push(step));

  assert.deepEqual(calls.map((u) => `${u.pathname}@${u.searchParams.get('offset')}`),
    ['/ws/2/release-group@0', '/ws/2/release-group@100', '/ws/2/release@0']);
  assert.equal(calls[2].searchParams.get('query'), 'arid:"a1" AND format:(vinyl OR 7vinyl OR 10vinyl OR 12vinyl OR flexidisc)');
  assert.deepEqual(progress, [
    { step: 'releases', loaded: 100, total: 120 },
    { step: 'releases', loaded: 120, total: 120 },
    { step: 'vinyl', loaded: 5, total: 5 },
  ]);
  assert.equal(result.groups.length, 120);
  assert.deepEqual(result.groups.slice(0, 5).map((g) => g.vinyl), [2, 0, 0, 1, 0]);
  assert.equal(result.truncated, false);
  assert.equal(result.vinylComplete, true);
});

test('network and server errors become readable messages', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(mb.searchArtists('Low'), /Couldn't reach MusicBrainz/);
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({}, 400));
  await assert.rejects(mb.searchArtists('Low'), /error \(400\)/);
});
