const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/store.js');

test('normTitle ignores case, accents, punctuation and edition notes', () => {
  assert.equal(S.normTitle('OK Computer (Remastered 2009)'), S.normTitle('ok computer'));
  assert.equal(S.normTitle('Rumours [Deluxe Edition]'), 'rumours');
  assert.equal(S.normTitle('Ágætis byrjun'), S.normTitle('Agaetis Byrjun'));
  assert.notEqual(S.normTitle('Help! (Live)'), S.normTitle('Help!'));
  assert.equal(S.normTitle('風の谷のナウシカ'), '風の谷のナウシカ');
});

test('normArtist drops a leading "The" and treats & as "and"', () => {
  assert.equal(S.normArtist('The Beatles'), S.normArtist('beatles'));
  assert.equal(S.normArtist('Simon & Garfunkel'), S.normArtist('Simon and Garfunkel'));
  assert.equal(S.normArtist('!!!'), '!!!');
});

test('records are cleaned, saved and read back', () => {
  const storage = S.memoryStorage();
  const first = S.createStore(storage);
  const record = first.add({ artist: ' Radiohead ', title: 'OK Computer', year: '1997-05-21' });
  assert.equal(record.artist, 'Radiohead');
  assert.equal(record.year, 1997);
  assert.equal(record.format, 'LP');

  const second = S.createStore(storage);
  assert.equal(second.all().length, 1);
  second.update(record.id, { format: 'CD', notes: 'Japan pressing' });
  assert.equal(second.get(record.id).format, 'CD');
  assert.equal(second.get(record.id).addedAt, record.addedAt);

  assert.throws(() => second.add({ artist: '', title: 'No artist' }), /required/);
  assert.throws(() => second.update(record.id, { title: ' ' }), /required/);
  assert.equal(second.get(record.id).title, 'OK Computer');

  second.remove(record.id);
  assert.equal(S.createStore(storage).all().length, 0);
});

test('changing the artist name drops the old MusicBrainz artist link', () => {
  const store = S.createStore(S.memoryStorage());
  const record = store.add({ artist: 'Radiohead', title: 'Kid A', artistId: 'a1' });
  assert.equal(store.update(record.id, { artist: 'radiohead' }).artistId, 'a1');
  assert.equal(store.update(record.id, { artist: 'Thom Yorke' }).artistId, null);
});

test('linkArtist fills in the artist id only on unlinked records with that name', () => {
  const store = S.createStore(S.memoryStorage());
  store.add({ artist: 'Nirvana', title: 'Nevermind' });
  store.add({ artist: 'nirvana', title: 'In Utero' });
  store.add({ artist: 'Nirvana', title: 'Local Anaesthetic', artistId: 'uk-nirvana' });
  store.add({ artist: 'Hole', title: 'Live Through This' });
  assert.equal(store.linkArtist('Nirvana', 'us-nirvana'), 2);
  const ids = store.all().map((r) => r.artistId);
  assert.deepEqual(ids, ['us-nirvana', 'us-nirvana', 'uk-nirvana', null]);
});

test('backups round trip and do not create duplicates', () => {
  const source = S.createStore(S.memoryStorage());
  source.add({ artist: 'Björk', title: 'Homogenic', format: 'Double LP' });
  source.add({ artist: 'Portishead', title: 'Dummy' });
  const backup = source.exportJSON();

  const target = S.createStore(S.memoryStorage());
  assert.deepEqual(target.importJSON(backup), { added: 2, skipped: 0 });
  assert.deepEqual(target.importJSON(backup), { added: 0, skipped: 2 });
  assert.equal(target.all()[0].format, 'Double LP');
  assert.deepEqual(target.importJSON(JSON.stringify([{ artist: 'Low', title: 'Things We Lost in the Fire' }, { title: 'No artist' }])), { added: 1, skipped: 1 });
  assert.throws(() => target.importJSON('not json'), /valid backup/);
  assert.throws(() => target.importJSON('{"hello": 1}'), /look like/);
});

test('unreadable saved data is set aside instead of overwritten', () => {
  const storage = S.memoryStorage();
  storage.setItem(S.KEYS.records, '{oops');
  const store = S.createStore(storage);
  assert.equal(store.all().length, 0);
  assert.equal(storage.getItem(`${S.KEYS.records}.unreadable`), '{oops');
});

test('a store without storage still works for the visit', () => {
  const store = S.createStore(null);
  assert.equal(store.persistent, false);
  store.add({ artist: 'Can', title: 'Tago Mago' });
  assert.equal(store.all().length, 1);
});

test('discography cache expires after a week', (t) => {
  const store = S.createStore(S.memoryStorage());
  store.saveDiscography('a1', { name: 'Radiohead', groups: [] });
  assert.equal(store.getDiscography('a1').name, 'Radiohead');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 8 * 24 * 60 * 60 * 1000);
  assert.equal(store.getDiscography('a1'), null);
});

test('discographies cached under older rules are cleared', () => {
  const storage = S.memoryStorage();
  for (const v of [1, 2, 3]) storage.setItem(`recordcatalog.discographies.v${v}`, '{"a1":{"groups":[]}}');
  S.createStore(storage);
  for (const v of [1, 2, 3]) assert.equal(storage.getItem(`recordcatalog.discographies.v${v}`), null);
});

