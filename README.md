# Record Catalog

A small web app for keeping track of the vinyl records you own and the ones you're looking for.

- **Add records fast.** One search box takes any part of an album or artist name ("ok comp", "radiohead kid") or the barcode from the sleeve, and shows matches as you type. It's vinyl only: search lists only albums and singles that came out on vinyl (one line each, however many pressings there are), and a barcode for a CD or cassette is turned away. LPs and 12" records are included; 45s (7") and 10" records are left out unless you tick **Include 45s and 10" records** on the Add page (or the **45s and 10"** chip in the discography, which is the same setting). Add one in one tap; year and cover art fill in on their own. Anything that isn't in the database can be added by hand. You keep one copy per album: albums you already have show "In collection" instead of an Add button (a deluxe edition counts as its own album).
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

## How "missing" is worked out

1. The app fetches every album, EP and single credited to the artist on MusicBrainz.
2. It also checks which of those albums have at least one vinyl pressing: an LP or 12" record, or a 45 or 10" record when those are turned on. Flexi-discs, VinylDisc hybrids and bootlegs don't count.
3. Deluxe and expanded editions get their own line right after the original, since they add songs. MusicBrainz usually files them under the original album, so the app finds them by releases whose title or note says "deluxe" or "expanded". All of an album's deluxe releases fold into one line, and owning one edition doesn't tick off the other.
4. A record you added through search or barcode matches by its MusicBrainz release group id.
5. A record you typed in by hand matches by title, ignoring case, accents, punctuation and notes like "(2009 Remaster)". If its title says "Deluxe" or "Expanded", it goes on the deluxe line.
6. Anything by that artist that matches nothing is listed under "Yours, but not matched" so you can fix the title.

**Vinyl only** is on by default, so the missing list only shows albums that came out on vinyl, one line per album no matter how many pressings exist. Records you already own always show. Turn it off to see everything, which helps when MusicBrainz is missing a pressing you know exists.

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
