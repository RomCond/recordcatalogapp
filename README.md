# Record Catalog

A small web app for keeping track of the records you own.

- **Add records fast.** One search box takes any part of an album or artist name ("ok comp", "radiohead kid") or the barcode from the sleeve, and shows matches as you type. Add one in one tap; year and cover art fill in on their own. Anything that isn't in the database can be added by hand.
- **Browse your shelf.** Grouped by artist, with search, a format filter and a few sort orders. Tap a record to edit or delete it.
- **Pick one at random.** Filter by format or artist if you like. It won't repeat the last few picks.
- **See what you're missing.** Pick an artist and the app compares their discography with your shelf: what you have, what you don't, and a copyable list to take to the record store. Tap "Got it" when you find one.

Lookups use [MusicBrainz](https://musicbrainz.org) and the [Cover Art Archive](https://coverartarchive.org). Both are free and need no API key.

## Running it

There is no build step. Open `index.html` in a browser, or serve the folder:

```sh
npm start   # python3 -m http.server 8080, then open http://localhost:8080
```

Any static host works too (GitHub Pages, Netlify and so on).

## Where the data lives

Records are saved in the browser's `localStorage`, so each browser and device has its own copy. Use **Export backup** at the bottom of the Collection page to save a JSON file, and **Import backup** to load it somewhere else. Importing merges and skips records that are already there.

MusicBrainz allows about one request per second. The search box waits for a short pause in typing and cancels searches you've typed past, and discographies are cached for a week. Use **Refresh** on an artist to fetch again.

## How "missing" is worked out

1. The app fetches every album, EP and single credited to the artist on MusicBrainz.
2. It also checks which of those albums have at least one vinyl pressing (Vinyl, 7", 10" or 12" Vinyl). Flexi-discs, VinylDisc hybrids and bootlegs don't count.
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