test('categoryOf sorts release groups into filter buckets', () => {
  assert.equal(S.categoryOf({ primaryType: 'Album', secondaryTypes: [] }), 'album');
  assert.equal(S.categoryOf({ primaryType: 'EP' }), 'ep');
  assert.equal(S.categoryOf({ primaryType: 'Single', secondaryTypes: [] }), 'single');
  assert.equal(S.categoryOf({ primaryType: 'Album', secondaryTypes: ['Live'] }), 'live');
  assert.equal(S.categoryOf({ primaryType: 'Album', secondaryTypes: ['Compilation'] }), 'compilation');
  assert.equal(S.categoryOf({ primaryType: 'Album', secondaryTypes: ['Soundtrack'] }), 'other');
  assert.equal(S.categoryOf({ primaryType: 'Broadcast', secondaryTypes: [] }), 'other');
});

const radiohead = { id: 'a1', name: 'Radiohead' };
const album = (id, title, date, secondaryTypes = []) => ({ id, title, date, primaryType: 'Album', secondaryTypes });

test('compareDiscography matches by release group id, then by title', () => {
  const groups = [
    album('g1', 'Pablo Honey', '1993-02-22'),
    album('g2', 'The Bends', '1995-03-13'),
    album('g3', 'OK Computer', '1997-05-21'),
    album('g4', 'I Might Be Wrong', '2001-11-12', ['Live']),
  ];
  const records = [
    { id: 'r1', artist: 'Radiohead', title: 'OK Computer OKNOTOK', releaseGroupId: 'g3', format: 'LP' },
    { id: 'r2', artist: 'radiohead', title: 'The Bends (Remastered)', format: 'LP' },
    { id: 'r3', artist: 'Radiohead', title: 'Kid A Mnesia', format: 'LP' },
    { id: 'r4', artist: 'Portishead', title: 'Pablo Honey', format: 'LP' },
    { id: 'r5', artist: 'The Other Radiohead', title: 'Pablo Honey', artistId: 'a2', format: 'LP' },
  ];
  const { items, unmatched } = S.compareDiscography(groups, records, radiohead);
  const owned = Object.fromEntries(items.map((item) => [item.group.id, item.records.map((r) => r.id)]));
  assert.deepEqual(owned, { g1: [], g2: ['r2'], g3: ['r1'], g4: [] });
  assert.deepEqual(unmatched.map((r) => r.id), ['r3']);
});

test('a record whose artist id belongs to someone else is not matched by name', () => {
  const groups = [album('g1', 'Bleach', '1989')];
  const records = [{ id: 'r1', artist: 'Nirvana', title: 'Bleach', artistId: 'uk-nirvana' }];
  const { items } = S.compareDiscography(groups, records, { id: 'us-nirvana', name: 'Nirvana' });
  assert.deepEqual(items[0].records, []);
});

test('a 7" single goes to the single when an album shares its title', () => {
  const groups = [album('lp', 'Help!', '1965'), { id: 'sg', title: 'Help!', date: '1965', primaryType: 'Single', secondaryTypes: [] }];
  const records = [
    { id: 'r1', artist: 'The Beatles', title: 'Help!', format: '7" single' },
    { id: 'r2', artist: 'Beatles', title: 'Help!', format: 'LP' },
  ];
  const { items } = S.compareDiscography(groups, records, { id: 'b', name: 'The Beatles' });
  assert.deepEqual(items.map((item) => item.records.map((r) => r.id)), [['r2'], ['r1']]);
});

test('a deluxe edition is its own entry, right after the original', () => {
  const weezer = { id: 'w', name: 'Weezer' };
  const groups = [
    { ...album('blue', 'Weezer', '1994'), vinyl: true },
    { ...album('pink', 'Pinkerton', '1996'), vinyl: true, deluxe: { title: 'Pinkerton (Deluxe Edition)', date: '2010', vinyl: false, releaseIds: ['pink-dlx-cd'] } },
  ];
  const records = [
    { id: 'r1', artist: 'Weezer', title: 'Pinkerton', releaseGroupId: 'pink', format: 'LP' },
    { id: 'r2', artist: 'Weezer', title: 'Pinkerton (Deluxe Edition)', format: 'Double LP' }, // typed in by hand
    { id: 'r3', artist: 'Weezer', title: 'Pinkerton', releaseGroupId: 'pink', releaseId: 'pink-dlx-cd', format: 'CD' }, // added by barcode
    { id: 'r4', artist: 'Weezer', title: 'Weezer (Deluxe Edition)', format: 'LP' }, // no deluxe known for this one
  ];
  const { items } = S.compareDiscography(groups, records, weezer);
  assert.deepEqual(items.map((item) => [item.key, item.title, item.vinyl, item.records.map((r) => r.id)]), [
    ['blue', 'Weezer', true, ['r4']],
    ['pink', 'Pinkerton', true, ['r1']],
    ['pink:deluxe', 'Pinkerton (Deluxe Edition)', false, ['r2', 'r3']],
  ]);
});

test('pickRandom avoids recent picks until it runs out of others', () => {
  const pool = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  for (let i = 0; i < 30; i++) assert.equal(S.pickRandom(pool, ['a', 'b']).id, 'c');
  assert.ok(pool.includes(S.pickRandom(pool, ['a', 'b', 'c'])));
  assert.equal(S.pickRandom(pool, [], () => 0.99).id, 'c');
  assert.equal(S.pickRandom([], []), null);
});
