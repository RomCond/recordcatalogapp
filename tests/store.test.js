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

test('you can only add one copy of an album', () => {
  const store = S.createStore(S.memoryStorage());
  store.add({ artist: 'Weezer', title: 'Pinkerton', releaseGroupId: 'pink', format: 'LP' });
  store.add({ artist: 'Radiohead', title: 'The Bends', format: 'LP' });

  assert.throws(() => store.add({ artist: 'Weezer', title: 'Pinkerton', releaseGroupId: 'pink', format: 'CD' }), /"Pinkerton" is already in your collection/);
  assert.throws(() => store.add({ artist: 'weezer', title: 'pinkerton' }), /already/, 'typed in by hand');
  assert.throws(() => store.add({ artist: 'Radiohead', title: 'The Bends (Remastered)' }), /already/, 'a remaster is the same album');
  assert.ok(store.findCopy({ artist: 'Radiohead', title: 'The Bends', releaseGroupId: 'bends' }));

  // Different albums are fine: a deluxe edition, and a different album with the same title
  store.add({ artist: 'Weezer', title: 'Pinkerton (Deluxe Edition)', releaseGroupId: 'pink' });
  store.add({ artist: 'Weezer', title: 'Weezer', releaseGroupId: 'blue' });
  store.add({ artist: 'Weezer', title: 'Weezer', releaseGroupId: 'green' });
  assert.equal(store.all().length, 5);
  assert.equal(store.findCopy({ artist: 'Weezer', title: 'Weezer', releaseGroupId: 'red' }), null);
});

test('only vinyl formats are offered', () => {
  assert.deepEqual(S.FORMATS, ['LP', 'Double LP', 'EP', '45', '10"', '12" single', 'Box set', 'Other']);
  assert.deepEqual(S.SMALL_FORMATS, ['45', '10"']);
});

test('records saved as 7" singles are called 45s now', () => {
  const storage = S.memoryStorage();
  storage.setItem(S.KEYS.records, JSON.stringify([{ id: 'r1', artist: 'The Beatles', title: 'Help!', format: '7" single' }]));
  storage.setItem(S.KEYS.wishlist, JSON.stringify([{ id: 'w1', artist: 'The Beatles', title: 'Ticket to Ride', format: '7" single' }]));
  const store = S.createStore(storage);
  assert.equal(store.get('r1').format, '45');
  assert.equal(store.wishlist()[0].format, '45');
  assert.equal(store.add({ artist: 'The Beatles', title: 'Day Tripper', format: '7" single' }).format, '45');
});

test('the wishlist holds records you want, apart from the collection', () => {
  const storage = S.memoryStorage();
  const store = S.createStore(storage);
  store.add({ artist: 'Weezer', title: 'Weezer', releaseGroupId: 'blue' });
  const wish = store.addToWishlist({ artist: 'Weezer', title: 'Pinkerton', releaseGroupId: 'pink' });
  store.addToWishlist({ artist: 'Weezer', title: 'Pinkerton (Deluxe Edition)', releaseGroupId: 'pink' });

  assert.equal(store.all().length, 1, 'wishes are not in the collection');
  assert.deepEqual(store.wishlist().map((w) => w.title), ['Pinkerton', 'Pinkerton (Deluxe Edition)']);
  assert.equal(store.findWish({ artist: 'weezer', title: 'pinkerton' }).id, wish.id);
  assert.throws(() => store.addToWishlist({ artist: 'Weezer', title: 'Pinkerton', releaseGroupId: 'pink' }), /already on your wishlist/);
  assert.throws(() => store.addToWishlist({ artist: 'Weezer', title: 'Weezer', releaseGroupId: 'blue' }), /already in your collection/);
  assert.equal(S.createStore(storage).wishlist().length, 2, 'the wishlist is saved');

  // Getting a record takes it off the wishlist, edition by edition
  store.add({ artist: 'Weezer', title: 'Pinkerton', releaseGroupId: 'pink' });
  assert.deepEqual(store.wishlist().map((w) => w.title), ['Pinkerton (Deluxe Edition)']);

  const [deluxe] = store.wishlist();
  assert.equal(store.removeFromWishlist(deluxe.id).title, 'Pinkerton (Deluxe Edition)');
  assert.deepEqual(store.wishlist(), []);
  assert.equal(store.removeFromWishlist('gone'), null);
});

