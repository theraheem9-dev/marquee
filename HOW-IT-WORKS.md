# How Marquee works

A plain-English tour for steering the build without reading every line.

## What it does

Marquee is a private website for tracking the films, TV series and games you watch and play, a bit like Letterboxd plus a game log. For each title you can set a status (Wishlist, Watchlist/Backlog, Watching/Playing, Watched/Played, Dropped), give it a star rating, write a review, favourite it, log the dates you watched or finished it, tick off TV episodes, record game hours and trophies, make your own lists, and pin a "top four" per type. The Stats page totals it all up. The Calendar page shows release dates: "My releases" for your wishlist and the next episodes of shows you watch, and "All upcoming" for popular films, new series and games coming out, with yours highlighted. You can import your PlayStation and Steam play history from a CSV file.

Only you can see your data: you sign in with an emailed link, and the database only returns rows that belong to the signed-in user.

## The pieces

Think of it as three parties:

| Piece | What it is | Analogy |
|---|---|---|
| **The website** (this repo) | Plain HTML, CSS and JavaScript files. No build step: a web host serves the files as they are. | The shop front and the staff |
| **Supabase** | A hosted database plus sign-in service. Holds everything *you* enter. | The filing cabinet with a lock |
| **TMDB and RAWG** | Free public catalogues: TMDB for films and TV, RAWG for games. Supply titles, posters, genres, episode lists. | The reference library |

Your own records (statuses, ratings, hours) live only in Supabase. The posters, synopses and episode lists come from TMDB/RAWG each time you open a title. Each saved title stores just a few key facts (title, year, poster, genres) so your library loads without asking the catalogues.

## The files

| File | What's in it |
|---|---|
| `index.html` | The page skeleton: top bar, search box, navigation, and an empty area the app fills in. |
| `styles.css` | All the look and feel. Colours are set once at the top (film amber, TV teal, game violet). |
| `config.js` | The Supabase address and its *publishable* key. These are meant to be public; your data is protected by the sign-in and the database rules, not by hiding them. Never put a secret or "service_role" key here. |
| `app.js` | The whole app, in sections marked with `/* ---------- name ---------- */` headings (listed below). |
| `match.js` | How an imported game title is matched to a RAWG game and to games already in your library. Kept separate so it can be tested. *(Added by pull request #1.)* |
| `schema.sql`, `migrations/` | The database setup: tables, columns and the "owner only" rules. *(Added by pull request #1.)* |
| `tests/` | Automatic checks for the matching rules, run with `npm test`. *(Added by pull request #1.)* |

### Sections inside `app.js`

- **helpers**: small tools (formatting dates and hours, the pop-up "toast" messages).
- **TYPES**: the words used for each type, e.g. games say "Backlog/Playing/Played" where films say "Watchlist/Watching/Watched".
- **state**: what the app holds in memory once loaded (your library, diary, lists).
- **external APIs**: the calls to TMDB and RAWG.
- **data layer**: loading everything from Supabase at sign-in, and saving/removing titles.
- **router**: the part after `#` in the address (`#/library`, `#/item/game/rawg/123`) picks which page to draw.
- One section per page: **Home**, **Search**, **Item detail** (a title's own page), **Library**, **Calendar**, **Diary**, **Lists**, **Stats**, **Settings + import**.
- **modals**: the pop-up boxes (log a watch, add to list, pin to top four, change a game's match).
- **global events**: one listener that handles every button press, using each button's `data-act` name.
- **auth + boot**: the sign-in screen and start-up.

## How data flows

1. **Start-up.** The browser loads `index.html`, which loads `app.js`. The app connects to Supabase, checks whether you're signed in, and if not shows the email sign-in screen.
2. **Signed in.** The app downloads all your rows at once (titles, diary, lists, list entries, top fours) and keeps them in memory, so moving between pages is instant.
3. **Searching.** Typing in the top bar asks TMDB and RAWG directly from your browser, using the API keys you pasted in Settings. Those keys are stored only in that browser, so you paste them once per device.
4. **Changing something.** Setting a status, rating or hours saves that one change to Supabase straight away, then redraws the page. The first time you touch a title, it is added to your library.
5. **TV episodes** are saved one row per episode watched. Ticking the first episode sets the show to Watching; ticking every aired episode of an ended show sets it to Watched.
6. **Game import.** You upload a CSV (columns: platform, title, hours, last_played, first_played, play_count, trophies, status). Each row is matched to a game you already have, or else searched on RAWG. Hours are kept per platform, so PS5 and Steam rows for the same game add up rather than double-count. Approximate matches are listed so you can fix them with "Wrong game? Change match". With pull request #1, the game then remembers the imported name, so later imports land on your pick.
7. **Wishlist and calendar.** Wishlist is for things you want but haven't got: not out yet, or out but not bought. The + on a search result adds anything unreleased to Wishlist and anything already out to Watchlist/Backlog. Wishlisted titles stay there until you move them. The Calendar asks TMDB and RAWG for fresh dates each time you open it (films use the UK cinema date when TMDB has one) and saves any changed date back to the title.
8. **Backup.** Settings → Download backup saves everything as one JSON file.

### The database tables

| Table | One row per… |
|---|---|
| `items` | title in your library (status, rating, review, favourite, hours, platforms, release date…) |
| `diary` | logged watch or playthrough (date, rating, note, rewatch) |
| `episodes` | TV episode you've watched |
| `lists` / `list_items` | list you made / title in a list, with its position |
| `showcase` | "top four" slot per type |

## How to run it

1. **Database:** in Supabase's SQL Editor, run `schema.sql` once for a new project, or the files in `migrations/` for an existing one.
2. **Connect:** put the Supabase project URL and publishable key in `config.js`.
3. **Serve:** any static host works (GitHub Pages, Netlify, Cloudflare Pages). To try it on your own computer, run `python -m http.server` in the folder and open `http://localhost:8000`. Opening `index.html` by double-click won't work: the browser blocks the app's files when there's no server.
4. **Sign in** with your email link, then paste your free TMDB and RAWG keys in Settings.
5. **Tests:** `npm test` (needs Node 20 or later).

## Where to change common things

| You want to… | Look in |
|---|---|
| Change colours, fonts, spacing | Top of `styles.css` (the `--` values under `:root`) |
| Rename statuses ("Backlog", "Watched"…) | `TYPES` near the top of `app.js` |
| Change what the Home page shows | `renderHome` in `app.js` |
| Add or change a chart on Stats | `renderStats` in `app.js` |
| Change the import CSV columns or rules | `runImport` in `app.js`; matching rules in `match.js` |
| Add a field you track per title | Add a column to `items` (a new file in `migrations/`, plus `schema.sql`), then a box on the title page in `drawItem` and save it with `ensureRow({...})` |
| Change the sign-in screen | `renderAuth` in `app.js` |
| Point at a different database | `config.js` |

## Keep this file current

Whenever the structure changes (a new file, table, page or data source), update this guide in the same pull request.
