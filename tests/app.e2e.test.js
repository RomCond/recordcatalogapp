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
  if (url.pathname === '/ws/2/release-group') {
    return {
      'release-groups': [
        { ...rg('rg-okc', 'OK Computer', '1997-05-21'), 'artist-credit': credit('Radiohead', 'a-radiohead') },
        { ...rg('rg-oknotok', 'OK Computer OKNOTOK 1997 2017', '2017-06-23', 'Album', ['Compilation']), 'artist-credit': credit('Radiohead', 'a-radiohead') },
      ],
    };
  }
  if (url.pathname === '/ws/2/release' && query.startsWith('arid:')) {
    const artistId = /arid:"([^"]+)"/.exec(query)[1];
    const releases = (query.includes('format:') ? VINYL_RELEASES : DELUXE_RELEASES)[artistId] || [];
    return { count: releases.length, offset: 0, releases };
  }
  if (url.pathname === '/ws/2/release' && query.startsWith('barcode:')) {
    return {
      releases: [{
        id: 'rel-kida',
        title: 'Kid A',
        date: '2000-10-02',
        'artist-credit': credit('Radiohead', 'a-radiohead'),
        'release-group': { id: 'rg-kida', 'primary-type': 'Album' },
        media: [{ format: '10" Vinyl' }, { format: '10" Vinyl' }],
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

function fakeCover(id) {
  const hue = [...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 360;
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
  await context.route('https://coverartarchive.org/**', (route) => {
    const id = route.request().url().split('/release-group/')[1].split('/')[0];
    if (['rg-okc', 'rg-kida', 'rg-dummy', 'rg-pablo'].includes(id)) {
      route.fulfill({ status: 200, contentType: 'image/svg+xml', body: fakeCover(id) });
    } else {
      route.fulfill({ status: 404, body: '' });
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) errors.push(msg.text());
  });
  await page.goto(PAGE_URL);
  return { context, page, errors, mbCalls };
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

const text = (page, selector) => page.locator(selector).innerText();

async function assertNoJunkText(page, where) {
  const shown = await page.locator('main').innerText();
  assert.doesNotMatch(shown, /\b(null|undefined|NaN)\b/, `stray placeholder text on ${where}`);
}

test('add, browse, edit, shuffle and find missing records', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const { context, page, errors, mbCalls } = await openApp(browser);

    // Empty shelf
    assert.ok(await page.locator('#collection-empty').isVisible());
    await shot(page, '01-empty');

    // Results show up while typing part of a name, after one request rather than one per key
    await page.click('a[href="#add"]');
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
    assert.equal(await text(page, '#search-results .result:first-child .badge'), 'In collection');
    await shot(page, '02-search');

    // The same box takes a barcode, and the lookup picks the format from the release
    await searchBox.fill('0 724352 775324');
    await searchBox.press('Enter');
    await page.locator('#search-results .result', { hasText: 'Kid A' }).waitFor();
    assert.match(await text(page, '#search-results .result'), /2 x 10" Vinyl/);
    await page.locator('#search-results .result').getByRole('button', { name: 'Add' }).click();
    assert.equal(mbCalls.at(-1).searchParams.get('query'), 'barcode:0724352775324');

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

    // Collection, grouped by artist
    await page.click('a[href="#collection"]');
    assert.equal(await text(page, '#collection-summary'), '5 records by 2 artists');
    assert.deepEqual(await page.locator('.artist-name').evaluateAll((els) => els.map((el) => el.firstChild.textContent)), ['Portishead', 'Radiohead']);
    assert.match(await text(page, '#collection-list'), /Kid A\n2000 · Double LP/);
    await shot(page, '03-collection');
    await page.fill('#filter-text', 'bends');
    assert.equal(await page.locator('#collection-list .record').count(), 1);
    await page.fill('#filter-text', '');

    // Edit, delete, undo
    await page.locator('.record', { hasText: 'Dummy' }).click();
    assert.ok(await page.locator('#edit-dialog').isVisible());
    await page.selectOption('#edit-form [name=format]', 'CD');
    await page.fill('#edit-form [name=notes]', 'Found at a yard sale');
    await shot(page, '04-edit');
    await page.click('#edit-form button[value=save]');
    // The dialog's close event fires a moment after the click, so wait for the list to update.
    await page.locator('.record', { hasText: 'Dummy' }).filter({ hasText: 'CD' }).waitFor();
    await page.locator('.record', { hasText: 'Dummy' }).click();
    await page.click('#edit-delete');
    assert.equal(await text(page, '#nav-count'), '4');
    await page.locator('#toast .toast-action').click();
    assert.equal(await text(page, '#nav-count'), '5');

    // Random pick, with an artist filter
    await page.click('a[href="#random"]');
    await page.selectOption('#random-artist', { label: 'Portishead' });
    await page.click('#spin-btn');
    assert.equal(await text(page, '.pick-title'), 'Dummy');
    await page.selectOption('#random-artist', '');
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
    await page.click('a[href="#collection"]');
    await page.locator('.artist-group', { hasText: 'Radiohead' }).getByRole('button', { name: 'Discography' }).click();
    await page.locator('#disco-panel').waitFor();
    assert.equal(await text(page, '#disco-name'), 'Radiohead');
    // Vinyl only is on by default: Pablo Honey has no official vinyl, so it isn't listed as missing.
    // The Bends has a deluxe edition on vinyl, which gets its own line right after the original.
    assert.equal(await text(page, '#disco-progress-text'), 'You have 3 of 5');
    assert.equal(await text(page, '#missing-heading'), 'Missing (2)');
    // One line per album, with no count of individual pressings
    assert.equal(await text(page, '#disco-missing'), 'The Bends (Deluxe Edition)\n2009 · Album\nGot it\nAmnesiac\n2001 · Album\nGot it');
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

    await page.locator('#disco-missing .result', { hasText: 'Amnesiac' }).getByRole('button', { name: 'Got it' }).click();
    assert.equal(await text(page, '#disco-progress-text'), 'You have 4 of 5');
    // Getting the deluxe edition ticks off the deluxe line, not the original
    await page.locator('#disco-missing .result', { hasText: 'The Bends (Deluxe Edition)' }).getByRole('button', { name: 'Got it' }).click();
    assert.equal(await text(page, '#disco-progress-text'), 'You have 5 of 5');
    assert.match(await text(page, '#disco-owned'), /The Bends\n1995 · Album · You have: LP\nThe Bends \(Deluxe Edition\)\n2009 · Album · You have: LP/);
    assert.equal(await text(page, '#disco-missing-empty'), 'You have every one of these.');
    await page.locator('.toggle', { hasText: 'Singles' }).click();
    assert.equal(await text(page, '#disco-progress-text'), 'You have 5 of 6');

    // Copy the missing list
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('#disco-copy');
    await page.locator('#toast.show', { hasText: 'Copied 1 title' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Radiohead - Creep (1992)');

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
    await page.click('a[href="#collection"]');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
    const backupPath = await download.path();
    assert.equal(JSON.parse(fs.readFileSync(backupPath, 'utf8')).records.length, 7);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    assert.ok(await page.locator('#collection-empty').isVisible());
    await page.setInputFiles('#import-file', backupPath);
    await page.locator('#toast.show', { hasText: 'Imported 7 records' }).waitFor();
    assert.equal(await text(page, '#nav-count'), '7');

    assert.deepEqual(errors, []);
    await context.close();
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
      });
      for (const view of ['collection', 'add', 'random', 'discography']) {
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