test('you can confirm a release came out on vinyl, and owning it on vinyl confirms it too', () => {
  const storage = S.memoryStorage();
  const store = S.createStore(storage);
  assert.equal(S.vinylKey('gone-now', false), 'gone-now');
  assert.equal(S.vinylKey('gone-now', true), 'gone-now:deluxe');
  assert.equal(S.vinylKey(null, false), null);

  assert.equal(store.isVinylConfirmed('gone-now'), false);
  store.confirmVinyl('gone-now');
  assert.equal(store.isVinylConfirmed('gone-now'), true);
  assert.equal(store.confirmedByYou('gone-now'), true);
  assert.equal(store.isVinylConfirmed('gone-now:deluxe'), false, 'the deluxe edition is confirmed separately');
  assert.equal(S.createStore(storage).isVinylConfirmed('gone-now'), true, 'confirmations are saved');
  store.unconfirmVinyl('gone-now');
  assert.equal(store.isVinylConfirmed('gone-now'), false);

  // Owning it on vinyl counts, edition by edition; a record of format "Other" doesn't
  store.add({ artist: 'Bleachers', title: 'Strange Desire', releaseGroupId: 'strange', format: 'LP' });
  store.add({ artist: 'Bleachers', title: 'Bleachers (Deluxe Edition)', releaseGroupId: 'bleachers', format: 'Double LP' });
  store.add({ artist: 'Bleachers', title: 'Terrible Thrills', releaseGroupId: 'thrills', format: 'Other' });
  assert.equal(store.isVinylConfirmed('strange'), true);
  assert.equal(store.confirmedByYou('strange'), false, 'not something you confirmed by hand');
  assert.equal(store.isVinylConfirmed('bleachers:deluxe'), true);
  assert.equal(store.isVinylConfirmed('bleachers'), false);
  assert.equal(store.isVinylConfirmed('thrills'), false);
});

test('backups carry vinyl confirmations', () => {
  const source = S.createStore(S.memoryStorage());
  source.confirmVinyl('gone-now');
  const target = S.createStore(S.memoryStorage());
  target.importJSON(source.exportJSON());
  assert.equal(target.confirmedByYou('gone-now'), true);
});

