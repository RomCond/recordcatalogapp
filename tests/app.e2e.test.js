/*
 * Drives the real page in Chromium with Playwright.
 * MusicBrainz and the Cover Art Archive are answered with fixed sample data so the test
 * is repeatable and runs offline. Set SCREENSHOT_DIR to save screenshots along the way.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  chromium = null;
}

const PAGE_URL = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const SHOTS = process.env.SCREENSHOT_DIR;

const credit = (name, id) => [{ name, artist: { id, name } }];
const rg = (id, title, date, primaryType = 'Album', secondaryTypes = []) => ({
  id, title, 'first-release-date': date, 'primary-type': primaryType, 'secondary-types': secondaryTypes,
});

const DISCOGRAPHIES = {
  'a-radiohead': [
    rg('rg-pablo', 'Pablo Honey', '1993-02-22'),
    rg('rg-bends', 'The Bends', '1995-03-13'),
    rg('rg-okc', 'OK Computer', '1997-05-21'),
    rg('rg-kida', 'Kid A', '2000-10-02'),
    rg('rg-amnesiac', 'Amnesiac', '2001-06-04'),
    rg('rg-creep', 'Creep', '1992-09-21', 'Single'),
    rg('rg-wrong', 'I Might Be Wrong: Live Recordings', '2001-11-12', 'Album', ['Live']),
  ],
  'a-portishead': [
    rg('rg-dummy', 'Dummy', '1994-08-22'),
    rg('rg-portishead', 'Portishead', '1997-09-29'),
    rg('rg-third', 'Third', '2008-04-28'),
  ],
};

// Answers to the "vinyl releases by this artist" search. Pablo Honey only has a bootleg
// and a CD that slipped into the results, and the live album only a flexi-disc,
// so neither should count as having a vinyl pressing.
const vinylRelease = (group, format, status = 'Official') => ({ status, 'release-group': { id: group }, media: [{ format }] });
const VINYL_RELEASES = {
  'a-radiohead': [
    vinylRelease('rg-pablo', '12" Vinyl', 'Bootleg'),
    vinylRelease('rg-pablo', 'CD'),
    vinylRelease('rg-bends', '12" Vinyl'),
    vinylRelease('rg-okc', '12" Vinyl'),
    vinylRelease('rg-okc', '12" Vinyl'),
    vinylRelease('rg-kida', '10" Vinyl'),
    vinylRelease('rg-amnesiac', '10" Vinyl'),
    vinylRelease('rg-amnesiac', '12" Vinyl'),
    vinylRelease('rg-amnesiac', '12" Vinyl', 'Promotion'),
    vinylRelease('rg-creep', '7" Vinyl'),
    vinylRelease('rg-wrong', 'Flexi-disc'),
  ],
  'a-portishead': ['rg-dummy', 'rg-portishead', 'rg-third'].map((id) => vinylRelease(id, '12" Vinyl')),
};

// Answers to the "deluxe or expanded releases by this artist" search. The Bends has a deluxe
// edition on vinyl; Kid A's is CD only, so it only shows with Vinyl only turned off.
const DELUXE_RELEASES = {
  'a-radiohead': [
    { id: 'rel-bends-dlx', title: 'The Bends', disambiguation: 'collector’s deluxe edition', date: '2009-03-24', status: 'Official', 'release-group': { id: 'rg-bends' }, media: [{ format: '12" Vinyl' }, { format: '12" Vinyl' }] },
    { id: 'rel-kida-dlx', title: 'Kid A (Expanded Edition)', date: '2016-05-06', status: 'Official', 'release-group': { id: 'rg-kida' }, media: [{ format: 'CD' }] },
  ],
};

function fakeMusicBrainz(url) {
  const params = url.searchParams;
  const query = params.get('query') || '';
  if (url.pathname === '/ws/2/release-group' && params.get('artist')) {
    const groups = DISCOGRAPHIES[params.get('artist')] || [];
    return { 'release-group-count': groups.length, 'release-group-offset': 0, 'release-groups': groups };
  }
  if (url.pathname === '/ws/2/release' && query.startsWith('arid:')) {
    const artistId = /arid:"([^"]+)"/.exec(query)[1];
    const releases = (query.includes('format:') ? VINYL_RELEASES : DELUXE_RELEASES)[artistId] || [];
    return { count: releases.length, offset: 0, releases };
  }
  if (url.pathname === '/ws/2/release' && !query.startsWith('barcode:')) {
    // Typed search: vinyl pressings, grouped into albums by the app. Two pressings of OK Computer
    // show as one result; the CD and the bootleg are left out.
    const pressing = (id, group, extra = {}) => ({
      id, status: 'Official', score: 100, title: group.title, date: group.date,
      'release-group': { id: group.id, title: group.title, 'primary-type': 'Album', 'secondary-types': group.secondary || [] },
      'artist-credit': credit('Radiohead', 'a-radiohead'), media: [{ format: '12" Vinyl' }], ...extra,
    });
    const okc = { id: 'rg-okc', title: 'OK Computer', date: '1997-06-16' };
    const oknotok = { id: 'rg-oknotok', title: 'OK Computer OKNOTOK 1997 2017', date: '2017-06-23', secondary: ['Compilation'] };
    return {
      releases: [
        pressing('rel-okc-1', okc),
        pressing('rel-okc-2', okc, { date: '2016-05-06' }),
        pressing('rel-oknotok', oknotok, { score: 90, media: [{ format: '12" Vinyl' }, { format: '12" Vinyl' }, { format: '12" Vinyl' }] }),
        pressing('rel-okc-cd', okc, { media: [{ format: 'CD' }] }),
        pressing('rel-boot', { id: 'rg-boot', title: 'OK Computer Live', date: '1998' }, { status: 'Bootleg' }),
      ],
    };
  }
  if (url.pathname === '/ws/2/release' && query === 'barcode:5000000000045') {
    return {
      releases: [{
        id: 'rel-creep-7', title: 'Creep', date: '1992-09-21', status: 'Official', 'artist-credit': credit('Radiohead', 'a-radiohead'),
        'release-group': { id: 'rg-creep', 'primary-type': 'Single' }, media: [{ format: '7" Vinyl' }],
      }],
    };
  }
  if (url.pathname === '/ws/2/release' && query === 'barcode:0724384260927') {
    return {
      releases: [{
        id: 'rel-pablo-cd', title: 'Pablo Honey', 'artist-credit': credit('Radiohead', 'a-radiohead'),
        'release-group': { id: 'rg-pablo', 'primary-type': 'Album' }, media: [{ format: 'CD' }],
      }],
    };
  }
  if (url.pathname === '/ws/2/release' && query.startsWith('barcode:')) {
    return {
      releases: [{
        id: 'rel-kida',
        title: 'Kid A',
        date: '2000-10-02',
        'artist-credit': credit('Radiohead', 'a-radiohead'),
        'release-group': { id: 'rg-kida', 'primary-type': 'Album' },
        media: [{ format: '12" Vinyl' }, { format: '12" Vinyl' }],
      }],
    };
  }
  if (url.pathname === '/ws/2/artist') {
    return {
      artists: [
        { id: 'a-portishead', name: 'Portishead', type: 'Group', country: 'GB', disambiguation: 'Bristol trip hop band', score: 100 },
        { id: 'a-tribute', name: 'Portishead Tribute Band', type: 'Group', score: 60 },
      ],
    };
  }
  return { error: 'not in fixture' };
}

const coverHue = (id) => [...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 360;

// The rgb() a sample cover's background color comes out as.
function coverRgb(id) {
  const h = coverHue(id) / 360;
  const s = 0.45;
  const l = 0.45;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [h + 1 / 3, h, h - 1 / 3].map((t) => Math.round(channel(t) * 255));
}

function fakeCover(id) {
  const hue = coverHue(id);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="hsl(${hue} 45% 45%)"/><text x="8" y="90" font-family="Georgia" font-size="12" fill="#fff">${id}</text></svg>`;
}

async function openApp(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, ...options });
  const mbCalls = [];
  await context.route('https://musicbrainz.org/**', (route) => {
    const url = new URL(route.request().url());
    mbCalls.push(url);
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(fakeMusicBrainz(url)),
    });
  });
  // Some covers exist, the rest 404 so the vinyl placeholder shows.
  const coverCalls = [];
  await context.route('https://coverartarchive.org/**', (route) => {
    coverCalls.push(route.request().url());
    const id = route.request().url().split('/release-group/')[1].split('/')[0];
    if (['rg-okc', 'rg-kida', 'rg-dummy', 'rg-pablo'].includes(id)) {
      route.fulfill({ status: 200, contentType: 'image/svg+xml', body: fakeCover(id), headers: { 'Access-Control-Allow-Origin': '*' } });
    } else {
      route.fulfill({ status: 404, body: '' });
    }
  });
  // Fonts come from Google Fonts in real use; an empty stylesheet keeps the test offline.
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) errors.push(msg.text());
  });
  await page.goto(PAGE_URL);
  return { context, page, errors, mbCalls, coverCalls };
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

const text = (page, selector) => page.locator(selector).innerText();

// Tabs only change the address; the app switches screens on the hashchange that follows,
// so wait for that before reading anything.
async function openTab(page, route) {
  await page.click(route === 'wishlist' ? '.segmented a[href="#wishlist"]' : `.tabs a[href="#${route}"]`);
  await page.waitForFunction((r) => {
    const view = r === 'wishlist' ? 'collection' : r;
    const heading = { collection: 'Your collection', wishlist: 'Your wishlist' }[r];
    return location.hash === `#${r}`
      && !document.querySelector(`#view-${view}`).hidden
      && (!heading || document.querySelector('#collection-heading').textContent === heading);
  }, route);
}

async function assertNoJunkText(page, where) {
  const shown = await page.locator('main').innerText();
  assert.doesNotMatch(shown, /\b(null|undefined|NaN)\b/, `stray placeholder text on ${where}`);
}

test('add, browse, edit, shuffle and find missing records', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const { context, page, errors, mbCalls, coverCalls } = await openApp(browser);

    // Empty shelf
    assert.ok(await page.locator('#collection-empty').isVisible());
    await shot(page, '01-empty');

    // Results show up while typing part of a name, after one request rather than one per key
    await openTab(page, 'add');
    const searchBox = page.locator('#search-form [name=q]');
    const callsBeforeTyping = mbCalls.length;
    await searchBox.pressSequentially('radiohead ok comp', { delay: 40 });
    await page.locator('#search-results .result').first().waitFor();
    const typedSearches = mbCalls.slice(callsBeforeTyping);
    assert.equal(typedSearches.length, 1, `typing sent ${typedSearches.length} searches`);
    assert.match(typedSearches[0].searchParams.get('query'), /artist:\(radiohead ok comp comp\*\)/);
    assert.equal(await page.locator('#search-results .result').count(), 2);
    await page.locator('#search-results .result').first().getByRole('button', { name: 'Add' }).click();
    await page.locator('#toast.show', { hasText: 'Added OK Computer' }).waitFor();
    assert.equal(await text(page, '#nav-count'), '1');
    // Only one copy: an album you have can't be added again
    const addedButton = page.locator('#search-results .result').first().getByRole('button');
    assert.equal(await addedButton.innerText(), 'In collection');
    assert.ok(await addedButton.isDisabled());
    await shot(page, '02-search');

    // The same box takes a barcode, and the lookup picks the format from the release
    await searchBox.fill('0 724352 775324');
    await searchBox.press('Enter');
    await page.locator('#search-results .result', { hasText: 'Kid A' }).waitFor();
    assert.match(await text(page, '#search-results .result'), /2 x 12" Vinyl/);
    await page.locator('#search-results .result').getByRole('button', { name: 'Add' }).click();
    assert.equal(mbCalls.at(-1).searchParams.get('query'), 'barcode:0724352775324');

    // The catalog is vinyl only: a CD's barcode is turned away, and CD and Cassette aren't formats
    await searchBox.fill('0724384260927');
    await searchBox.press('Enter');
    await page.locator('#search-status', { hasText: 'That barcode is for a CD or cassette, not a vinyl record.' }).waitFor();
    assert.equal(await page.locator('#search-results .result').count(), 0);
    assert.deepEqual(await page.locator('#add-format option').allTextContents(), ['LP', 'Double LP', 'EP', '12" single', 'Box set', 'Other']);
    assert.deepEqual(await page.locator('#filter-format option').allTextContents(), ['All formats', ...['LP', 'Double LP', 'EP', '12" single', 'Box set', 'Other']]);

    // 45s and 10" records are off by default: a 45's barcode explains how to include them,
    // and turning them on searches again and adds 45 and 10" to the format menus
    await searchBox.fill('5000000000045');
    await searchBox.press('Enter');
    await page.locator('#search-status', { hasText: 'That barcode is for a 45 or a 10" record.' }).waitFor();
    await page.check('#small-records');
    await page.locator('#search-results .result', { hasText: 'Creep' }).waitFor();
    assert.match(await text(page, '#search-results .result'), /7" Vinyl/);
    assert.deepEqual(await page.locator('#add-format option').allTextContents(), ['LP', 'Double LP', 'EP', '45', '10"', '12" single', 'Box set', 'Other']);
    await page.uncheck('#small-records');
    await page.locator('#search-status', { hasText: 'That barcode is for a 45 or a 10" record.' }).waitFor();
    assert.equal(await page.locator('#search-results .result').count(), 0);
    assert.deepEqual(await page.locator('#add-format option').allTextContents(), ['LP', 'Double LP', 'EP', '12" single', 'Box set', 'Other']);

    // Manual entry keeps the artist filled in for the next one
    await page.click('#manual-add summary');
    const manual = page.locator('#manual-form');
    await manual.locator('[name=artist]').fill('Radiohead');
    await manual.locator('[name=title]').fill('The Bends (Remastered)');
    await manual.locator('[name=year]').fill('1995');
    await manual.locator('button[type=submit]').click();
    assert.equal(await manual.locator('[name=artist]').inputValue(), 'Radiohead');
    assert.equal(await manual.locator('[name=title]').inputValue(), '');
    await manual.locator('[name=title]').fill('Live at the Astoria');
    await manual.locator('button[type=submit]').click();
    await manual.locator('[name=artist]').fill('Portishead');
    await manual.locator('[name=title]').fill('Dummy');
    await manual.locator('button[type=submit]').click();
    assert.equal(await text(page, '#nav-count'), '5');

    // Typing in an album you already have is turned away, and the form keeps what you typed
    await manual.locator('[name=title]').fill('dummy');
    await manual.locator('button[type=submit]').click();
    await page.locator('#toast.show', { hasText: '"Dummy" is already in your collection.' }).waitFor();
    assert.equal(await text(page, '#nav-count'), '5');
    assert.equal(await manual.locator('[name=title]').inputValue(), 'dummy');

    // Collection, grouped by artist
    await openTab(page, 'collection');
    assert.equal(await text(page, '#collection-summary'), '5 records by 2 artists');
    assert.deepEqual(await page.locator('.artist-name').evaluateAll((els) => els.map((el) => el.firstChild.textContent)), ['Portishead', 'Radiohead']);
    assert.match(await text(page, '#collection-list'), /Kid A\n2000 · Double LP/);
    await shot(page, '03-collection');
    // Thumbnails use the sharper 500px covers
    assert.ok(coverCalls.some((url) => url.endsWith('/rg-okc/front-500')));
    assert.ok(!coverCalls.some((url) => url.endsWith('front-250')), 'no low-resolution covers');
    await page.fill('#filter-text', 'bends');
    assert.equal(await page.locator('#collection-list .record').count(), 1);
    await page.fill('#filter-text', '');

    // Edit, delete, undo
    await page.locator('.record', { hasText: 'Dummy' }).click();
    assert.ok(await page.locator('#edit-dialog').isVisible());
    await page.selectOption('#edit-form [name=format]', 'Box set');
    await page.fill('#edit-form [name=notes]', 'Found at a yard sale');
    await shot(page, '04-edit');
    await page.click('#edit-form button[value=save]');
    // The dialog's close event fires a moment after the click, so wait for the list to update.
    await page.locator('.record', { hasText: 'Dummy' }).filter({ hasText: 'Box set' }).waitFor();
    await page.locator('.record', { hasText: 'Dummy' }).click();
    await page.click('#edit-delete');
    assert.equal(await text(page, '#nav-count'), '4');
    await page.locator('#toast .toast-action').click();
    assert.equal(await text(page, '#nav-count'), '5');

    // Random pick, with an artist filter
    await openTab(page, 'random');
    await page.selectOption('#random-artist', { label: 'Portishead' });
    await page.click('#spin-btn');
    assert.equal(await text(page, '.pick-title'), 'Dummy');
    // No cover was found for Dummy (it was typed in), so the card takes its placeholder color
    const albumTint = () => page.locator('#view-random .random-card').evaluate((el) => el.classList.contains('has-album') && el.style.getPropertyValue('--album'));
    await page.waitForFunction(() => document.querySelector('#view-random .random-card').classList.contains('has-album'));
    assert.match(await albumTint(), /^hsl\(/);
    await page.selectOption('#random-artist', '');
    // Kid A is the only Double LP, and it has a cover: the big pick uses the 1200px version
    await page.selectOption('#random-format', 'Double LP');
    await page.click('#spin-btn');
    assert.equal(await text(page, '.pick-title'), 'Kid A');
    await page.locator('#spin-sleeve .cover.loaded').waitFor();
    assert.ok(coverCalls.some((url) => url.endsWith('/rg-kida/front-1200')));
    // Kid A has a cover, so the card fades down from the cover's main color
    await page.waitForFunction(() => document.querySelector('#view-random .random-card').style.getPropertyValue('--album').startsWith('rgb('));
    const [r, g, b] = (await albumTint()).match(/\d+/g).map(Number);
    const expected = coverRgb('rg-kida');
    assert.ok([r, g, b].every((v, i) => Math.abs(v - expected[i]) <= 3), `album color ${[r, g, b]} should match the cover ${expected}`);
    await shot(page, '05b-random-album-color');
    await page.selectOption('#random-format', '');
    const titles = new Set(['OK Computer', 'Kid A', 'The Bends (Remastered)', 'Live at the Astoria', 'Dummy']);
    const seen = [];
    for (let i = 0; i < 4; i++) {
      await page.click('#spin-btn');
      seen.push(await text(page, '.pick-title'));
    }
    assert.ok(seen.every((title) => titles.has(title)));
    assert.equal(new Set(seen).size, 4, `four picks in a row should not repeat: ${seen}`);
    await shot(page, '05-random');

    // Discography from the collection: Radiohead already has a MusicBrainz id
    await openTab(page, 'collection');
    await page.locator('.artist-group', { hasText: 'Radiohead' }).getByRole('button', { name: 'Discography' }).click();
    await page.locator('#disco-panel').waitFor();
    assert.equal(await text(page, '#disco-name'), 'Radiohead');
    // Vinyl only is on by default: Pablo Honey has no official vinyl, so it isn't listed as missing.
    // The Bends has a deluxe edition on vinyl, which gets its own line right after the original.
    assert.equal(await text(page, '#disco-progress-text'), 'You have 3 of 5');
    assert.equal(await text(page, '#missing-heading'), 'Missing (2)');
    // One line per album, with no count of individual pressings
    assert.equal(await text(page, '#disco-missing'), 'The Bends (Deluxe Edition)\n2009 · Album\nWishlist\nGot it\nAmnesiac\n2001 · Album\nWishlist\nGot it');
    assert.match(await text(page, '#disco-owned'), /^The Bends\n1995 · Album · You have: LP\nOK Computer/);
    assert.doesNotMatch(await text(page, '#disco-panel'), /Pablo Honey|Kid A \(Expanded/);
    assert.equal(await page.locator('.toggle', { hasText: 'Live' }).count(), 0, 'a flexi-disc alone should not count as vinyl');
    assert.match(await text(page, '#disco-unmatched'), /Live at the Astoria/);
    await assertNoJunkText(page, 'discography');
    await shot(page, '06-discography');

    // Turning it off shows everything, including the CD-only expanded edition
    await page.locator('.toggle', { hasText: 'Vinyl only' }).click();
    assert.equal(await text(page, '#disco-progress-text'), 'You have 3 of 7');
    assert.match(await text(page, '#disco-missing'), /Pablo Honey\n1993 · Album · No vinyl listed/);
    assert.match(await text(page, '#disco-missing'), /Kid A \(Expanded Edition\)\n2016 · Album · No vinyl listed/);
    await page.locator('.toggle', { hasText: 'Vinyl only' }).click();
    assert.equal(await text(page, '#disco-progress-text'), 'You have 3 of 5');

    // Wishlist from the discography: the button flips to "On wishlist", and tapping that takes it off again
    const missingRow = (title) => page.locator('#disco-missing .result', { hasText: title });
    const wishCount = () => page.locator('#count-wishlist').textContent();
    await missingRow('Amnesiac').getByRole('button', { name: 'Wishlist', exact: true }).click();
    await missingRow('The Bends (Deluxe Edition)').getByRole('button', { name: 'Wishlist', exact: true }).click();
    assert.equal(await wishCount(), '2');
    await missingRow('Amnesiac').getByRole('button', { name: 'On wishlist', exact: true }).click();
    assert.equal(await wishCount(), '1');
    await missingRow('Amnesiac').getByRole('button', { name: 'Wishlist', exact: true }).click();
    assert.equal(await wishCount(), '2');
    assert.equal(await text(page, '#disco-progress-text'), 'You have 3 of 5', 'wishlisted records still count as missing');

    // Getting a wishlisted record takes it off the wishlist
    await missingRow('Amnesiac').getByRole('button', { name: 'Got it' }).click();
    assert.equal(await text(page, '#disco-progress-text'), 'You have 4 of 5');
    assert.equal(await wishCount(), '1');

    // The wishlist lives in the Collection tab. Getting the deluxe edition from there ticks off
    // the deluxe line, not the original.
    await openTab(page, 'collection');
    await openTab(page, 'wishlist');
    assert.equal(await text(page, '#collection-heading'), 'Your wishlist');
    assert.deepEqual(await page.locator('#collection-list .record-title').allTextContents(), ['The Bends (Deluxe Edition)']);
    await page.locator('#collection-list .result').getByRole('button', { name: 'Got it' }).click();
    await page.locator('#wishlist-empty').waitFor();
    assert.equal(await text(page, '#nav-count'), '7');
    await openTab(page, 'discography');
    assert.equal(await text(page, '#disco-progress-text'), 'You have 5 of 5');
    assert.match(await text(page, '#disco-owned'), /The Bends\n1995 · Album · You have: LP\nThe Bends \(Deluxe Edition\)\n2009 · Album · You have: LP/);
    assert.equal(await text(page, '#disco-missing-empty'), 'You have every one of these.');

    // Creep only came out on 45, so with 45s and 10" records off it doesn't count as missing
    assert.equal(await page.locator('.toggle', { hasText: 'Singles' }).count(), 0, 'no singles count yet');
    await page.locator('.toggle', { hasText: 'Vinyl only' }).click();
    await page.locator('.toggle', { hasText: 'Singles' }).click();
    assert.match(await text(page, '#disco-missing'), /Creep\n1992 · Single · Only on 45 or 10"/);
    await page.locator('.toggle', { hasText: 'Vinyl only' }).click();
    assert.equal(await text(page, '#disco-progress-text'), 'You have 5 of 5');
    // Turning on 45s and 10" records here does the same as on the Add page
    await page.locator('.toggle', { hasText: '45s and 10"' }).click();
    assert.equal(await text(page, '#disco-progress-text'), 'You have 5 of 6');
    assert.ok(await page.locator('#small-records').isChecked(), 'the Add page checkbox follows');

    // Copy the missing list
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('#disco-copy');
    await page.locator('#toast.show', { hasText: 'Copied 1 title' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Radiohead - Creep (1992)');

    // Remove from the wishlist, then undo
    await missingRow('Creep').getByRole('button', { name: 'Wishlist', exact: true }).click();
    await openTab(page, 'collection');
    await openTab(page, 'wishlist');
    await page.locator('#collection-list .result', { hasText: 'Creep' }).getByRole('button', { name: 'Remove' }).click();
    await page.locator('#wishlist-empty').waitFor();
    await page.locator('#toast .toast-action').click();
    assert.deepEqual(await page.locator('#collection-list .record-title').allTextContents(), ['Creep']);
    await assertNoJunkText(page, 'wishlist');
    await shot(page, '07-wishlist');
    await openTab(page, 'discography');

    // Portishead has no id yet, so the app looks the name up once and remembers it
    const callsBefore = mbCalls.length;
    await page.selectOption('#disco-artist', { label: 'Portishead (1)' });
    await page.locator('#disco-name', { hasText: 'Portishead' }).waitFor();
    assert.equal(await text(page, '#disco-progress-text'), 'You have 1 of 3');
    assert.deepEqual(mbCalls.slice(callsBefore).map((u) => u.pathname), ['/ws/2/artist', '/ws/2/release-group', '/ws/2/release', '/ws/2/release']);
    const linked = await page.evaluate(() => JSON.parse(localStorage.getItem('recordcatalog.records.v1')).find((r) => r.title === 'Dummy').artistId);
    assert.equal(linked, 'a-portishead');

    // Cached: coming back to Radiohead makes no new requests
    const callsCached = mbCalls.length;
    await page.selectOption('#disco-artist', { label: 'Radiohead (6)' });
    await page.locator('#disco-name', { hasText: 'Radiohead' }).waitFor();
    assert.equal(mbCalls.length, callsCached);

    // Survives a reload, including the type filter
    await page.reload();
    assert.equal(await text(page, '#nav-count'), '7');
    await page.goto(`${PAGE_URL}#discography`);
    await page.selectOption('#disco-artist', { label: 'Radiohead (6)' });
    assert.equal(await text(page, '#disco-progress-text'), 'You have 5 of 6');

    // Backup, wipe, restore
    await openTab(page, 'collection');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
    const backupPath = await download.path();
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    assert.equal(backup.records.length, 7);
    assert.deepEqual(backup.wishlist.map((w) => w.title), ['Creep']);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    assert.ok(await page.locator('#collection-empty').isVisible());
    await page.setInputFiles('#import-file', backupPath);
    await page.locator('#toast.show', { hasText: 'Imported 7 records and 1 for your wishlist' }).waitFor();
    assert.equal(await text(page, '#nav-count'), '7');
    assert.equal(await wishCount(), '1');

    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
  }
});

test('uses Inter Tight and Inter, and follows the phone\'s light or dark setting', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    for (const [colorScheme, background] of [['light', 'rgb(243, 245, 251)'], ['dark', 'rgb(7, 9, 15)']]) {
      const { context, page, errors } = await openApp(browser, { colorScheme });
      const styles = await page.evaluate(() => ({
        heading: getComputedStyle(document.querySelector('#collection-heading')).fontFamily,
        body: getComputedStyle(document.body).fontFamily,
        background: getComputedStyle(document.body).backgroundColor,
      }));
      assert.match(styles.heading, /^"?Inter Tight"?,/);
      assert.match(styles.body, /^"?Inter"?,/);
      assert.equal(styles.background, background, `${colorScheme} background`);
      assert.equal(await page.locator('#theme-btn, #look-dialog').count(), 0, 'there is no theme picker');
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test('fits a phone screen in light and dark mode', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    for (const colorScheme of ['light', 'dark']) {
      const { context, page, errors } = await openApp(browser, { viewport: { width: 375, height: 760 }, colorScheme });
      await page.evaluate(() => {
        const records = [
          ['Radiohead', 'a-radiohead', 'OK Computer', 1997, 'rg-okc', 'LP'],
          ['Radiohead', 'a-radiohead', 'Kid A', 2000, 'rg-kida', 'Double LP'],
          ['Portishead', null, 'Dummy', 1994, 'rg-dummy', 'LP'],
          ['Godspeed You! Black Emperor', null, 'Lift Your Skinny Fists Like Antennas to Heaven', 2000, null, 'Box set'],
        ].map(([artist, artistId, title, year, releaseGroupId, format], i) => ({
          id: `r${i}`, artist, artistId, title, year, releaseGroupId, format, notes: '', releaseId: null, addedAt: new Date(2024, 0, i + 1).toISOString(),
        }));
        localStorage.setItem('recordcatalog.records.v1', JSON.stringify(records));
        localStorage.setItem('recordcatalog.wishlist.v1', JSON.stringify([{
          id: 'w1', artist: 'Radiohead', artistId: 'a-radiohead', title: 'Amnesiac', year: 2001, releaseGroupId: 'rg-amnesiac',
          format: 'LP', notes: '', releaseId: null, addedAt: new Date(2024, 1, 1).toISOString(),
        }]));
      });
      for (const view of ['collection', 'wishlist', 'add', 'random', 'discography']) {
        await page.goto(`${PAGE_URL}#${view}`);
        await page.reload();
        if (view === 'random') await page.click('#spin-btn');
        if (view === 'discography') {
          await page.selectOption('#disco-artist', { label: 'Radiohead (2)' });
          await page.locator('#disco-panel').waitFor();
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `${view} (${colorScheme}) scrolls sideways by ${overflow}px`);
        await assertNoJunkText(page, `${view} (${colorScheme})`);
        await shot(page, `phone-${colorScheme}-${view}`);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
