# Record Catalog

Record Catalog is a small web app that tracks the vinyl records you own and the ones you're looking for.

- **Add records fast.** One search box takes part of an album or artist name, like "ok comp" or "radiohead kid", or the barcode from the sleeve, and shows matches as you type. Search lists only vinyl. Each album or single that came out on vinyl gets one line, however many pressings it has. Studio albums show even when MusicBrainz lists no vinyl pressing for them, marked "Vinyl not confirmed". A barcode for a CD or cassette gets a message saying so instead of a result. Search includes LPs and 12" records, and leaves out 45s (7") and 10" records unless you tick **Include 45s and 10" records** on the Add page. The **45s and 10"** chip in the discography is the same setting. One tap adds a record, and its year and cover art fill in on their own. You can add anything that isn't in the database by hand. You keep one copy per album, so an album you already have shows "In collection" instead of an Add button. A deluxe edition counts as its own album.
- **Import a list.** If your records are already in a note or spreadsheet, tap **Import a list** on the Collection page and paste the list or choose a text file, with one record per line: `Steely Dan - Aja`. The app adds them all at once, then looks each one up on MusicBrainz in the background for its cover, year and spelling. See [Importing a list](#importing-a-list).
- **Browse your shelf.** The buttons next to the search box switch between covers, three across on a phone, and a slim list. The app remembers your choice. The collection groups records under the first letter of the artist's name, ignoring a leading "The". On a list of more than 20 records, a strip of letters runs down the right side. Tap a letter, or slide a finger along the strip, to jump to it. **Filter** opens the format filter and the sort order: artist, recently added, year (grouped by decade) or title. Tap a record to edit or delete it, or to open the artist's discography.
- **Pick one at random.** You can limit the pick to a format or an artist. The app avoids repeating any of your last five picks. The background behind the pick is a gradient from the main color of its cover, and the top of a record's edit screen uses the same gradient.
- **See what you're missing.** Pick an artist, and the app compares their discography with your collection. It lists what you have and what you're missing, and **Copy list** puts the missing titles on your clipboard to take to the record store. Tap **Got it** when you find one, or **Wishlist** to save it for later.
- **Keep a wishlist.** The Collection tab switches between your records and your wishlist. Tap **Got it** on a wishlist record to move it into your collection. Adding a record any other way also takes it off the wishlist.

Lookups use [MusicBrainz](https://musicbrainz.org) and the [Cover Art Archive](https://coverartarchive.org). Both are free and need no API key. To read a cover's main color, the app needs the image server to allow cross-origin reads. If it doesn't, the app uses the record's placeholder color. Covers load at 500px in lists and the cover grid and at 1200px for the random pick, so they stay sharp on phone screens.

The colors are electric blue on cool white, or near-black in dark mode, and the app follows the phone's light or dark setting. Headings use Inter Tight and text uses Inter, both from Google Fonts. Without a connection, they fall back to the system font.

## Running it

There is no build step. Open `index.html` in a browser, or serve the folder:

```sh
npm start   # python3 -m http.server 8080, then open http://localhost:8080
```

Any static host, such as GitHub Pages or Netlify, works too.

## Where the data lives

The app saves records in the browser's `localStorage`, so each browser and device has its own copy. **Export backup** at the bottom of the Collection page saves a JSON file of your records and wishlist, and **Import backup** loads it somewhere else. Importing a backup merges it with what's there and skips albums you already have.

MusicBrainz allows about one request per second. The search box waits for a short pause in typing and cancels searches you've typed past. The app keeps each discography for a week, and **Refresh** on an artist fetches it again.

## Importing a list

Each line is an artist, a dash with a space on each side, then the title. A tab between artist and title also works, so you can paste two columns from a spreadsheet. The import ignores numbering and bullets at the start of a line.

Text in brackets at the end of a title becomes a note, like `(Signed)` or `(Test Press)`. The words "Deluxe" and "Expanded" stay in the title instead, so the deluxe edition counts as its own album. `(45)` or `(Single)` makes the record a 45, and since the format already says so, the app drops it from the notes. Every other record gets the format chosen under **Add as**. Before you add anything, the import screen says how many records it will add and lists any lines it can't read.

You keep one copy per album, so the import skips albums already in your collection. Lines that name the same album become one record with a note like "2 copies".

After adding, the app looks up each record on MusicBrainz, about one a second, and shows its progress above the collection. You can keep using the app while it works. If you close the app or it loses its connection, the lookups continue the next time it's open, or when you tap **Try again**. The app only takes a match when it's clear:

- Small typos in the artist or title still match, like "Metalica" or "Random Access Memory", and the record takes MusicBrainz's spelling. Numbers have to agree, so "Toto I" never matches "Toto IV".
- An artist name that's part of a longer credit, like "Prince" for "Prince and The Revolution", keeps your spelling, so it stays grouped with your other records.
- The app finds artists that MusicBrainz lists under another name by their alias. Masayoshi Takanaka, for example, is 高中正義 on MusicBrainz.
- When a studio album shares its name with a single or a live album, the studio album is the match. A record marked as a 45 matches the single.
- When two different albums fit about equally well, like Weezer's several albums called "Weezer", the app leaves the record unmatched.

The panel above the collection lists the records that weren't matched, which have no cover or year. Tap one to fix its artist or title, and the app looks it up again. **Dismiss** hides the list.

## How the missing list works

1. The app fetches every album, EP and single credited to the artist on MusicBrainz.
2. It checks which of those have at least one vinyl pressing: an LP or 12" record, or a 45 or 10" record when you've turned those on. Flexi-discs, VinylDisc hybrids and bootlegs don't count. MusicBrainz search returns at most 500 results per query, so for artists with more vinyl pressings than that, the app searches a range of years at a time. At one request a second, big catalogs take longer to load, about 15 seconds for David Bowie and 40 for the Beatles.
3. Deluxe and expanded editions get their own line right after the original, since they add songs. MusicBrainz usually files them under the original album, so the app finds them by releases whose title or note says "deluxe" or "expanded". All of an album's deluxe releases share one line. Owning the original doesn't count as owning the deluxe edition, or the other way round.
4. A record you added through search or barcode matches by its MusicBrainz release group id.
5. A record you typed in by hand matches by title, ignoring case, accents, punctuation and notes like "(2009 Remaster)". If its title says "Deluxe" or "Expanded", it goes on the deluxe line.
6. Records by that artist that match nothing appear under "Yours, but not matched", so you can fix the title.

**Vinyl only** is on by default, so the missing list shows only releases that came out on vinyl, one line per album however many pressings exist. Studio albums are the exception. MusicBrainz often lacks the vinyl pressings of albums that have them, so studio albums show anyway, marked "Vinyl not confirmed". Singles, EPs, live albums, compilations and deluxe editions still need a vinyl pressing in MusicBrainz.

If you know a release came out on vinyl, tap **Confirm** under "Vinyl not confirmed", in the discography or in search results, and the app counts it as vinyl from then on. **Undo** takes the confirmation back. Owning a record in a vinyl format also confirms it. The app saves confirmations on the device and includes them in backups. Records you already own always show. Turn **Vinyl only** off to see everything.

The discography shows studio albums by default. The toggles at the top switch on EPs, singles, live albums, compilations and other types, and the choice applies to every artist.

## Project layout

```
index.html            page markup for all four views
css/styles.css        styles, light and dark
js/store.js           records, backups, caching, and the matching logic
js/musicbrainz.js     MusicBrainz and Cover Art Archive client
js/app.js             the UI
tests/                unit tests and browser tests
```

## Tests

```sh
npm test            # unit tests, no install needed (Node 18+)
npm run test:e2e    # browser tests with Playwright
```

The browser tests need Playwright (`npm install`, then `npx playwright install chromium`). They answer MusicBrainz calls with fixed sample data, so they run offline and give the same result every time. Set `SCREENSHOT_DIR=some/folder` to save screenshots of each view.