test('backups carry the wishlist too', () => {
  const source = S.createStore(S.memoryStorage());
  source.add({ artist: 'Weezer', title: 'Weezer', releaseGroupId: 'blue' });
  source.addToWishlist({ artist: 'Weezer', title: 'Pinkerton', releaseGroupId: 'pink' });
  source.addToWishlist({ artist: 'Weezer', title: 'Maladroit', releaseGroupId: 'mal' });

  const target = S.createStore(S.memoryStorage());
  target.add({ artist: 'Weezer', title: 'Maladroit', releaseGroupId: 'mal' }); // already have it here
  assert.deepEqual(target.importJSON(source.exportJSON()), { added: 1, skipped: 0, wishes: 1 });
  assert.deepEqual(target.wishlist().map((w) => w.title), ['Pinkerton'], 'albums you already have stay off the wishlist');
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
  assert.deepEqual(target.importJSON(backup), { added: 2, skipped: 0, wishes: 0 });
  assert.deepEqual(target.importJSON(backup), { added: 0, skipped: 2, wishes: 0 });
  assert.equal(target.all()[0].format, 'Double LP');
  assert.deepEqual(target.importJSON(JSON.stringify([{ artist: 'Low', title: 'Things We Lost in the Fire' }, { title: 'No artist' }])), { added: 1, skipped: 1, wishes: 0 });
  // A backup from another device skips albums you already have, even with different ids
  assert.deepEqual(target.importJSON(JSON.stringify([{ id: 'other-device', artist: 'portishead', title: 'Dummy' }])), { added: 0, skipped: 1, wishes: 0 });
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

test('a 45 goes to the single when an album shares its title', () => {
  const groups = [album('lp', 'Help!', '1965'), { id: 'sg', title: 'Help!', date: '1965', primaryType: 'Single', secondaryTypes: [] }];
  const records = [
    { id: 'r1', artist: 'The Beatles', title: 'Help!', format: '45' },
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

test('parseRecordList reads "Artist - Title" lines, keeps notes and folds repeats', () => {
  const { items, unreadable, merged } = S.parseRecordList([
    'Steely Dan - Aja',
    '  2. Rush – Moving Pictures (Signed)',
    'Bleachers - everyone for ten minutes',
    'Bleachers - everyone for ten minutes (Electric Lady)',
    'T.Rex - Teenage Dream (Single/45)',
    'Weezer - Pinkerton (Deluxe Edition)',
    'Lumineers - BRIGHTSIDE (I have 2)',
    'Glen Campbell\tBy The Time I Get To Phoenix',
    'Glen Campbell - By the Time I Get to Phoenix',
    '',
    'Just a title',
  ].join('\r\n'));
  assert.deepEqual(unreadable, ['Just a title']);
  assert.equal(merged, 2);
  const byTitle = Object.fromEntries(items.map((item) => [item.title, item]));
  assert.equal(items.length, 7);
  assert.deepEqual(byTitle.Aja, { artist: 'Steely Dan', title: 'Aja', notes: '', format: null, line: 'Steely Dan - Aja' });
  assert.equal(byTitle['Moving Pictures'].notes, 'Signed', 'numbering and other dashes are fine');
  assert.equal(byTitle['everyone for ten minutes'].notes, 'Electric Lady; 2 copies');
  assert.deepEqual([byTitle['Teenage Dream'].format, byTitle['Teenage Dream'].notes], ['45', ''], 'a note that only names the format is dropped');
  assert.equal(byTitle['Pinkerton (Deluxe Edition)'].notes, '', 'a deluxe edition keeps it in the title');
  assert.equal(byTitle.BRIGHTSIDE.notes, 'I have 2');
  assert.equal(byTitle['By The Time I Get To Phoenix'].notes, '2 copies', 'tab-separated lines work too');
});

const candidate = (title, extra = {}) => ({
  releaseGroupId: extra.id || title, title, artist: 'Weezer', artistId: 'w', year: 2001, primaryType: 'Album', secondaryTypes: [], ...extra,
});

test('bestAlbumMatch forgives typos but not different numbers', () => {
  const found = [candidate('Maladroit'), candidate('Make Believe')];
  assert.equal(S.bestAlbumMatch({ artist: 'Weezer', title: 'Maladriot' }, found).title, 'Maladroit');
  assert.equal(S.bestAlbumMatch({ artist: 'Weeser', title: 'Maladroit' }, found).renameArtist, true, 'a misspelled artist takes the MusicBrainz spelling');
  assert.equal(S.bestAlbumMatch({ artist: 'Weezer', title: 'Pinkerton' }, found), null);
  assert.equal(S.bestAlbumMatch({ artist: 'Toto', title: 'Toto' }, [candidate('Toto IV', { artist: 'Toto' })]), null);
  assert.equal(S.bestAlbumMatch({ artist: 'Moody Blues', title: 'Octave' }, [candidate('Octave', { artist: 'The Moody Blues' })]).renameArtist, true);
  const prince = candidate('Purple Rain', { artist: 'Prince and The Revolution', secondaryTypes: ['Soundtrack'] });
  assert.equal(S.bestAlbumMatch({ artist: 'Prince', title: 'Purple Rain' }, [prince]).renameArtist, false, 'a longer credit keeps your spelling');
});

test('bestAlbumMatch prefers albums, and gives up when it is too close to call', () => {
  const single = candidate('Buddy Holly', { id: 'single', primaryType: 'Single' });
  const album = candidate('Buddy Holly', { id: 'album' });
  assert.equal(S.bestAlbumMatch({ artist: 'Weezer', title: 'Buddy Holly' }, [single, album]).releaseGroupId, 'album');
  assert.equal(S.bestAlbumMatch({ artist: 'Weezer', title: 'Buddy Holly', format: '45' }, [single, album]).releaseGroupId, 'single', 'a 45 is a single');
  assert.equal(S.bestAlbumMatch({ artist: 'Weezer', title: 'Weezer' }, [candidate('Weezer', { id: 'blue' }), candidate('Weezer', { id: 'green' })]), null);
  const live = candidate("Get Yer Ya-Ya's Out! The Rolling Stones in Concert", { id: 'live', secondaryTypes: ['Live'] });
  const ep = candidate("Get Yer Ya-Ya's Out", { id: 'ep', primaryType: 'EP' });
  assert.equal(S.bestAlbumMatch({ artist: 'Weezer', title: "Get Yer Ya-Ya's Out!" }, [ep, live]).releaseGroupId, 'live', 'a subtitle can pick the album');
  assert.equal(S.bestAlbumMatch({ artist: 'Weezer', title: 'Chicago II' }, [candidate('Chicago II: Live on Soundstage', { secondaryTypes: ['Live'] })]), null,
    'but a live album found only by its subtitle is not enough');
  assert.equal(S.bestAlbumMatch({ artist: 'Weezer', title: 'Labyrinth' }, [candidate('Labyrinth: From the Original Soundtrack', { secondaryTypes: ['Soundtrack'] })]).title,
    'Labyrinth: From the Original Soundtrack');
  assert.equal(S.bestAlbumMatch({ artist: 'Masayoshi Takanaka', title: 'Seychelles' }, [candidate('SEYCHELLES', { artist: '高中正義', artistFound: true })]).renameArtist, false,
    'an artist found by alias keeps your spelling');
});

test('addMany adds several records at once and removeMany takes them back', () => {
  const store = S.createStore(S.memoryStorage());
  store.add({ artist: 'Steely Dan', title: 'Aja' });
  store.addToWishlist({ artist: 'Rush', title: '2112' });
  let changes = 0;
  store.onChange(() => changes++);
  const { added, skipped } = store.addMany([
    { artist: 'Steely Dan', title: 'aja' },
    { artist: 'Rush', title: '2112', pendingLookup: true },
    { artist: 'Rush', title: 'Moving Pictures', pendingLookup: true },
    { artist: '', title: 'No artist' },
  ]);
  assert.equal(added.length, 2);
  assert.equal(skipped.length, 2);
  assert.equal(changes, 1, 'one save for the lot');
  assert.equal(store.wishlist().length, 0, 'owning it takes it off the wishlist');
  assert.equal(store.get(added[0].id).pendingLookup, true);
  store.removeMany(added.map((record) => record.id));
  assert.deepEqual(store.all().map((record) => record.title), ['Aja']);
});

test('changing the artist name drops the old MusicBrainz artist link', () => {
  const store = S.createStore(S.memoryStorage());
  const record = store.add({ artist: 'Little Feet', title: 'Time Loves a Hero', artistId: 'wrong' });
  assert.equal(store.update(record.id, { notes: 'Signed' }).artistId, 'wrong');
  assert.equal(store.update(record.id, { artist: 'Little Feat' }).artistId, null);
  assert.equal(store.update(record.id, { artist: 'Little Feet', artistId: 'lf' }).artistId, 'lf');
});
