# Record Catalog

A small web app for keeping track of the vinyl records you own and the ones you're looking for.

- **Add records fast.** One search box takes any part of an album or artist name ("ok comp", "radiohead kid") or the barcode from the sleeve, and shows matches as you type. It's vinyl only: search lists albums and singles that came out on vinyl (one line each, however many pressings there are), plus studio albums whose vinyl MusicBrainz hasn't confirmed, marked "Vinyl not confirmed", and a barcode for a CD or cassette is turned away. LPs and 12" records are included; 45s (7") and 10" records are left out unless you tick **Include 45s and 10" records** on the Add page (or the **45s and 10"** chip in the discography, which is the same setting). Add one in one tap; year and cover art fill in on their own. Anything that isn't in the database can be added by hand. You keep one copy per album: albums you already have show "In collection" instead of an Add button (a deluxe edition counts as its own album).
- **Import a list.** Already have your records in a note or spreadsheet? Tap **Import a list** on the Collection page and paste it, or choose a text file, one record per line: `Steely Dan - Aja`. They're all added at once, then looked up on MusicBrainz in the background for covers, years and spellings. See [Importing a list](#importing-a-list).
- **Browse your shelf.** Grouped by artist, with search, a format filter and a few sort orders. Tap a record to edit or delete it.
- **Pick one at random.** Filter by format or artist if you like. It won't repeat the last few picks. The card behind the pick fades down from the main color of its cover, and so does the top of a record's edit screen.
- **See what you're missing.** Pick an artist and the app compares their discography with your shelf: what you have, what you don't, and a copyable list to take to the record store. Tap "Got it" when you find one, or "Wishlist" to save it for later.
- **Keep a wishlist.** The Collection tab switches between your records and your wishlist. Tap "Got it" on a wishlist record to move it onto your shelf; getting a record any other way takes it off the wishlist too.

Lookups use [MusicBrainz](https://musicbrainz.org) and the [Cover Art Archive](https://coverartarchive.org). Both are free and need no API key. Reading a cover's main color needs the image server to allow cross-origin reads; if it doesn't, the record's placeholder color is used instead. Covers load at 500px for the lists and 1200px for the random pick, so they stay sharp on phone screens. The colors are electric blue on cool white, or near-black in dark mode. Headings use Inter Tight and text uses Inter, from Google Fonts; without a connection they fall back to the system font. Light or dark follows the phone's setting.

## Running it

There is no build step. Open `index.html` in a browser, or serve the folder:

```sh
npm start   # python3 -m http.server 8080, then open http://localhost:8080
```

Any static host works too (GitHub Pages, Netlify and so on).

## Where the data lives

Records are saved in the browser's `localStorage`, so each browser and device has its own copy. Use **Export backup** at the bottom of the Collection page to save a JSON file of your records and wishlist, and **Import backup** to load it somewhere else. Importing merges and skips albums that are already there.

MusicBrainz allows about one request per second. The search box waits for a short pause in typing and cancels searches you've typed past, and discographies are cached for a week. Use **Refresh** on an artist to fetch again.

## Importing a list

Each line is an artist, a dash with a space on each side, then the title (a tab between them works too, so you can paste two columns from a spreadsheet). Numbering and bullets at the start of a line are ignored. Brackets at the end of a title become notes, like `(Signed)` or `(Test Press)`, except "Deluxe" or "Expanded", which stay in the title so the deluxe edition counts as its own album. `(45)` or `(Single)` makes the record a 45; everything else is added as the format chosen under **Add as**. The import screen says how many records it will add before you add them, and lists any line it can't read.

You keep one copy per album, so albums already in your collection are skipped, and lines naming the same album twice become one record with a note like "2 copies".

After adding, the app looks each record up on MusicBrainz, about one a second, and shows its progress above the collection. You can keep using the app meanwhile; if it's closed or loses its connection, the lookups carry on the next time it's open (or when you tap **Try again**). A match is only taken when it's clear:

- Small typos in the artist or title are fine ("Metalica", "Random Access Memory"), and the record takes MusicBrainz's spelling. Numbers have to agree, so "Toto" is never "Toto IV".
- An artist name that's part of a longer credit, like "Prince" for "Prince and The Revolution", keeps your spelling so it stays grouped with your other records.
- Artists listed under another name, like Masayoshi Takanaka (高中正義), are found by their alias.
- A studio album wins over a single or a live album of the same name, and a 45 is matched to the single.
- When two different albums fit about as well (Weezer has several called "Weezer"), it's left alone.

Records that weren't matched are listed above the collection, with no cover or year. Tap one to fix its artist or title and it's looked up again. **Dismiss** hides the list.

## How "missing" is worked out

1. The app fetches every album, EP and single credited to the artist on MusicBrainz.
2. It also checks which of those albums have at least one vinyl pressing: an LP or 12" record, or a 45 or 10" record when those are turned on. Flexi-discs, VinylDisc hybrids and bootlegs don't count. MusicBrainz search returns at most 500 results at a time, so for artists with more vinyl pressings than that (David Bowie, the Beatles) the app searches a range of years at a time. Those take longer to load, up to about 45 seconds.
3. Deluxe and expanded editions get their own line right after the original, since they add songs. MusicBrainz usually files them under the original album, so the app finds them by releases whose title or note says "deluxe" or "expanded". All of an album's deluxe releases fold into one line, and owning one edition doesn't tick off the other.
4. A record you added through search or barcode matches by its MusicBrainz release group id.
5. A record you typed in by hand matches by title, ignoring case, accents, punctuation and notes like "(2009 Remaster)". If its title says "Deluxe" or "Expanded", it goes on the deluxe line.
6. Anything by that artist that matches nothing is listed under "Yours, but not matched" so you can fix the title.

**Vinyl only** is on by default, so the missing list only shows releases that came out on vinyl, one line per album no matter how many pressings exist. Studio albums are the exception: MusicBrainz often lacks the vinyl pressings of albums that have them, so they show anyway, marked "Vinyl not confirmed". Singles, EPs, live albums, compilations and deluxe editions still need a vinyl pressing listed. If you know a release is out on vinyl, tap **Confirm** under "Vinyl not confirmed" (in the discography or in search results) and it counts as vinyl from then on; **Undo** takes it back. Owning a record in a vinyl format confirms it automatically. Confirmations are saved on the device and included in backups. Records you already own always show. Turn Vinyl only off to see everything.

Studio albums are shown by default. EPs, singles, live albums, compilations and other types can be switched on per artist.

## Project layout

```
index.html            page markup for all four views
css/styles.css        styles, light and dark
js/store.js           records, backups, caching, and the matching logic
js/musicbrainz.js     MusicBrainz and Cover Art Archive client
js/app.js             the UI
tests/                unit tests and a browser test
```

## Tests

```sh
npm test            # unit tests, no install needed (Node 18+)
npm run test:e2e    # browser test with Playwright
```

The browser test needs Playwright (`npm install`, then `npx playwright install chromium`). It answers MusicBrainz calls with fixed sample data so it runs offline and gives the same result every time. Set `SCREENSHOT_DIR=some/folder` to save screenshots of each view.
