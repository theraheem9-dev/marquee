# Marquee: notes for Claude

Personal film, TV and game tracker: static HTML/CSS/JS (no build step), Supabase for data and sign-in, TMDB and RAWG for catalogue data.

- `HOW-IT-WORKS.md` explains the app in plain English for the owner. Update it in the same change whenever the structure changes (a new file, table, page or data source).
- Phones (especially the iPhone home-screen app) cache `app.js` and `styles.css`. Bump the `?v=` on their tags in `index.html` with every change so the new version loads.
