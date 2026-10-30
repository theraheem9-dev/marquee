# marquee
Personal film, TV and game tracker

## Setup
1. In a new Supabase project, run `schema.sql` in the SQL Editor. For an existing database, run the files in `migrations/` you haven't run yet (currently `001_import_names.sql`).
2. Put the project URL and publishable key in `config.js`.
3. Serve the folder as a static site (any host, or `python -m http.server`) and sign in by email link.
4. In Settings, paste your free TMDB and RAWG keys (kept in the browser only).

## Tests
`npm test` (Node 20+) runs the game-matching tests in `tests/`.
