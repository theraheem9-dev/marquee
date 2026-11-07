// Marquee — personal film, TV and game tracker.
// Data: Supabase (row-level security, owner only). Metadata: TMDB (film/TV) and RAWG (games).
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { norm, findOwned, pickMatch, withName } from "./match.js";

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};
const fmtHours = (h) => (h == null || h === "" ? "" : `${(+h).toLocaleString("en-GB", { maximumFractionDigits: 1 })}h`);
const fmtDate = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";

let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (err ? " err" : ""); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), err ? 5000 : 2200);
}

const TYPES = {
  movie: { label: "Film", plural: "Films", status: { wishlist: "Wishlist", want: "Watchlist", progress: "Watching", finished: "Watched", dropped: "Dropped" } },
  tv: { label: "Series", plural: "TV", status: { wishlist: "Wishlist", want: "Watchlist", progress: "Watching", finished: "Watched", dropped: "Dropped" } },
  game: { label: "Game", plural: "Games", status: { wishlist: "Wishlist", want: "Backlog", progress: "Playing", finished: "Played", dropped: "Dropped" } },
};
const STATUS_ORDER = ["wishlist", "want", "progress", "finished", "dropped"];
const COMBINED = "All platforms";

/* ---------- state ---------- */
const S = {
  sb: null, user: null,
  items: new Map(),      // key `${type}:${source}:${ext}` -> row
  byId: new Map(),       // id -> row
  diary: [], lists: [], listItems: [], showcase: [], cols: [], colItems: [],
  homeType: store.get("m.homeType") || "all",
  lib: { type: store.get("m.libType") || "all", status: "all", fav: false, sort: "recent", plat: "all", col: "all" },
};
const CAL = { view: store.get("m.calView") || "mine", type: "all", mine: null, all: null };
const keyOf = (t, s, e) => `${t}:${s}:${e}`;
const putItem = (row) => { S.items.set(keyOf(row.media_type, row.source, row.ext_id), row); S.byId.set(row.id, row); };
const dropItem = (row) => { S.items.delete(keyOf(row.media_type, row.source, row.ext_id)); S.byId.delete(row.id); };

/* ---------- external APIs ---------- */
const cleanKey = (v) => (v || "").replace(/^\s*bearer\s+/i, "").replace(/[\s"'\u200B-\u200D\uFEFF]/g, "");
const keys = () => ({ tmdb: store.get("m.tmdb"), rawg: store.get("m.rawg") });
const TMDB_IMG = "https://image.tmdb.org/t/p/";
// gives up on a request that hangs, so the page shows an error instead of "Searching…" forever
const timeoutSignal = (ms) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
async function tmdb(path, params = {}) {
  const k = cleanKey(keys().tmdb); if (!k) throw new Error("NO_TMDB");
  const url = new URL("https://api.themoviedb.org/3" + path);
  const headers = { accept: "application/json" };
  if (k.startsWith("eyJ")) headers.Authorization = "Bearer " + k; else url.searchParams.set("api_key", k);
  url.searchParams.set("language", "en-GB");
  for (const [a, b] of Object.entries(params)) url.searchParams.set(a, b);
  const r = await fetch(url, { headers, signal: timeoutSignal(10000) });
  if (!r.ok) throw new Error(r.status === 401 ? "TMDB rejected your key. Check it in Settings." : `TMDB error ${r.status}`);
  return r.json();
}
async function rawg(path, params = {}) {
  const k = cleanKey(keys().rawg); if (!k) throw new Error("NO_RAWG");
  const url = new URL("https://api.rawg.io/api" + path);
  url.searchParams.set("key", k);
  for (const [a, b] of Object.entries(params)) url.searchParams.set(a, b);
  const r = await fetch(url, { signal: timeoutSignal(15000) });
  if (!r.ok) throw new Error(r.status === 401 ? "RAWG rejected your key. Check it in Settings." : `RAWG error ${r.status}`);
  return r.json();
}
const rawgImg = (u, w = 420) => (u ? u.replace("/media/", `/media/resize/${w}/-/`) : null);
// UK cinema date when TMDB has one, otherwise the worldwide date
function ukRelease(d) {
  const gb = d.release_dates?.results?.find((r) => r.iso_3166_1 === "GB");
  const ds = (gb?.release_dates || []).filter((x) => x.type === 2 || x.type === 3).map((x) => x.release_date.slice(0, 10)).sort();
  return ds[0] || d.release_date || null;
}
const isUpcoming = (m) => (m.release_date ? m.release_date > today() : !m.year);
const addStatus = (m) => (isUpcoming(m) ? "wishlist" : "want");
const yearOf = (d) => (d ? parseInt(String(d).slice(0, 4), 10) || null : null);

function metaFromTmdb(r, type, full = false) {
  const m = {
    media_type: type, source: "tmdb", ext_id: String(r.id),
    title: r.title || r.name || "Untitled",
    year: yearOf(r.release_date || r.first_air_date),
    poster: r.poster_path ? TMDB_IMG + "w342" + r.poster_path : null,
    release_date: (type === "movie" ? (full ? ukRelease(r) : r.release_date) : r.first_air_date) || null,
  };
  if (full) {
    m.genres = (r.genres || []).map((g) => g.name);
    m.runtime_min = type === "movie" ? r.runtime || null : (r.episode_run_time?.[0] || r.last_episode_to_air?.runtime || null);
  }
  return m;
}
function metaFromRawg(g, full = false) {
  const m = { media_type: "game", source: "rawg", ext_id: String(g.id), title: g.name, year: yearOf(g.released), poster: rawgImg(g.background_image), release_date: g.tba ? null : g.released || null };
  if (full || g.genres) m.genres = (g.genres || []).map((x) => x.name);
  return m;
}

// Games from IGDB, through the "games" Supabase function (it holds the Twitch keys).
// Throws "NO_IGDB" when the function or its keys aren't set up, so callers can fall back to RAWG.
const IGDB = { off: false };
async function igdb(body, ms = 12000) {
  if (IGDB.off) throw new Error("NO_IGDB");
  const call = S.sb.functions.invoke("games", { body });
  const timer = new Promise((_, no) => setTimeout(() => no(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms));
  const { data, error } = await Promise.race([call, timer]);
  if (error) {
    const b = await error.context?.json?.().catch(() => null);
    if (b?.error === "NO_KEYS" || error.context?.status === 404) { IGDB.off = true; throw new Error("NO_IGDB"); }
    throw new Error(b?.error || error.message);
  }
  return data;
}
const metaFromIgdb = (g) => ({ media_type: "game", source: "igdb", ext_id: g.id, title: g.title, year: g.year, poster: g.poster, release_date: g.release_date, genres: g.genres || [] });
// An IGDB result you already own under its older RAWG id: show your copy instead, so it isn't added twice.
function ownedGame(m) {
  const n = norm(m.title);
  for (const i of S.items.values()) {
    if (i.media_type !== "game" || i.source === "igdb" || norm(i.title) !== n) continue;
    if (!m.year || !i.year || Math.abs(m.year - i.year) <= 1) return i;
  }
  return null;
}

/* ---------- data layer ---------- */
async function fetchAll(table, order) {
  const out = []; const page = 1000;
  for (let from = 0; ; from += page) {
    let q = S.sb.from(table).select("*").range(from, from + page - 1);
    if (order) q = q.order(order, { ascending: false });
    const { data, error } = await q;
    if (error) throw error;
    out.push(...data);
    if (data.length < page) break;
  }
  return out;
}
async function loadEverything() {
  const [items, diary, lists, listItems, showcase] = await Promise.all([
    fetchAll("items", "updated_at"), fetchAll("diary", "logged_on"), fetchAll("lists", "created_at"), fetchAll("list_items"), fetchAll("showcase"),
  ]);
  S.items.clear(); S.byId.clear(); items.forEach(putItem);
  S.diary = diary; S.lists = lists; S.listItems = listItems; S.showcase = showcase;
  // collections arrived with migrations/003_collections.sql; the rest of the app works without them
  try {
    [S.cols, S.colItems] = await Promise.all([fetchAll("collections", "created_at"), fetchAll("collection_items")]);
    S.noCols = false;
  } catch (e) { console.warn("collections", e); S.cols = []; S.colItems = []; S.noCols = true; }
}
const META_FIELDS = ["media_type", "source", "ext_id", "title", "year", "poster", "genres", "runtime_min", "release_date"];
async function saveItem(meta, patch = {}) {
  const existing = S.items.get(keyOf(meta.media_type, meta.source, meta.ext_id));
  const fresh = {};
  for (const f of META_FIELDS) if (meta[f] !== undefined && meta[f] !== null) fresh[f] = meta[f];
  if (S.noRelease) { delete fresh.release_date; delete patch.release_date; }
  CAL.mine = null; // calendar recalculates after any change
  let res;
  if (existing) {
    const upd = { ...patch };
    // refresh metadata quietly when we have fuller data
    if (fresh.genres?.length && !existing.genres?.length) upd.genres = fresh.genres;
    if (fresh.runtime_min && !existing.runtime_min) upd.runtime_min = fresh.runtime_min;
    if (fresh.poster && !existing.poster) upd.poster = fresh.poster;
    if (fresh.release_date && fresh.release_date !== existing.release_date) upd.release_date = fresh.release_date;
    res = await S.sb.from("items").update(upd).eq("id", existing.id).select().single();
  } else {
    res = await S.sb.from("items").insert({ ...fresh, ...patch }).select().single();
  }
  if (res.error && /import_names/.test(res.error.message) && ("import_names" in patch)) {
    // database predates migrations/001_import_names.sql: save without the alias list
    if (!S.warnedAliases) { S.warnedAliases = true; toast("Run migrations/001_import_names.sql in Supabase so re-imports remember your matches", true); }
    const { import_names, ...rest } = patch;
    return saveItem(meta, rest);
  }
  if (res.error && /release_date|status_check/.test(res.error.message) && !S.noRelease) {
    // database predates migrations/002_wishlist.sql
    S.noRelease = true; toast("Run migrations/002_wishlist.sql in Supabase to turn on the wishlist and release dates", true);
    if (patch.status !== "wishlist") return saveItem(meta, patch);
  }
  if (res.error) { toast(res.error.message, true); throw res.error; }
  putItem(res.data);
  if (res.data.media_type === "game") queueCover(res.data);
  return res.data;
}

/* ---------- box art (IGDB, via the "covers" Supabase function) ---------- */
const hasBoxArt = (i) => /images\.igdb\.com/.test(i.poster || "");
const coverQ = { pending: new Map(), tried: new Set(), timer: null, off: false };
function queueCover(row) {
  if (coverQ.off || hasBoxArt(row) || coverQ.tried.has(row.id)) return;
  coverQ.pending.set(row.id, row);
  clearTimeout(coverQ.timer); coverQ.timer = setTimeout(flushCovers, 800);
}
async function flushCovers() {
  const batch = [...coverQ.pending.values()].slice(0, 10);
  if (!batch.length) return;
  batch.forEach((r) => { coverQ.pending.delete(r.id); coverQ.tried.add(r.id); });
  await fetchCovers(batch).catch(() => {});
  if (coverQ.pending.size) coverQ.timer = setTimeout(flushCovers, 300);
}
// Returns how many covers were found. Throws "NO_KEYS" if Twitch keys aren't set in Supabase yet.
async function fetchCovers(rows) {
  const { data, error } = await S.sb.functions.invoke("covers", { body: { games: rows.map((r) => ({ id: r.id, title: r.title, year: r.year })) } });
  if (error) {
    const body = await error.context?.json?.().catch(() => null);
    if (body?.error === "NO_KEYS" || error.context?.status === 404) { coverQ.off = true; throw new Error("NO_KEYS"); }
    throw new Error(body?.error || error.message);
  }
  let found = 0;
  for (const r of rows) {
    const url = data.covers?.[r.id];
    if (!url) continue;
    const { data: upd, error: e } = await S.sb.from("items").update({ poster: url }).eq("id", r.id).select().single();
    if (!e) { putItem(upd); found++; }
  }
  return found;
}
async function fetchAllCovers(btn) {
  const todo = allItems().filter((i) => i.media_type === "game" && !hasBoxArt(i));
  if (!todo.length) return toast("Every game already has box art");
  btn.disabled = true; let found = 0;
  try {
    for (let n = 0; n < todo.length; n += 10) {
      btn.textContent = `Working… ${Math.min(n + 10, todo.length)} of ${todo.length}`;
      found += await fetchCovers(todo.slice(n, n + 10));
      await new Promise((r) => setTimeout(r, 300));
    }
    toast(`Box art found for ${found} of ${todo.length} games`);
  } catch (e) {
    toast(e.message === "NO_KEYS" ? "Box art isn't set up yet: add your Twitch keys in Supabase first" : e.message, true);
  }
  btn.disabled = false; btn.textContent = "Get box art";
}
async function deleteItem(row) {
  const { error } = await S.sb.from("items").delete().eq("id", row.id);
  if (error) return toast(error.message, true);
  dropItem(row);
  S.diary = S.diary.filter((d) => d.item_id !== row.id);
  S.listItems = S.listItems.filter((l) => l.item_id !== row.id);
  S.showcase = S.showcase.filter((s) => s.item_id !== row.id);
  toast("Removed from your library");
}
const allItems = () => [...S.items.values()];

/* ---------- small components ---------- */
function starsText(v) {
  if (!v) return "";
  const full = Math.floor(v), half = v % 1 >= 0.5;
  return "★".repeat(full) + (half ? "½" : "");
}
// Games: show the whole image (box art is a different shape to the tile), with a blurred copy filling the gaps.
function posterImg(m, lazy = true) {
  if (!m.poster) return `<div class="fallback">${esc(m.title)}</div>`;
  const l = lazy ? ` loading="lazy"` : "";
  return m.media_type === "game" ? `<img class="bg" src="${esc(m.poster)}" alt="" aria-hidden="true"${l}><img class="fit" src="${esc(m.poster)}" alt=""${l}>` : `<img src="${esc(m.poster)}" alt=""${l}>`;
}
function itemHref(m) { return `#/item/${m.media_type}/${m.source}/${encodeURIComponent(m.ext_id)}`; }
function card(m, opts = {}) {
  const mine = S.items.get(keyOf(m.media_type, m.source, m.ext_id)) || (m.id ? m : null);
  const t = m.media_type;
  const img = posterImg(m);
  const badges = [];
  if (mine?.favourite) badges.push(`<span class="badge fav" title="Favourite">♥</span>`);
  if (t === "game" && mine?.hours) badges.push(`<span class="badge num">${fmtHours(mine.hours)}</span>`);
  const qLabel = `Add to ${TYPES[t].status[addStatus(m)]}`;
  const quick = opts.quick && !mine?.status
    ? `<button class="quick" data-act="quick-add" data-key="${esc(keyOf(t, m.source, m.ext_id))}" title="${qLabel}" aria-label="${qLabel}">+</button>` : "";
  const status = mine?.status ? `<span>${esc(TYPES[t].status[mine.status])}</span>` : "";
  return `<div class="card" data-type="${t}">
    <a href="${itemHref(m)}" class="poster" aria-label="${esc(m.title)}">${img}<span class="type-strip"></span><span class="badges">${badges.join("")}</span></a>
    ${quick}
    <a href="${itemHref(m)}" class="card-title" style="text-decoration:none">${esc(m.title)}</a>
    <div class="card-meta">${m.year ? `<span>${m.year}</span>` : ""}${mine?.rating ? `<span class="stars-sm">${starsText(mine.rating)}</span>` : ""}${opts.showStatus ? status : ""}</div>
  </div>`;
}
function typeTabs(current, act, withAll = true) {
  const opts = withAll ? [["all", "All"]] : [];
  opts.push(["movie", "Films"], ["tv", "TV"], ["game", "Games"]);
  return `<div class="tabs" role="tablist">${opts.map(([v, l]) => `<button class="chip ${current === v ? "on" : ""}" data-type="${v}" data-act="${act}" data-v="${v}" role="tab" aria-selected="${current === v}">${v !== "all" ? '<span class="dot"></span>' : ""}${l}</button>`).join("")}</div>`;
}
function needKeys(which) {
  return `<div class="empty"><strong>Add your ${which} key to search.</strong><span>Go to Settings and paste your free API key. It stays on this device.</span><a class="btn" href="#/settings">Open settings</a></div>`;
}
function modal(html, onMount) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-back" data-act="modal-close-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const m = root.querySelector(".modal");
  onMount?.(m);
  m.querySelector("input,textarea,select,button")?.focus();
  return m;
}
const closeModal = () => ($("#modal-root").innerHTML = "");

/* ---------- router ---------- */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, qs] = h.split("?");
  return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), q: new URLSearchParams(qs || "") };
}
async function route() {
  if (!S.user) return;
  const { parts, q } = parseHash();
  const name = parts[0] || "home";
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.nav === name || a.dataset.nav === name + "s"));
  window.scrollTo(0, 0);
  try {
    if (name === "home") renderHome();
    else if (name === "search") await renderSearch(q.get("q") || "", q.get("type") || "all");
    else if (name === "item") await renderItem(parts[1], parts[2], parts[3]);
    else if (name === "library") renderLibrary();
    else if (name === "diary") renderDiary();
    else if (name === "lists") renderLists();
    else if (name === "calendar") await renderCalendar();
    else if (name === "list") renderList(parts[1]);
    else if (name === "collections") renderCollections();
    else if (name === "collection") await renderCollection(parts[1]);
    else if (name === "stats") renderStats();
    else if (name === "settings") renderSettings();
    else renderHome();
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty"><strong>Something went wrong.</strong><span>${esc(e.message)}</span><a class="btn" href="#/">Back home</a></div>`;
  }
}

/* ---------- Home ---------- */
function renderHome() {
  const t = S.homeType;
  const pool = allItems().filter((i) => t === "all" || i.media_type === t);
  const byUpd = (a, b) => (b.updated_at || "").localeCompare(a.updated_at || "");
  const progress = pool.filter((i) => i.status === "progress").sort(byUpd);
  const want = pool.filter((i) => i.status === "want").sort(byUpd);
  const wish = pool.filter((i) => i.status === "wishlist").sort((a, b) => (a.release_date || "9999").localeCompare(b.release_date || "9999"));
  const favs = pool.filter((i) => i.favourite).sort(byUpd);
  const recent = S.diary.filter((d) => S.byId.has(d.item_id) && (t === "all" || S.byId.get(d.item_id).media_type === t)).slice(0, 14).map((d) => S.byId.get(d.item_id));
  const seen = new Set(); const recentU = recent.filter((i) => !seen.has(i.id) && seen.add(i.id));
  const showcase = ["movie", "tv", "game"].filter((m) => t === "all" || m === t).map((m) => {
    const slots = [1, 2, 3, 4].map((s) => S.showcase.find((x) => x.media_type === m && x.slot === s)).map((x) => x && S.byId.get(x.item_id));
    return { m, slots };
  }).filter((x) => x.slots.some(Boolean));

  const row = (title, items, link, emptyMsg) => `<section class="section"><div class="section-head"><h2>${title}</h2>${link ? `<a href="${link}">See all</a>` : ""}</div>
    ${items.length ? `<div class="row">${items.slice(0, 20).map((i) => card(i)).join("")}</div>` : `<div class="empty">${emptyMsg}</div>`}</section>`;
  const empty = S.items.size === 0;
  view.innerHTML = `
    <div class="page-head"><div><h1>${empty ? "Welcome to Marquee" : "Tonight's line-up"}</h1><p class="sub">${empty ? "Search for a film, series or game to start your library." : `${S.items.size.toLocaleString("en-GB")} titles tracked`}</p></div>${typeTabs(t, "home-type")}</div>
    ${empty ? `<div class="empty"><strong>Your library is empty.</strong><span>Use the search bar above, or import your PlayStation and Steam history from Settings.</span><div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn primary" href="#/search">Search titles</a><a class="btn" href="#/settings">Import games</a></div></div>` : ""}
    ${showcase.map(({ m, slots }) => `<section class="section"><div class="section-head"><h2>Top four ${TYPES[m].plural.toLowerCase()}</h2></div><div class="grid" style="grid-template-columns:repeat(4,minmax(0,1fr));max-width:620px">${slots.map((i) => i ? card(i) : `<div class="poster" style="opacity:.4"></div>`).join("")}</div></section>`).join("")}
    ${empty ? "" : row(t === "game" ? "Playing now" : t === "all" ? "In progress" : "Watching now", progress, "#/library?status=progress", "Nothing in progress. Mark something as Watching or Playing.")}
    ${empty || !wish.length ? "" : row("Wishlist", wish, "#/calendar", "")}
    ${empty ? "" : row(t === "game" ? "Backlog" : t === "all" ? "Watchlist and backlog" : "Watchlist", want, "#/library?status=want", "Nothing queued up yet. Tap + on any search result to add it.")}
    ${empty ? "" : row("Favourites", favs, null, "Tap the heart on any title to make it a favourite.")}
    ${empty ? "" : row("Recently logged", recentU, "#/diary", "Log a watch or a finished game and it will show here.")}
  `;
}

/* ---------- Search ---------- */
// Films/TV (TMDB) and games (RAWG) are fetched side by side and each block is shown as soon as
// it arrives, so a slow RAWG never holds up TMDB results. Answers are kept for 10 minutes, so
// going back to a search or switching type tabs is instant.
const searchCache = new Map();
const resultCache = new Map(); // "src|type|query" -> { at, list }
const RESULT_TTL = 10 * 60 * 1000;
async function cachedSearch(src, type, q, fetcher) {
  const key = `${src}|${type}|${q.trim().toLowerCase()}`;
  const hit = resultCache.get(key);
  if (hit && Date.now() - hit.at < RESULT_TTL) return hit.list;
  const list = await fetcher();
  resultCache.set(key, { at: Date.now(), list });
  return list;
}
function searchBlock(list) {
  list.forEach((m) => searchCache.set(keyOf(m.media_type, m.source, m.ext_id), m));
  return ["movie", "tv", "game"].map((t) => [t, list.filter((m) => m.media_type === t)]).filter(([, l]) => l.length)
    .map(([t, l]) => `<section class="section" style="margin-bottom:26px"><div class="section-head"><h2>${TYPES[t].plural}</h2><span class="link">${l.length} results</span></div><div class="grid">${l.map((m) => card(m, { quick: true, showStatus: true })).join("")}</div></section>`).join("");
}
async function renderSearch(q, type) {
  $("#top-q").value = q;
  view.innerHTML = `<div class="page-head"><div><h1>${q ? `Results for “${esc(q)}”` : "Search"}</h1><p class="sub">Films and TV from TMDB, games from IGDB.</p></div>${typeTabs(type, "search-type")}</div><div id="results">${q ? "" : `<p class="loading">Type a title in the search bar.</p>`}</div>`;
  if (!q) return;
  const k = keys(); const wantFilm = type === "all" || type === "movie" || type === "tv"; const wantGame = type === "all" || type === "game";
  const out = $("#results");
  const slots = [];
  const addSlot = (label, run) => {
    const el = document.createElement("div");
    el.innerHTML = `<p class="loading">Searching ${label}…</p>`;
    out.appendChild(el);
    const p = run().then((v) => {
      if (parseHash().q.get("q") !== q) return 0; // user moved on
      if (v === "NO_TMDB" || v === "NO_RAWG") { el.innerHTML = needKeys(v.slice(3)); return 0; }
      el.innerHTML = searchBlock(v);
      return v.length;
    }, (e) => {
      if (parseHash().q.get("q") !== q) return 0;
      const msg = e.name === "TimeoutError" ? `${label} is taking too long to answer. Try again in a moment.` : e.message;
      el.innerHTML = `<div class="empty"><strong>${label} search failed.</strong><span>${esc(msg)}</span></div>`;
      return -1;
    });
    slots.push(p);
  };
  if (wantFilm) addSlot("films and TV", () => k.tmdb
    ? cachedSearch("tmdb", type, q, () => tmdb("/search/multi", { query: q, include_adult: "false" }).then((d) => d.results.filter((r) => (r.media_type === "movie" || r.media_type === "tv") && (type === "all" || r.media_type === type)).map((r) => metaFromTmdb(r, r.media_type))))
    : Promise.resolve("NO_TMDB"));
  const rawgSearch = () => k.rawg
    ? cachedSearch("rawg", "game", q, () => rawg("/games", { search: q, page_size: "12", search_precise: "true" }).then((d) => d.results.map((g) => metaFromRawg(g))))
    : Promise.resolve("NO_RAWG");
  // IGDB first; RAWG only if the IGDB function isn't set up
  if (wantGame) addSlot("games", () => cachedSearch("igdb", "game", q, () => igdb({ search: q }).then((d) => d.results.map((g) => ownedGame(g) || metaFromIgdb(g))))
    .catch((e) => (e.message === "NO_IGDB" ? rawgSearch() : Promise.reject(e))));
  const counts = await Promise.all(slots);
  if (parseHash().q.get("q") !== q) return;
  if (counts.every((n) => n === 0) && !out.querySelector(".empty")) out.innerHTML = `<div class="empty"><strong>No matches.</strong><span>Try a shorter title or check the spelling.</span></div>`;
}

/* ---------- Item detail ---------- */
let current = null; // { meta, details, seasons, episodes:Set }
async function renderItem(type, source, ext) {
  if (!TYPES[type]) throw new Error("Unknown title type.");
  view.innerHTML = `<p class="loading">Loading…</p>`;
  const mine = S.items.get(keyOf(type, source, ext));
  let meta = mine ? { ...mine } : searchCache.get(keyOf(type, source, ext)) || { media_type: type, source, ext_id: ext, title: "" };
  let d = null, extra = {};
  try {
    if (source === "tmdb") {
      d = await tmdb(`/${type}/${ext}`, { append_to_response: type === "movie" ? "credits,release_dates" : "credits" });
      meta = { ...meta, ...metaFromTmdb(d, type, true) };
      const crew = d.credits?.crew || [], cast = (d.credits?.cast || []).slice(0, 5).map((c) => c.name);
      extra = {
        overview: d.overview, backdrop: d.backdrop_path ? TMDB_IMG + "w1280" + d.backdrop_path : null,
        facts: type === "movie"
          ? [d.runtime ? `${d.runtime} min` : "", crew.filter((c) => c.job === "Director").map((c) => c.name).join(", ") && `Dir. ${crew.filter((c) => c.job === "Director").map((c) => c.name).join(", ")}`, (meta.genres || []).join(" · ")]
          : [`${d.number_of_seasons} season${d.number_of_seasons === 1 ? "" : "s"}`, `${d.number_of_episodes} episodes`, d.status, (d.networks || []).map((n) => n.name).slice(0, 2).join(", "), (meta.genres || []).join(" · ")],
        cast,
      };
    } else if (source === "igdb") {
      d = (await igdb({ id: ext })).game;
      meta = { ...meta, ...metaFromIgdb(d) };
      extra = { overview: d.overview, backdrop: d.backdrop, facts: [d.developers.slice(0, 2).join(", "), (meta.genres || []).join(" · ")], platforms: d.platforms };
    } else if (source === "rawg") {
      d = await rawg(`/games/${ext}`);
      meta = { ...meta, ...metaFromRawg(d, true) };
      extra = {
        overview: d.description_raw, backdrop: d.background_image_additional || d.background_image,
        facts: [(d.developers || []).map((x) => x.name).slice(0, 2).join(", "), (meta.genres || []).join(" · "), d.playtime ? `Avg ${d.playtime}h to play` : ""],
        platforms: (d.platforms || []).map((p) => p.platform.name),
      };
    }
  } catch (e) {
    if (!mine) {
      view.innerHTML = e.message === "NO_TMDB" ? needKeys("TMDB") : e.message === "NO_RAWG" ? needKeys("RAWG") : e.message === "NO_IGDB" ? `<div class="empty"><strong>IGDB isn't set up.</strong><span>Add your Twitch keys in Supabase (Edge Functions → Secrets).</span></div>` : `<div class="empty"><strong>Couldn't load this title.</strong><span>${esc(e.message)}</span></div>`;
      return;
    }
    extra = { overview: "", facts: [] }; // show what we have saved
  }
  current = { meta, d, extra, episodes: new Set() };
  const row = S.items.get(keyOf(type, source, ext));
  // quietly backfill genres/runtime for titles added from search results
  if (row && d && ((!row.genres?.length && meta.genres?.length) || (!row.runtime_min && meta.runtime_min) || (!row.poster && meta.poster) || (meta.release_date && meta.release_date !== row.release_date))) {
    saveItem(meta, {}).catch(() => {});
  }
  if (row && type === "tv") {
    const { data } = await S.sb.from("episodes").select("season,episode").eq("item_id", row.id);
    (data || []).forEach((e) => current.episodes.add(`${e.season}:${e.episode}`));
  }
  drawItem();
}
function statusSeg(t, st) {
  return `<div class="seg" role="group" aria-label="Status">${STATUS_ORDER.map((s) => `<button data-act="set-status" data-v="${s}" class="${st === s ? "on" : ""}" aria-pressed="${st === s}">${TYPES[t].status[s]}</button>`).join("")}</div>`;
}
function starsWidget(v) {
  let h = `<div class="stars" role="group" aria-label="Rating">`;
  for (let i = 1; i <= 5; i++) {
    const cls = v >= i ? "full" : v >= i - 0.5 ? "half" : "";
    h += `<span class="star ${cls}">★<button data-act="rate" data-v="${i - 0.5}" aria-label="${i - 0.5} stars"></button><button data-act="rate" data-v="${i}" aria-label="${i} stars"></button></span>`;
  }
  return h + `<span class="rating-val">${v ? (+v).toFixed(1) : ""}</span></div>`;
}
function playStats(row) {
  if (!row) return "";
  const byPlat = Object.entries(row.hours_by_platform || {}).filter(([p, h]) => p !== COMBINED && +h > 0).sort((a, b) => +b[1] - +a[1]);
  const total = row.hours != null && row.hours !== "" ? +row.hours : byPlat.reduce((n, [, h]) => n + +h, 0);
  const split = byPlat.length > 1 ? byPlat.map(([p, h]) => `${esc(p)} ${fmtHours(h)}`).join(" · ") : (row.platforms || []).map(esc).join(" · ");
  const bits = [row.trophies ? `Trophies: ${esc(row.trophies)}` : "", row.last_played ? `Last played ${fmtDate(row.last_played)}` : ""].filter(Boolean);
  if (!total && !split && !bits.length) return "";
  return `<div class="play-stats">
    ${total ? `<div class="ps-hours num">${fmtHours(total)}<span>played</span></div>` : ""}
    ${split ? `<div class="ps-line">${split}</div>` : ""}
    ${bits.length ? `<div class="ps-line">${bits.join(" · ")}</div>` : ""}
  </div>`;
}
function relLine(meta, d, st) {
  const nx = meta.media_type === "tv" && d?.next_episode_to_air;
  if (nx?.air_date) return `<div class="rel-line">Next episode ${fmtDate(nx.air_date)} <span>S${nx.season_number} E${nx.episode_number}</span></div>`;
  if (meta.release_date && meta.release_date > today()) return `<div class="rel-line">Out ${fmtDate(meta.release_date)}</div>`;
  if (!meta.release_date && st === "wishlist") return `<div class="rel-line">Release date TBA</div>`;
  return "";
}
function drawItem() {
  const { meta, extra, d } = current;
  const t = meta.media_type;
  const row = S.items.get(keyOf(t, meta.source, meta.ext_id));
  const st = row?.status;
  const facts = (extra.facts || []).filter(Boolean);
  const hist = row ? S.diary.filter((x) => x.item_id === row.id) : [];
  const inCols = S.noCols ? [] : colsWith(meta);
  const franchise = t === "movie" && d?.belongs_to_collection && !S.noCols ? d.belongs_to_collection : null;
  const franCol = franchise && S.cols.find((c) => c.kind === "tmdb_collection" && c.ref === String(franchise.id));
  const inLists = row ? S.listItems.filter((l) => l.item_id === row.id).map((l) => S.lists.find((x) => x.id === l.list_id)).filter(Boolean) : [];
  const gamePanel = t === "game" ? `
    <div class="panel"><h2>Playtime</h2>
      <div class="form-row">
        <div class="field"><label for="f-hours">Hours played</label><input id="f-hours" class="input num" type="number" min="0" step="0.5" value="${esc(row?.hours ?? "")}"></div>
        <div class="field"><label for="f-trophies">Trophies / achievements</label><input id="f-trophies" class="input" placeholder="e.g. Platinum, 42/51" value="${esc(row?.trophies ?? "")}"></div>
      </div>
      ${row && Object.keys(row.hours_by_platform || {}).length ? `<p class="hint">Imported: ${Object.entries(row.hours_by_platform).map(([p, h]) => `${esc(p)} ${fmtHours(h)}`).join(" · ")}</p>` : ""}
      <div class="form-row">
        <div class="field"><label for="f-start">Started</label><input id="f-start" class="input" type="date" value="${esc(row?.started_on ?? "")}"></div>
        <div class="field"><label for="f-finish">Finished</label><input id="f-finish" class="input" type="date" value="${esc(row?.finished_on ?? "")}"></div>
      </div>
      <div class="field"><label>Platforms you played on</label><div class="plat-chips">${[...new Set([...(extra.platforms || []), ...(row?.platforms || [])])].map((p, i) => `<label><input type="checkbox" id="pl-${i}" value="${esc(p)}" ${row?.platforms?.includes(p) ? "checked" : ""}><span>${esc(p)}</span></label>`).join("") || `<span class="hint">No platform data.</span>`}</div></div>
      <div><button class="btn primary" data-act="save-game">Save playtime</button></div>
    </div>` : "";
  view.innerHTML = `
  <div class="detail" data-type="${t}">
    ${extra.backdrop ? `<div class="backdrop" aria-hidden="true"><img src="${esc(t === "game" ? rawgImg(extra.backdrop, 1280) : extra.backdrop)}" alt=""></div>` : ""}
    <div class="hero">
      <div class="poster">${posterImg(meta, false)}<span class="type-strip"></span></div>
      <div class="hero-text">
        <span class="type-label">${TYPES[t].label}</span>
        <h1>${esc(meta.title)}${meta.year ? `<span class="yr num">${meta.year}</span>` : ""}</h1>
        ${facts.length ? `<div class="facts">${facts.map((f) => `<span>${esc(f)}</span>`).join("")}</div>` : ""}
        ${extra.cast?.length ? `<div class="facts"><span>With ${esc(extra.cast.join(", "))}</span></div>` : ""}
        ${relLine(meta, d, st)}
        ${t === "game" ? playStats(row) : ""}
        ${extra.overview ? `<p class="overview">${esc(extra.overview.length > 700 ? extra.overview.slice(0, 700).replace(/\s+\S*$/, "") + "…" : extra.overview)}</p>` : ""}
      </div>
    </div>

    <section class="actions">
      ${statusSeg(t, st)}
      <div class="action-line">
        <button class="fav-btn ${row?.favourite ? "on" : ""}" data-act="toggle-fav" aria-pressed="${!!row?.favourite}"><span class="heart">♥</span>${row?.favourite ? "Favourite" : "Add to favourites"}</button>
        ${starsWidget(row?.rating)}
        <button class="btn" data-act="log">${t === "game" ? "Log playthrough" : "Log watch"}</button>
        <button class="btn" data-act="add-to-list">Add to list</button>
        ${S.noCols ? "" : `<button class="btn" data-act="add-to-col">Add to collection</button>`}
        ${row ? `<button class="btn ghost" data-act="showcase">Pin to top four</button>` : ""}
      </div>
      ${inCols.length ? `<p class="hint">In collections: ${inCols.map((c) => `<a class="link" href="#/collection/${c.id}">${esc(c.name)}</a>`).join(", ")}</p>` : ""}
      ${franchise && !franCol ? `<p class="hint">Part of ${esc(franchise.name)}. <button class="link-btn" data-act="col-follow-tmdb" data-ref="${franchise.id}" data-name="${esc(franchise.name)}" data-poster="${esc(franchise.poster_path || "")}">Group it in Collections</button></p>` : ""}
      ${inLists.length ? `<p class="hint">In lists: ${inLists.map((l) => `<a class="link" href="#/list/${l.id}">${esc(l.name)}</a>`).join(", ")}</p>` : ""}
    </section>

    <div class="two-col">
      <div style="display:grid;gap:20px;min-width:0">
        ${t === "tv" && d?.seasons ? `<section class="section"><div class="section-head"><h2>Episodes</h2><span class="link num" id="ep-total"></span></div><div id="seasons" style="display:grid;gap:8px"></div></section>` : ""}
        <div class="panel"><h2>Your review</h2>
          <textarea id="f-review" class="input" placeholder="What did you think?">${esc(row?.review ?? "")}</textarea>
          <div><button class="btn primary" data-act="save-review">Save review</button></div>
        </div>
        ${gamePanel}
      </div>
      <div style="display:grid;gap:20px;min-width:0">
        <div class="panel"><h2>Diary</h2>
          ${hist.length ? hist.map((h) => `<div class="action-line" style="justify-content:space-between"><span>${fmtDate(h.logged_on)} ${h.rewatch ? '<span class="tag">Rewatch</span>' : ""}</span><span class="stars-sm">${starsText(h.rating)}</span></div>${h.note ? `<p class="hint">${esc(h.note)}</p>` : ""}`).join("") : `<p class="hint">No entries yet. Use “${t === "game" ? "Log playthrough" : "Log watch"}” to record when you ${t === "game" ? "finished it" : "watched it"}.</p>`}
        </div>
        ${row ? `<div class="panel"><h2>Manage</h2>
          ${t === "game" ? `<button class="btn" data-act="rematch">Wrong game? Change match</button>` : ""}
          <button class="btn danger" data-act="remove-item">Remove from library</button>
          <p class="hint">Added ${fmtDate((row.created_at || "").slice(0, 10))}${row.source === "manual" ? " · not linked to the game database" : ""}</p>
          ${t === "game" && row.import_names?.length ? `<p class="hint">Imports as: ${row.import_names.map(esc).join(", ")}</p>` : ""}</div>` : ""}
      </div>
    </div>
  </div>`;
  if (t === "tv" && d?.seasons) drawSeasons();
}
function drawSeasons() {
  const { d, episodes } = current;
  const seasons = d.seasons.filter((s) => s.season_number > 0 || d.seasons.length === 1);
  const total = seasons.reduce((a, s) => a + (s.episode_count || 0), 0);
  const watched = [...episodes].filter((k) => +k.split(":")[0] > 0).length;
  $("#ep-total").textContent = `${watched}/${total} watched`;
  $("#seasons").innerHTML = seasons.map((s) => {
    const w = [...episodes].filter((k) => +k.split(":")[0] === s.season_number).length;
    const pct = s.episode_count ? Math.min(100, (w / s.episode_count) * 100) : 0;
    return `<details class="season" data-season="${s.season_number}"><summary><span class="season-name">${esc(s.name)}</span><span class="num link">${w}/${s.episode_count || 0}</span><span class="progress"><i style="width:${pct}%"></i></span></summary><div class="eps"><p class="loading" style="padding:8px">Loading episodes…</p></div></details>`;
  }).join("");
  $("#seasons").querySelectorAll("details").forEach((el) => el.addEventListener("toggle", () => el.open && loadSeason(el), { once: false }));
}
const seasonCache = new Map();
async function loadSeason(el) {
  const n = +el.dataset.season; const { meta, episodes } = current;
  const ck = meta.ext_id + ":" + n;
  try {
    const s = seasonCache.get(ck) || await tmdb(`/tv/${meta.ext_id}/season/${n}`);
    seasonCache.set(ck, s);
    const now = today();
    el.querySelector(".eps").innerHTML = `<div class="season-tools"><button class="btn" data-act="season-all" data-season="${n}">Mark season watched</button><button class="btn ghost" data-act="season-none" data-season="${n}">Clear season</button></div>` +
      s.episodes.map((e) => `<label class="ep ${e.air_date && e.air_date > now ? "future" : ""}"><input type="checkbox" data-act="ep" data-season="${n}" data-ep="${e.episode_number}" ${episodes.has(`${n}:${e.episode_number}`) ? "checked" : ""}><span class="ep-n">E${e.episode_number}</span><span class="ep-t">${esc(e.name)}</span><span class="ep-d">${e.air_date ? fmtDate(e.air_date) : "TBA"}</span></label>`).join("");
  } catch (e) { el.querySelector(".eps").innerHTML = `<p class="hint" style="padding:8px">${esc(e.message)}</p>`; }
}
async function ensureRow(patch = {}) {
  return saveItem(current.meta, patch);
}
async function setEpisodes(season, eps, on) {
  let row = S.items.get(keyOf("tv", current.meta.source, current.meta.ext_id));
  if (!row) row = await ensureRow({ status: "progress" });
  if (on) {
    const rows = eps.map((e) => ({ item_id: row.id, season, episode: e, watched_on: today() }));
    const { error } = await S.sb.from("episodes").upsert(rows, { onConflict: "user_id,item_id,season,episode", ignoreDuplicates: true });
    if (error) return toast(error.message, true);
    eps.forEach((e) => current.episodes.add(`${season}:${e}`));
  } else {
    const { error } = await S.sb.from("episodes").delete().eq("item_id", row.id).eq("season", season).in("episode", eps);
    if (error) return toast(error.message, true);
    eps.forEach((e) => current.episodes.delete(`${season}:${e}`));
  }
  // automatic status: started -> Watching, everything aired watched -> Watched
  const d = current.d; const total = d.seasons.filter((s) => s.season_number > 0).reduce((a, s) => a + s.episode_count, 0);
  const watched = [...current.episodes].filter((k) => +k.split(":")[0] > 0).length;
  let status = row.status;
  if (watched > 0 && (!status || status === "want")) status = "progress";
  if (total && watched >= total && d.status !== "Returning Series" && status === "progress") status = "finished";
  if (status !== row.status) { await saveItem(current.meta, { status }); toast(`Marked as ${TYPES.tv.status[status]}`); }
  // refresh counts without collapsing open seasons
  const open = [...document.querySelectorAll("details.season[open]")].map((x) => x.dataset.season);
  const seg = document.querySelector(".seg"); if (seg) seg.outerHTML = statusSeg("tv", S.items.get(keyOf("tv", current.meta.source, current.meta.ext_id))?.status);
  drawSeasons();
  open.forEach((n) => { const el = document.querySelector(`details.season[data-season="${n}"]`); if (el) el.open = true; });
}

/* ---------- Library ---------- */
function renderLibrary() {
  const { q } = parseHash();
  if (q.get("status")) { S.lib.status = q.get("status"); history.replaceState(null, "", "#/library"); }
  const L = S.lib;
  const plats = L.type === "game" || L.type === "all" ? [...new Set(allItems().flatMap((i) => i.platforms || []))].sort() : [];
  if (!plats.includes(L.plat)) L.plat = "all";
  let list = allItems().filter((i) => (L.type === "all" || i.media_type === L.type) && (L.status === "all" || i.status === L.status) && (!L.fav || i.favourite) && (L.plat === "all" || (i.platforms || []).includes(L.plat)));
  if (L.col !== "all" && !colOf(L.col)) L.col = "all";
  if (L.col !== "all") { const ks = memberKeys(L.col); list = list.filter((i) => ks.has(keyOf(i.media_type, i.source, i.ext_id))); }
  const sorters = {
    recent: (a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""),
    title: (a, b) => a.title.localeCompare(b.title),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    hours: (a, b) => (b.hours || 0) - (a.hours || 0),
    year: (a, b) => (b.year || 0) - (a.year || 0),
  };
  list.sort(sorters[L.sort] || sorters.recent);
  const statusLabels = L.type === "game" ? TYPES.game.status : L.type === "all" ? { wishlist: "Wishlist", want: "Watchlist / backlog", progress: "In progress", finished: "Finished", dropped: "Dropped" } : TYPES.movie.status;
  view.innerHTML = `
    <div class="page-head"><div><h1>Library</h1><p class="sub num">${list.length.toLocaleString("en-GB")} titles</p></div>${typeTabs(L.type, "lib-type")}</div>
    <div class="action-line">
      <div class="tabs">${[["all", "Any status"], ...STATUS_ORDER.map((s) => [s, statusLabels[s]])].map(([v, l]) => `<button class="chip ${L.status === v ? "on" : ""}" data-act="lib-status" data-v="${v}">${l}</button>`).join("")}
        <button class="chip ${L.fav ? "on" : ""}" data-act="lib-fav">♥ Favourites</button></div>
      ${plats.length ? `<div class="field" style="margin-left:auto"><label for="lib-plat" class="eyebrow">Platform</label><select id="lib-plat" class="input"><option value="all">All platforms</option>${plats.map((p) => `<option value="${esc(p)}" ${L.plat === p ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></div>` : ""}
      ${S.cols.length ? `<div class="field" style="${plats.length ? "" : "margin-left:auto"}"><label for="lib-col" class="eyebrow">Collection</label><select id="lib-col" class="input"><option value="all">Any collection</option>${S.cols.map((c) => `<option value="${c.id}" ${L.col === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>` : ""}
      <div class="field" style="${plats.length || S.cols.length ? "" : "margin-left:auto"}"><label for="lib-sort" class="eyebrow">Sort</label><select id="lib-sort" class="input">${[["recent", "Recently updated"], ["title", "Title A–Z"], ["rating", "Your rating"], ["year", "Release year"], ["hours", "Hours played"]].map(([v, l]) => `<option value="${v}" ${L.sort === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    </div>
    ${list.length ? `<div class="grid">${list.map((i) => card(i, { showStatus: true })).join("")}</div>` : `<div class="empty"><strong>Nothing matches these filters.</strong><span>Try another status or type, or search for something new.</span></div>`}`;
  $("#lib-sort").addEventListener("change", (e) => { L.sort = e.target.value; renderLibrary(); });
  $("#lib-plat")?.addEventListener("change", (e) => { L.plat = e.target.value; renderLibrary(); });
  $("#lib-col")?.addEventListener("change", (e) => { L.col = e.target.value; renderLibrary(); });
}

/* ---------- Calendar ---------- */
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
async function inPool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const x = list[i++]; try { await fn(x); } catch (e) { console.warn(e); } } }));
}
// Your releases: everything on your wishlist, plus the next episode of shows you're watching or queued.
async function loadMine() {
  const k = keys(); const ev = [];
  const seen = new Set();
  const targets = allItems().filter((i) => (i.status === "wishlist" || (i.media_type === "tv" && (i.status === "progress" || i.status === "want"))) && !seen.has(i.id) && seen.add(i.id));
  await inPool(targets, 6, async (i) => {
    let date = i.release_date || null, ep = "";
    try {
      if (i.source === "tmdb" && k.tmdb) {
        const d = await tmdb(`/${i.media_type}/${i.ext_id}`, i.media_type === "movie" ? { append_to_response: "release_dates" } : {});
        if (i.media_type === "movie") date = ukRelease(d);
        else {
          const nx = d.next_episode_to_air;
          if (nx?.air_date) { date = nx.air_date; ep = `S${nx.season_number} E${nx.episode_number}${nx.name && !/^Episode \d+$/i.test(nx.name) ? " · " + nx.name : ""}`; }
          else if (i.status === "wishlist") date = d.first_air_date || null;
          else return; // watching, nothing scheduled
        }
      } else if (i.source === "igdb") {
        date = (await igdb({ id: i.ext_id })).game.release_date;
      } else if (i.source === "rawg" && k.rawg) {
        const g = await rawg(`/games/${i.ext_id}`); date = g.tba ? null : g.released || null;
      } else if (i.status !== "wishlist") return;
    } catch { if (i.status !== "wishlist") return; }
    if (i.media_type !== "tv" && date && date !== i.release_date && !S.noRelease) saveItem(i, { release_date: date }).catch(() => {});
    ev.push({ m: i, date, ep });
  });
  return ev;
}
// Everything coming up: popular films and new series over the next four months, games over the next year.
async function loadAll() {
  const k = keys(); const from = today(); const ev = []; const errs = [];
  const add = (m, date) => { if (m.poster && date && date >= from) { searchCache.set(keyOf(m.media_type, m.source, m.ext_id), m); ev.push({ m, date, ep: "" }); } };
  const jobs = [];
  if (k.tmdb) {
    jobs.push(Promise.all([1, 2, 3].map((page) => tmdb("/discover/movie", { "primary_release_date.gte": from, "primary_release_date.lte": addDays(120), sort_by: "popularity.desc", include_adult: "false", page })))
      .then((ps) => ps.forEach((p) => p.results.forEach((r) => add(metaFromTmdb(r, "movie"), r.release_date)))));
    jobs.push(Promise.all([1, 2].map((page) => tmdb("/discover/tv", { "first_air_date.gte": from, "first_air_date.lte": addDays(120), sort_by: "popularity.desc", include_adult: "false", page })))
      .then((ps) => ps.forEach((p) => p.results.forEach((r) => add(metaFromTmdb(r, "tv"), r.first_air_date)))));
  } else errs.push("TMDB");
  if (k.rawg) {
    jobs.push(rawg("/games", { dates: `${from},${addDays(365)}`, ordering: "-added", page_size: "40" })
      .then((d) => d.results.forEach((g) => add(metaFromRawg(g), g.tba ? null : g.released))));
  } else errs.push("RAWG");
  const res = await Promise.allSettled(jobs);
  res.filter((r) => r.status === "rejected").forEach((r) => errs.push(r.reason.message));
  return { ev, errs };
}
function calRow(e) {
  const m = e.m; const t = m.media_type;
  const mine = S.items.get(keyOf(t, m.source, m.ext_id));
  const dt = e.date ? new Date(e.date + "T00:00:00") : null;
  const status = mine?.status ? `<span class="tag">${esc(TYPES[t].status[mine.status])}</span>` : "";
  const released = mine?.status === "wishlist" && e.date && e.date <= today();
  const action = released ? `<button class="btn" data-act="cal-move" data-id="${mine.id}">Move to ${TYPES[t].status.want}</button>`
    : !mine?.status ? `<button class="icon-btn" data-act="cal-wish" data-key="${esc(keyOf(t, m.source, m.ext_id))}" aria-label="Add to wishlist" title="Add to wishlist">+</button>` : "";
  return `<div class="entry ${mine?.status ? "mine" : ""}" data-type="${t}">
    <div class="day">${dt ? `${dt.getDate()}<small>${dt.toLocaleDateString("en-GB", { weekday: "short" })}</small>` : `<small>TBA</small>`}</div>
    <a class="mini" href="${itemHref(m)}">${m.poster ? `<img src="${esc(m.poster)}" alt="" loading="lazy">` : ""}</a>
    <div class="entry-main"><a href="${itemHref(m)}">${esc(m.title)}</a> <span class="type-label" style="font-size:10px">${TYPES[t].label}</span> ${status}${e.ep ? `<p>${esc(e.ep)}</p>` : released ? `<p>Out ${fmtDate(e.date)}. Keep it wishlisted until you get it.</p>` : ""}</div>
    <div>${action}</div>
  </div>`;
}
function calMonths(list) {
  const months = new Map();
  list.forEach((e) => { const k = e.date.slice(0, 7); if (!months.has(k)) months.set(k, []); months.get(k).push(e); });
  return [...months].map(([k, es]) => `<section class="month"><h2>${new Date(k + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</h2>${es.map(calRow).join("")}</section>`).join("");
}
async function renderCalendar(force = false) {
  const C = CAL;
  const head = `<div class="page-head"><div><h1>Calendar</h1><p class="sub">${C.view === "mine" ? "Your wishlist and the next episodes of shows you watch." : "Big films and new series for the next four months, games for the next year. Yours are highlighted."}</p></div>${typeTabs(C.type, "cal-type")}</div>
    <div class="action-line"><div class="tabs"><button class="chip ${C.view === "mine" ? "on" : ""}" data-act="cal-view" data-v="mine">My releases</button><button class="chip ${C.view === "all" ? "on" : ""}" data-act="cal-view" data-v="all">All upcoming</button></div><button class="btn ghost" data-act="cal-refresh" style="margin-left:auto">Refresh</button></div>`;
  if (force) { C.mine = null; C.all = null; }
  const need = !C.mine || (C.view === "all" && !C.all);
  if (need) {
    view.innerHTML = head + `<p class="loading">Checking release dates…</p>`;
    const v = C.view;
    if (!C.mine) C.mine = await loadMine();
    if (v === "all" && !C.all) C.all = await loadAll();
    if (parseHash().parts[0] !== "calendar" || C.view !== v) return;
  }
  const byType = (e) => C.type === "all" || e.m.media_type === C.type;
  const sort = (a, b) => a.date.localeCompare(b.date) || a.m.title.localeCompare(b.m.title);
  const now = today();
  let body = "";
  if (C.view === "mine") {
    const ev = C.mine.filter(byType);
    const out = ev.filter((e) => e.date && e.date <= now && e.m.status === "wishlist").sort(sort);
    const up = ev.filter((e) => e.date && e.date > now || (e.date === now && e.m.status !== "wishlist")).sort(sort);
    const tba = ev.filter((e) => !e.date).sort((a, b) => a.m.title.localeCompare(b.m.title));
    body = (out.length ? `<section class="month"><h2>Out now, still on your wishlist</h2>${out.map(calRow).join("")}</section>` : "")
      + calMonths(up)
      + (tba.length ? `<section class="month"><h2>Date to be announced</h2>${tba.map(calRow).join("")}</section>` : "");
    if (!ev.length) body = `<div class="empty"><strong>Nothing on your calendar yet.</strong><span>Add upcoming films, series and games to your Wishlist (the + on a search result does this for anything not out yet), or browse All upcoming.</span><button class="btn" data-act="cal-view" data-v="all">Browse all upcoming</button></div>`;
  } else {
    const seen = new Set(); const merged = [];
    [...C.mine.filter((e) => e.date && e.date >= now), ...C.all.ev].forEach((e) => { const k = keyOf(e.m.media_type, e.m.source, e.m.ext_id); if (!seen.has(k)) { seen.add(k); merged.push(e); } });
    const ev = merged.filter(byType).sort(sort);
    body = (C.all.errs.length ? `<div class="empty"><strong>Some sources didn't load.</strong><span>${esc(C.all.errs.map((x) => x === "TMDB" || x === "RAWG" ? `${x} key missing (add it in Settings)` : x).join(" · "))}</span></div>` : "")
      + (ev.length ? calMonths(ev) : `<div class="empty"><strong>No upcoming releases found.</strong></div>`);
  }
  view.innerHTML = head + `<div style="display:grid;gap:18px">${body}</div>`;
}

/* ---------- Diary ---------- */
function renderDiary() {
  const entries = S.diary.filter((d) => S.byId.has(d.item_id)).sort((a, b) => b.logged_on.localeCompare(a.logged_on) || (b.created_at || "").localeCompare(a.created_at || ""));
  const months = new Map();
  entries.forEach((e) => { const k = e.logged_on.slice(0, 7); if (!months.has(k)) months.set(k, []); months.get(k).push(e); });
  view.innerHTML = `<div class="page-head"><div><h1>Diary</h1><p class="sub num">${entries.length} entries</p></div></div>
    ${entries.length ? [...months].map(([k, es]) => `<section class="month"><h2>${new Date(k + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</h2>
      ${es.map((e) => { const i = S.byId.get(e.item_id); const dt = new Date(e.logged_on + "T00:00:00"); return `<div class="entry" data-type="${i.media_type}">
        <div class="day">${dt.getDate()}<small>${dt.toLocaleDateString("en-GB", { weekday: "short" })}</small></div>
        <a class="mini" href="${itemHref(i)}">${i.poster ? `<img src="${esc(i.poster)}" alt="" loading="lazy">` : ""}</a>
        <div class="entry-main"><a href="${itemHref(i)}">${esc(i.title)}</a> <span class="type-label" style="font-size:10px">${TYPES[i.media_type].label}</span>${e.rewatch ? ' <span class="tag">Rewatch</span>' : ""}${e.note ? `<p>${esc(e.note)}</p>` : ""}</div>
        <div style="display:flex;gap:8px;align-items:center"><span class="stars-sm">${starsText(e.rating)}</span><button class="icon-btn" data-act="del-diary" data-id="${e.id}" aria-label="Delete entry">×</button></div>
      </div>`; }).join("")}</section>`).join("")
    : `<div class="empty"><strong>No diary entries yet.</strong><span>Open any title and tap “Log watch” or “Log playthrough” to record the date, rating and a note.</span></div>`}`;
}

/* ---------- Lists ---------- */
function renderLists() {
  view.innerHTML = `<div class="page-head"><div><h1>Lists</h1><p class="sub">Your own collections, in any order.</p></div><button class="btn primary" data-act="new-list">New list</button></div>
    ${S.lists.length ? `<div class="list-cards">${S.lists.map((l) => {
      const its = S.listItems.filter((x) => x.list_id === l.id).sort((a, b) => a.position - b.position).map((x) => S.byId.get(x.item_id)).filter(Boolean);
      return `<a class="list-card" href="#/list/${l.id}"><div class="stack">${its.slice(0, 5).map((i) => `<div>${i.poster ? `<img src="${esc(i.poster)}" alt="" loading="lazy">` : ""}</div>`).join("") || `<div></div>`}</div><div><h2 style="font-size:17px">${esc(l.name)}</h2><p class="hint">${its.length} titles${l.description ? " · " + esc(l.description) : ""}</p></div></a>`;
    }).join("")}</div>` : `<div class="empty"><strong>No lists yet.</strong><span>Make one like “Best horror” or “Games to play with mates”, then add titles from their pages.</span><button class="btn" data-act="new-list">Create your first list</button></div>`}`;
}
function renderList(id) {
  const l = S.lists.find((x) => x.id === id);
  if (!l) { view.innerHTML = `<div class="empty"><strong>List not found.</strong><a class="btn" href="#/lists">All lists</a></div>`; return; }
  const its = S.listItems.filter((x) => x.list_id === id).sort((a, b) => a.position - b.position);
  view.innerHTML = `<div class="page-head"><div><a class="link" href="#/lists">← Lists</a><h1>${esc(l.name)}</h1>${l.description ? `<p class="sub">${esc(l.description)}</p>` : ""}</div><div style="display:flex;gap:8px"><button class="btn" data-act="edit-list" data-id="${id}">Edit</button><button class="btn danger" data-act="del-list" data-id="${id}">Delete</button></div></div>
    ${its.length ? `<div>${its.map((x, n) => { const i = S.byId.get(x.item_id); if (!i) return ""; return `<div class="list-row" data-type="${i.media_type}"><span class="rank num">${n + 1}</span><a class="mini entry" style="display:block;padding:0;border:0" href="${itemHref(i)}"><div class="mini">${i.poster ? `<img src="${esc(i.poster)}" alt="">` : ""}</div></a><div class="entry-main"><a href="${itemHref(i)}" style="text-decoration:none;font-weight:600">${esc(i.title)}</a><p class="hint">${TYPES[i.media_type].label}${i.year ? " · " + i.year : ""} ${i.rating ? `<span class="stars-sm">${starsText(i.rating)}</span>` : ""}</p></div><div style="display:flex;gap:4px"><button class="icon-btn" data-act="list-move" data-list="${id}" data-item="${i.id}" data-dir="-1" aria-label="Move up" ${n === 0 ? "disabled" : ""}>↑</button><button class="icon-btn" data-act="list-move" data-list="${id}" data-item="${i.id}" data-dir="1" aria-label="Move down" ${n === its.length - 1 ? "disabled" : ""}>↓</button><button class="icon-btn" data-act="list-remove" data-list="${id}" data-item="${i.id}" aria-label="Remove from list">×</button></div></div>`; }).join("")}</div>`
    : `<div class="empty"><strong>This list is empty.</strong><span>Open any title and tap “Add to list”.</span></div>`}`;
}

/* ---------- Collections ---------- */
// Franchise groupings (MCU, Nolan's Dark Knight trilogy…). Titles are stored by catalogue id,
// so a collection can hold things you haven't added to your library yet.
const PRESETS = [
  { name: "Marvel Cinematic Universe", kind: "tmdb_keyword", q: "marvel cinematic universe", pick: /\(mcu\)/i },
  { name: "The Dark Knight Trilogy", kind: "tmdb_collection", q: "The Dark Knight" },
  { name: "Star Wars", kind: "tmdb_collection", q: "Star Wars" },
  { name: "Harry Potter", kind: "tmdb_collection", q: "Harry Potter" },
  { name: "The Lord of the Rings", kind: "tmdb_collection", q: "The Lord of the Rings" },
  { name: "The Hobbit", kind: "tmdb_collection", q: "The Hobbit" },
  { name: "John Wick", kind: "tmdb_collection", q: "John Wick" },
  { name: "Mission: Impossible", kind: "tmdb_collection", q: "Mission: Impossible" },
  { name: "Fast & Furious", kind: "tmdb_collection", q: "The Fast and the Furious" },
  { name: "James Bond", kind: "tmdb_collection", q: "James Bond" },
  { name: "Jurassic Park", kind: "tmdb_collection", q: "Jurassic Park" },
  { name: "The Matrix", kind: "tmdb_collection", q: "The Matrix" },
  { name: "The Godfather", kind: "tmdb_collection", q: "The Godfather" },
  { name: "Back to the Future", kind: "tmdb_collection", q: "Back to the Future" },
  { name: "Indiana Jones", kind: "tmdb_collection", q: "Indiana Jones" },
  { name: "Rocky", kind: "tmdb_collection", q: "Rocky" },
  { name: "Toy Story", kind: "tmdb_collection", q: "Toy Story" },
  { name: "The Hunger Games", kind: "tmdb_collection", q: "The Hunger Games" },
];
const COLS_MISSING = "Collections need a database update: run migrations/003_collections.sql in Supabase";
const colErr = (e) => (/collection/.test(e?.message || "") && /exist|find|schema cache/i.test(e.message) ? COLS_MISSING : e?.message || String(e));
const COL = { filter: "all", edit: false };
const colOf = (id) => S.cols.find((c) => c.id === id);
const relKey = (m) => m.release_date || (m.year ? `${m.year}-12-31` : "9999");
const byRelease = (a, b) => relKey(a).localeCompare(relKey(b)) || a.title.localeCompare(b.title);
const colRows = (cid) => S.colItems.filter((x) => x.collection_id === cid && !x.hidden).sort(byRelease);
const isDone = (m) => S.items.get(keyOf(m.media_type, m.source, m.ext_id))?.status === "finished";
const isOut = (m) => (m.release_date ? m.release_date <= today() : !!m.year && m.year < new Date().getFullYear());
const sameMember = (a, b) => a.collection_id === b.collection_id && a.media_type === b.media_type && a.source === b.source && a.ext_id === b.ext_id;
function mergeColItems(rows) {
  for (const r of rows) { const i = S.colItems.findIndex((x) => sameMember(x, r)); if (i >= 0) S.colItems[i] = r; else S.colItems.push(r); }
}
function colProgress(cid) {
  const rows = colRows(cid), out = rows.filter(isOut);
  return { total: rows.length, out: out.length, done: out.filter(isDone).length, upcoming: rows.length - out.length };
}
const colsWith = (m) => S.cols.filter((c) => S.colItems.some((x) => x.collection_id === c.id && !x.hidden && x.media_type === m.media_type && x.source === m.source && x.ext_id === String(m.ext_id)));
const memberKeys = (cid) => new Set(colRows(cid).map((x) => keyOf(x.media_type, x.source, x.ext_id)));

async function tmdbMembers(c) {
  if (c.kind === "tmdb_collection") {
    const d = await tmdb(`/collection/${c.ref}`);
    return { poster: d.poster_path ? TMDB_IMG + "w342" + d.poster_path : null, list: (d.parts || []).map((p) => metaFromTmdb(p, "movie")) };
  }
  const list = [];
  for (const type of ["movie", "tv"]) {
    for (let page = 1; page <= 10; page++) {
      const d = await tmdb(`/discover/${type}`, { with_keywords: c.ref, include_adult: "false", sort_by: "popularity.desc", page: String(page) });
      list.push(...(d.results || []).map((r) => metaFromTmdb(r, type)));
      if (page >= (d.total_pages || 1)) break;
    }
  }
  return { poster: null, list };
}
// Pull the latest titles from TMDB. Anything you removed stays removed (hidden isn't touched).
async function syncCollection(c) {
  const { poster, list } = await tmdbMembers(c);
  const rows = list.map((m) => ({ collection_id: c.id, media_type: m.media_type, source: m.source, ext_id: m.ext_id, title: m.title, year: m.year, poster: m.poster, release_date: m.release_date, auto: true }));
  if (rows.length) {
    const { data, error } = await S.sb.from("collection_items").upsert(rows, { onConflict: "collection_id,media_type,source,ext_id" }).select();
    if (error) throw new Error(colErr(error));
    mergeColItems(data);
  }
  const { data } = await S.sb.from("collections").update({ synced_at: new Date().toISOString(), poster: c.poster || poster }).eq("id", c.id).select().single();
  if (data) Object.assign(c, data);
  return rows.length;
}
async function followCollection({ name, kind, ref = null, poster = null }) {
  const existing = ref != null && S.cols.find((c) => c.kind === kind && c.ref === String(ref));
  if (existing) { location.hash = `#/collection/${existing.id}`; return existing; }
  const { data, error } = await S.sb.from("collections").insert({ name, kind, ref: ref == null ? null : String(ref), poster }).select().single();
  if (error) { toast(colErr(error), true); throw error; }
  S.cols.unshift(data);
  if (kind !== "custom") {
    toast(`Fetching ${name}…`);
    try { const n = await syncCollection(data); toast(`${name}: ${n} titles`); } catch (e) { toast(e.message === "NO_TMDB" ? "Add your TMDB key in Settings first" : e.message, true); }
  }
  location.hash = `#/collection/${data.id}`;
  return data;
}
async function followPreset(p) {
  if (p.kind === "tmdb_keyword") {
    const d = await tmdb("/search/keyword", { query: p.q });
    const r = d.results || [];
    const k = (p.pick && r.find((x) => p.pick.test(x.name))) || r.find((x) => x.name.toLowerCase() === p.q.toLowerCase()) || r[0];
    if (!k) return toast("TMDB couldn't find that franchise", true);
    return followCollection({ name: p.name, kind: "tmdb_keyword", ref: k.id });
  }
  const d = await tmdb("/search/collection", { query: p.q });
  const c = (d.results || [])[0];
  if (!c) return toast("TMDB couldn't find that franchise", true);
  return followCollection({ name: p.name, kind: "tmdb_collection", ref: c.id, poster: c.poster_path ? TMDB_IMG + "w342" + c.poster_path : null });
}
async function addToCollection(c, m) {
  const row = { collection_id: c.id, media_type: m.media_type, source: m.source, ext_id: String(m.ext_id), title: m.title, year: m.year ?? null, poster: m.poster ?? null, release_date: m.release_date ?? null, hidden: false };
  const { data, error } = await S.sb.from("collection_items").upsert(row, { onConflict: "collection_id,media_type,source,ext_id" }).select().single();
  if (error) { toast(colErr(error), true); throw error; }
  mergeColItems([data]); toast(`Added to ${c.name}`);
}

function colCard(c) {
  const rows = colRows(c.id), p = colProgress(c.id);
  const pics = rows.filter((r) => r.poster).slice(0, 5);
  return `<a class="list-card" href="#/collection/${c.id}"><div class="stack">${pics.map((i) => `<div><img src="${esc(i.poster)}" alt="" loading="lazy"></div>`).join("") || `<div></div>`}</div>
    <div><h2 style="font-size:17px">${esc(c.name)}</h2><p class="hint num">${p.done} of ${p.out} done${p.upcoming ? ` · ${p.upcoming} to come` : ""}</p><span class="progress col-prog"><i style="width:${p.out ? (p.done / p.out) * 100 : 0}%"></i></span></div></a>`;
}
function renderCollections() {
  const head = `<div class="page-head"><div><h1>Collections</h1><p class="sub">Franchises and series grouped together, in release order.</p></div>`;
  if (S.noCols) { view.innerHTML = `${head}</div><div class="empty"><strong>One more step.</strong><span>Run <b>migrations/003_collections.sql</b> in Supabase (SQL Editor → paste → Run), then reload this page.</span></div>`; return; }
  const followed = new Set(S.cols.map((c) => c.name));
  const sugg = PRESETS.filter((p) => !followed.has(p.name));
  view.innerHTML = `${head}<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="col-find">Find a franchise</button><button class="btn primary" data-act="col-new">New collection</button></div></div>
    ${S.cols.length ? `<div class="list-cards">${S.cols.map(colCard).join("")}</div>` : `<div class="empty"><strong>No collections yet.</strong><span>Tap a franchise below, search TMDB with “Find a franchise”, or make your own mix (films, series and games) with “New collection”.</span></div>`}
    ${sugg.length ? `<section class="section" style="margin-top:28px"><div class="section-head"><h2>Popular franchises</h2><span class="link">Tap to add</span></div><div class="tabs">${sugg.map((p) => `<button class="chip" data-act="col-preset" data-v="${esc(p.name)}">+ ${esc(p.name)}</button>`).join("")}</div></section>` : ""}`;
}
async function renderCollection(id) {
  const c = colOf(id);
  if (!c) { view.innerHTML = `<div class="empty"><strong>Collection not found.</strong><a class="btn" href="#/collections">All collections</a></div>`; return; }
  COL.edit = false; COL.filter = "all";
  drawCollection(c);
  // check TMDB for new entries about once a week
  if (c.kind !== "custom" && keys().tmdb && (!c.synced_at || Date.now() - Date.parse(c.synced_at) > 7 * 864e5)) {
    try { await syncCollection(c); if (parseHash().parts[1] === id) drawCollection(c); } catch (e) { console.warn(e); }
  }
}
function drawCollection(c) {
  const all = colRows(c.id), p = colProgress(c.id);
  all.forEach((m) => { const k = keyOf(m.media_type, m.source, m.ext_id); if (!searchCache.has(k)) searchCache.set(k, m); });
  const types = [...new Set(all.map((r) => r.media_type))];
  if (TYPES[COL.filter] && !types.includes(COL.filter)) COL.filter = "all";
  let rows = all;
  if (COL.filter === "todo") rows = rows.filter((r) => !isDone(r));
  else if (TYPES[COL.filter]) rows = rows.filter((r) => r.media_type === COL.filter);
  const hidden = S.colItems.filter((x) => x.collection_id === c.id && x.hidden).length;
  const filters = [["all", "All"], ["todo", "Still to do"], ...(types.length > 1 ? ["movie", "tv", "game"].filter((t) => types.includes(t)).map((t) => [t, TYPES[t].plural]) : [])];
  const src = c.kind === "tmdb_collection" ? "From TMDB" : c.kind === "tmdb_keyword" ? "Films and series from TMDB" : "Your own mix";
  view.innerHTML = `<div class="page-head"><div><a class="link" href="#/collections">← Collections</a><h1>${esc(c.name)}</h1><p class="sub num">${p.done} of ${p.out} done${p.upcoming ? ` · ${p.upcoming} still to come` : ""} · ${src}</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${c.kind !== "custom" ? `<button class="btn" data-act="col-sync" data-id="${c.id}">Refresh</button>` : ""}<button class="btn" data-act="col-add" data-id="${c.id}">Add title</button><button class="btn ${COL.edit ? "primary" : ""}" data-act="col-edit-mode" data-id="${c.id}">${COL.edit ? "Done" : "Edit"}</button></div></div>
    <span class="progress col-prog big"><i style="width:${p.out ? (p.done / p.out) * 100 : 0}%"></i></span>
    ${c.description ? `<p class="hint">${esc(c.description)}</p>` : ""}
    ${COL.edit ? `<div class="action-line"><button class="btn" data-act="col-rename" data-id="${c.id}">Rename</button>${hidden ? `<button class="btn" data-act="col-unhide" data-id="${c.id}">Bring back ${hidden} removed</button>` : ""}<button class="btn danger" data-act="col-del" data-id="${c.id}">Delete collection</button><span class="hint">Tap × to take a title out of this collection.</span></div>` : ""}
    <div class="action-line"><div class="tabs">${filters.map(([v, l]) => `<button class="chip ${COL.filter === v ? "on" : ""}" ${TYPES[v] ? `data-type="${v}"` : ""} data-act="col-filter" data-id="${c.id}" data-v="${v}">${l}</button>`).join("")}</div></div>
    ${rows.length ? `<div class="grid">${rows.map((m) => colTile(m, c)).join("")}</div>`
      : `<div class="empty"><strong>${all.length ? "Nothing left here." : "This collection is empty."}</strong><span>${all.length ? "You've done everything in this filter." : "Use “Add title” to put films, series or games in it."}</span></div>`}`;
}
function colTile(m, c) {
  const soon = isOut(m) ? "" : `<span class="tag soon">${m.release_date ? fmtDate(m.release_date) : "TBA"}</span>`;
  const x = COL.edit ? `<button class="icon-btn col-x" data-act="col-hide" data-id="${c.id}" data-key="${esc(keyOf(m.media_type, m.source, m.ext_id))}" aria-label="Remove ${esc(m.title)} from this collection">×</button>` : "";
  return `<div class="col-tile${isDone(m) ? " done" : ""}">${card(m, { quick: !COL.edit, showStatus: true })}${soon}${x}</div>`;
}

/* ---------- Stats ---------- */
function renderStats() {
  const items = allItems();
  const by = (t) => items.filter((i) => i.media_type === t);
  const films = by("movie"), shows = by("tv"), games = by("game");
  const filmsWatched = films.filter((i) => i.status === "finished");
  const filmHours = filmsWatched.reduce((a, i) => a + (i.runtime_min || 0), 0) / 60;
  const gameHours = games.reduce((a, i) => a + (+i.hours || 0), 0);
  const kpi = (t, v, l) => `<div class="kpi" data-type="${t}"><b class="num">${v}</b><span>${l}</span></div>`;
  // finished per year by type (diary first, then finished_on, then updated_at for finished items without a log)
  const yearMap = {};
  const finishedYear = (i) => {
    const logs = S.diary.filter((d) => d.item_id === i.id);
    if (logs.length) return logs.map((d) => d.logged_on.slice(0, 4));
    if (i.finished_on) return [i.finished_on.slice(0, 4)];
    return [];
  };
  items.forEach((i) => finishedYear(i).forEach((y) => { yearMap[y] ??= { movie: 0, tv: 0, game: 0 }; yearMap[y][i.media_type]++; }));
  const years = Object.keys(yearMap).sort().slice(-12);
  const ymax = Math.max(1, ...years.map((y) => yearMap[y].movie + yearMap[y].tv + yearMap[y].game));
  // genres
  const gc = {}; items.filter((i) => i.status === "finished" || i.status === "progress").forEach((i) => (i.genres || []).forEach((g) => (gc[g] = (gc[g] || 0) + 1)));
  const genres = Object.entries(gc).sort((a, b) => b[1] - a[1]).slice(0, 8); const gmax = Math.max(1, ...genres.map((g) => g[1]));
  // ratings histogram
  const hist = Array(10).fill(0); items.forEach((i) => i.rating && hist[Math.round(i.rating * 2) - 1]++); const hmax = Math.max(1, ...hist);
  const topGames = games.filter((g) => g.hours).sort((a, b) => b.hours - a.hours).slice(0, 10); const tgmax = Math.max(1, ...topGames.map((g) => +g.hours));
  // platform hours
  const ph = {}; games.forEach((g) => Object.entries(g.hours_by_platform || {}).forEach(([p, h]) => { if (p !== COMBINED) ph[p] = (ph[p] || 0) + +h; }));
  const plats = Object.entries(ph).sort((a, b) => b[1] - a[1]); const pmax = Math.max(1, ...plats.map((p) => p[1]));
  const statusRow = (t, list) => STATUS_ORDER.map((s) => `${TYPES[t].status[s]} <b class="num">${list.filter((i) => i.status === s).length}</b>`).join(" · ");

  view.innerHTML = `<div class="page-head"><div><h1>Stats</h1><p class="sub">Everything you've watched and played, counted.</p></div></div>
  <div class="kpis">
    ${kpi("movie", filmsWatched.length.toLocaleString("en-GB"), `films watched · ${Math.round(filmHours).toLocaleString("en-GB")}h`)}
    ${kpi("tv", shows.filter((i) => i.status === "finished").length, `series finished · ${shows.filter((i) => i.status === "progress").length} in progress`)}
    ${kpi("game", Math.round(gameHours).toLocaleString("en-GB") + "h", `played across ${games.filter((g) => g.hours).length} games`)}
    ${kpi("", S.diary.length.toLocaleString("en-GB"), "diary entries")}
  </div>
  <div class="panel"><h2>By status</h2>
    <p class="hint" data-type="movie"><span class="type-label">Films</span> ${statusRow("movie", films)}</p>
    <p class="hint" data-type="tv"><span class="type-label">TV</span> ${statusRow("tv", shows)}</p>
    <p class="hint" data-type="game"><span class="type-label">Games</span> ${statusRow("game", games)}</p>
  </div>
  <div class="two-col">
    <div class="panel"><h2>Finished per year</h2>
      ${years.length ? `<div class="years">${years.map((y) => { const v = yearMap[y]; const tot = v.movie + v.tv + v.game; return `<div class="yc" title="${y}: ${v.movie} films, ${v.tv} series, ${v.game} games"><small>${tot}</small><div class="ystack" style="height:${(tot / ymax) * 100}px">${["movie", "tv", "game"].map((t) => v[t] ? `<i data-type="${t}" style="height:${(v[t] / tot) * 100}%;background:var(--accent)"></i>` : "").join("")}</div><small>${y.slice(2)}</small></div>`; }).join("")}</div>
      <div class="legend"><span data-type="movie"><i></i>Films</span><span data-type="tv"><i></i>Series</span><span data-type="game"><i></i>Games</span></div>` : `<p class="hint">Log watches and playthroughs to build this chart.</p>`}
    </div>
    <div class="panel"><h2>Your ratings</h2>
      ${hist.some(Boolean) ? `<div class="hist">${hist.map((v, i) => `<div style="height:${(v / hmax) * 100}%" title="${(i + 1) / 2} stars: ${v}"></div>`).join("")}</div><div class="hist-axis">${hist.map((_, i) => `<span>${i === 0 ? "½" : (i + 1) % 2 === 0 ? (i + 1) / 2 + "★" : ""}</span>`).join("")}</div>
      <p class="hint">Average <span class="num">${(items.filter((i) => i.rating).reduce((a, i) => a + +i.rating, 0) / Math.max(1, items.filter((i) => i.rating).length)).toFixed(2)}</span> across ${items.filter((i) => i.rating).length} ratings</p>` : `<p class="hint">Rate titles to see your distribution.</p>`}
    </div>
  </div>
  <div class="two-col">
    <div class="panel" data-type="game"><h2>Most played games</h2>
      ${topGames.length ? `<div class="bars">${topGames.map((g) => `<div class="bar"><a class="lbl" href="${itemHref(g)}" style="text-decoration:none">${esc(g.title)}</a><span class="track"><i style="width:${(g.hours / tgmax) * 100}%"></i></span><span class="val">${fmtHours(g.hours)}</span></div>`).join("")}</div>` : `<p class="hint">Import your PlayStation or Steam history, or add hours on a game's page.</p>`}
    </div>
    <div class="panel"><h2>Top genres</h2>
      ${genres.length ? `<div class="bars">${genres.map(([g, n]) => `<div class="bar"><span class="lbl">${esc(g)}</span><span class="track"><i style="width:${(n / gmax) * 100}%;background:var(--tv)"></i></span><span class="val">${n}</span></div>`).join("")}</div>` : `<p class="hint">Genres fill in as you open and track titles.</p>`}
      ${plats.length ? `<h2 style="margin-top:8px">Hours by platform</h2><div class="bars" data-type="game">${plats.map(([p, h]) => `<div class="bar"><span class="lbl">${esc(p)}</span><span class="track"><i style="width:${(h / pmax) * 100}%"></i></span><span class="val">${fmtHours(Math.round(h))}</span></div>`).join("")}</div>` : ""}
    </div>
  </div>`;
}

/* ---------- Settings + import ---------- */
function renderSettings() {
  const k = keys();
  view.innerHTML = `<div class="page-head"><div><h1>Settings</h1><p class="sub">Signed in as ${esc(S.user.email)}</p></div><button class="btn" data-act="sign-out">Sign out</button></div>
  <div class="two-col">
    <div style="display:grid;gap:20px;min-width:0">
      <div class="panel"><h2>API keys</h2>
        <p class="hint">Stored only in this browser. Paste them once on each device you use.</p>
        <div class="field"><label for="k-tmdb">TMDB key (API key or Read Access Token)</label><input id="k-tmdb" class="input" type="password" autocomplete="off" value="${esc(k.tmdb)}"></div>
        <div class="field"><label for="k-rawg">RAWG key</label><input id="k-rawg" class="input" type="password" autocomplete="off" value="${esc(k.rawg)}"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-act="save-keys">Save keys</button><button class="btn" data-act="test-keys">Test keys</button></div>
      </div>
      <div class="panel"><h2>Import games</h2>
        <p class="hint">Upload the CSV from the PlayStation or Steam export scripts (columns: platform, title, hours, last_played, first_played, play_count, trophies, status). Each game is matched to RAWG for artwork and genres. Re-importing updates hours rather than duplicating.</p>
        <div class="field"><label for="imp-file">CSV file</label><input id="imp-file" class="input" type="file" accept=".csv,text/csv"></div>
        <label style="display:flex;gap:8px;align-items:center;font-size:14px"><input type="checkbox" id="imp-skip" checked> Skip games under 1 hour</label>
        <div><button class="btn primary" data-act="run-import">Import</button></div>
        <div id="imp-progress" hidden style="display:grid;gap:8px"><div class="bar-progress"><i id="imp-bar"></i></div><div class="import-log" id="imp-log"></div></div>
      </div>
    </div>
    <div style="display:grid;gap:20px;min-width:0">
      <div class="panel"><h2>Sign-in password</h2>
        <p class="hint">Set a password to sign in on your phone's home-screen app, where the email link can't reach.</p>
        <div class="field"><label for="pw-new">New password (8+ characters)</label><input id="pw-new" class="input" type="password" autocomplete="new-password" minlength="8"></div>
        <div><button class="btn primary" data-act="set-password">Save password</button></div>
      </div>
      <div class="panel"><h2>Game box art</h2>
        <p class="hint">Swap game pictures for the official cover art from IGDB. New games get it automatically. Games with no match keep their current picture.</p>
        <div><button class="btn" data-act="get-covers">Get box art</button></div>
      </div>
      <div class="panel"><h2>Back up your data</h2>
        <p class="hint">Download everything (library, diary, episodes, lists) as one JSON file.</p>
        <div><button class="btn" data-act="export">Download backup</button></div>
      </div>
      <div class="panel"><h2>About</h2>
        <p class="hint">Film and TV data from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB. Game data from RAWG.</p>
      </div>
    </div>
  </div>`;
}
function parseCSV(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  return rows.filter((r) => r.some((x) => x.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}
async function runImport() {
  const file = $("#imp-file").files[0];
  if (!file) return toast("Choose a CSV file first", true);
  if (!keys().rawg) return toast("Add your RAWG key first so games can be matched", true);
  const rows = parseCSV(await file.text()).filter((r) => r.title);
  const skip = $("#imp-skip").checked;
  // rows with no hours at all (e.g. PS3 trophy-only games) are always kept
  const todo = rows.filter((r) => !skip || r.hours === "" || r.hours == null || +r.hours >= 1);
  const log = $("#imp-log"), bar = $("#imp-bar"); $("#imp-progress").hidden = false; log.textContent = "";
  const say = (s) => { log.textContent += s + "\n"; log.scrollTop = log.scrollHeight; };
  say(`${todo.length} games to import${skip ? ` (${rows.length - todo.length} under 1h skipped)` : ""}`);
  let ok = 0, unmatched = 0, fuzzy = 0;
  for (let n = 0; n < todo.length; n++) {
    const r = todo[n]; const plat = r.platform || "Unknown"; const hours = Math.round((+r.hours || 0) * 10) / 10;
    try {
      // always look in the live library, so rows earlier in this file (and your own re-matches) are seen
      let row = findOwned(allItems(), r.title);
      let meta = row;
      if (!row) {
        const res = await rawg("/games", { search: r.title.replace(/[™®]/g, ""), page_size: "8" });
        const m = pickMatch(res.results, r.title, plat);
        if (m) { meta = metaFromRawg(m.pick); if (!m.exact) { fuzzy++; say(`~ "${r.title}" matched to "${m.pick.name}" (check it)`); } }
        else { meta = { media_type: "game", source: "manual", ext_id: norm(r.title).replace(/ /g, "-") || "game-" + n, title: r.title, year: null, poster: null }; unmatched++; say(`? "${r.title}" not found, added without artwork`); }
        row = S.items.get(keyOf("game", meta.source, meta.ext_id));
      }
      // "PS5 + PS4 + Steam" style rows carry one combined figure; per-platform rows add up.
      // Total = whichever is larger, so later per-platform imports never double-count.
      const platList = plat.split(/\s*\+\s*/).filter(Boolean);
      const hbp = { ...(row?.hours_by_platform || {}) };
      if (hours) hbp[platList.length > 1 ? COMBINED : plat] = hours;
      const specific = Object.entries(hbp).filter(([k]) => k !== COMBINED).reduce((a, [, h]) => a + +h, 0);
      const totalH = Math.round(Math.max(+hbp[COMBINED] || 0, specific) * 10) / 10;
      const patch = { hours_by_platform: hbp, hours: totalH || row?.hours || null, platforms: [...new Set([...(row?.platforms || []), ...platList])] };
      const names = withName(row || meta, r.title);
      if (names.length !== (row?.import_names || []).length) patch.import_names = names;
      if (r.last_played && (!row?.last_played || r.last_played > row.last_played)) patch.last_played = r.last_played.slice(0, 10);
      if (r.first_played && !row?.started_on) patch.started_on = r.first_played.slice(0, 10);
      if (r.trophies) patch.trophies = r.trophies;
      if (!row?.status) {
        const s = (r.status || "").toLowerCase();
        patch.status = STATUS_ORDER.includes(s) ? s : /platinum|100%/i.test(r.trophies || "") ? "finished" : "progress";
      }
      await saveItem(meta, patch);
      ok++;
    } catch (e) { say(`! "${r.title}": ${e.message}`); }
    bar.style.width = `${((n + 1) / todo.length) * 100}%`;
    await sleep(120);
  }
  say(`Done. ${ok} imported, ${fuzzy} approximate matches, ${unmatched} without artwork.`);
  if (fuzzy || unmatched) say(`Fix any wrong match from the game's page with "Wrong game? Change match".`);
  toast(`Imported ${ok} games`);
}
async function exportData() {
  const eps = await fetchAll("episodes");
  const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), items: allItems(), diary: S.diary, episodes: eps, lists: S.lists, list_items: S.listItems, showcase: S.showcase, collections: S.cols, collection_items: S.colItems }, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `marquee-backup-${today()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- modals ---------- */
function openLogModal() {
  const t = current.meta.media_type; const row = S.items.get(keyOf(t, current.meta.source, current.meta.ext_id));
  let rating = row?.rating || 0;
  modal(`<h2>${t === "game" ? "Log playthrough" : "Log watch"}</h2><p class="hint">${esc(current.meta.title)}</p>
    <div class="field"><label for="l-date">${t === "game" ? "Finished on" : "Watched on"}</label><input id="l-date" class="input" type="date" value="${today()}" max="${today()}"></div>
    <div class="field"><label>Rating</label><div id="l-stars">${starsWidget(rating)}</div></div>
    <div class="field"><label for="l-note">Note</label><textarea id="l-note" class="input" placeholder="Optional"></textarea></div>
    <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="l-re" ${S.diary.some((d) => d.item_id === row?.id) ? "checked" : ""}> ${t === "game" ? "Replay" : "Rewatch"}</label>
    <div class="modal-actions"><button class="btn ghost" data-act="modal-close">Cancel</button><button class="btn primary" data-act="log-save">Save entry</button></div>`, (m) => {
    m.addEventListener("click", (e) => { const b = e.target.closest('[data-act="rate"]'); if (!b) return; e.stopPropagation(); const v = +b.dataset.v; rating = rating === v ? 0 : v; m.querySelector("#l-stars").innerHTML = starsWidget(rating); });
    m.querySelector('[data-act="log-save"]').addEventListener("click", async (e) => {
      e.stopPropagation(); e.target.disabled = true;
      try {
        const date = m.querySelector("#l-date").value || today();
        const patch = { status: "finished" };
        if (rating) patch.rating = rating;
        if (t === "game") patch.finished_on = date;
        const item = await ensureRow(patch);
        const { data, error } = await S.sb.from("diary").insert({ item_id: item.id, logged_on: date, rating: rating || null, note: m.querySelector("#l-note").value.trim() || null, rewatch: m.querySelector("#l-re").checked }).select().single();
        if (error) throw error;
        S.diary.unshift(data); closeModal(); toast("Logged"); drawItem();
      } catch (err) { toast(err.message, true); e.target.disabled = false; }
    });
  });
}
function openListPicker() {
  modal(`<h2>Add to list</h2>
    ${S.lists.length ? `<div style="display:grid;gap:6px">${S.lists.map((l) => `<button class="btn" style="justify-content:space-between" data-act="pick-list" data-id="${l.id}">${esc(l.name)}<span class="hint">${S.listItems.filter((x) => x.list_id === l.id).length}</span></button>`).join("")}</div>` : `<p class="hint">You don't have any lists yet.</p>`}
    <div class="field"><label for="nl-name">Or create a new list</label><input id="nl-name" class="input" placeholder="e.g. Best horror"></div>
    <div class="modal-actions"><button class="btn ghost" data-act="modal-close">Close</button><button class="btn primary" data-act="pick-new">Create and add</button></div>`, (m) => {
    m.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      if (b.dataset.act !== "pick-list" && b.dataset.act !== "pick-new") return;
      e.stopPropagation();
      let listId = b.dataset.id;
      if (b.dataset.act === "pick-new") {
        const name = m.querySelector("#nl-name").value.trim(); if (!name) return toast("Give the list a name", true);
        const { data, error } = await S.sb.from("lists").insert({ name }).select().single(); if (error) return toast(error.message, true);
        S.lists.unshift(data); listId = data.id;
      }
      const item = await ensureRow({});
      if (S.listItems.some((x) => x.list_id === listId && x.item_id === item.id)) { closeModal(); return toast("Already in that list"); }
      const pos = S.listItems.filter((x) => x.list_id === listId).length;
      const { data, error } = await S.sb.from("list_items").insert({ list_id: listId, item_id: item.id, position: pos }).select().single();
      if (error) return toast(error.message, true);
      S.listItems.push(data); closeModal(); toast(`Added to ${S.lists.find((l) => l.id === listId).name}`); drawItem();
    });
  });
}
function openListEditor(id) {
  const l = id ? S.lists.find((x) => x.id === id) : null;
  modal(`<h2>${l ? "Edit list" : "New list"}</h2>
    <div class="field"><label for="le-name">Name</label><input id="le-name" class="input" value="${esc(l?.name || "")}"></div>
    <div class="field"><label for="le-desc">Description</label><textarea id="le-desc" class="input" placeholder="Optional">${esc(l?.description || "")}</textarea></div>
    <div class="modal-actions"><button class="btn ghost" data-act="modal-close">Cancel</button><button class="btn primary" id="le-save">Save</button></div>`, (m) => {
    m.querySelector("#le-save").addEventListener("click", async (e) => {
      e.stopPropagation();
      const name = m.querySelector("#le-name").value.trim(); if (!name) return toast("Give the list a name", true);
      const description = m.querySelector("#le-desc").value.trim() || null;
      const q = l ? S.sb.from("lists").update({ name, description }).eq("id", l.id) : S.sb.from("lists").insert({ name, description });
      const { data, error } = await q.select().single(); if (error) return toast(error.message, true);
      if (l) Object.assign(l, data); else S.lists.unshift(data);
      closeModal(); location.hash = `#/list/${data.id}`; if (l) renderList(l.id);
    });
  });
}
function openShowcase() {
  const t = current.meta.media_type; const row = S.items.get(keyOf(t, current.meta.source, current.meta.ext_id));
  const slots = [1, 2, 3, 4].map((s) => S.showcase.find((x) => x.media_type === t && x.slot === s));
  modal(`<h2>Pin to your top four ${TYPES[t].plural.toLowerCase()}</h2><p class="hint">Choose a slot. These show on your home page.</p>
    <div style="display:grid;gap:6px">${slots.map((s, i) => `<button class="btn" style="justify-content:space-between" data-act="pin-slot" data-slot="${i + 1}"><span>Slot ${i + 1}</span><span class="hint">${s ? esc(S.byId.get(s.item_id)?.title || "") : "Empty"}</span></button>`).join("")}</div>
    <div class="modal-actions"><button class="btn ghost" data-act="modal-close">Close</button></div>`, (m) => {
    m.addEventListener("click", async (e) => {
      const b = e.target.closest('[data-act="pin-slot"]'); if (!b) return; e.stopPropagation();
      const slot = +b.dataset.slot;
      const prev = S.showcase.find((x) => x.media_type === t && x.item_id === row.id);
      if (prev) await S.sb.from("showcase").delete().eq("media_type", t).eq("slot", prev.slot);
      const { data, error } = await S.sb.from("showcase").upsert({ media_type: t, slot, item_id: row.id }, { onConflict: "user_id,media_type,slot" }).select().single();
      if (error) return toast(error.message, true);
      S.showcase = S.showcase.filter((x) => !(x.media_type === t && (x.slot === slot || x.item_id === row.id))); S.showcase.push(data);
      closeModal(); toast(`Pinned to slot ${slot}`);
    });
  });
}
function openRematch() {
  const row = S.items.get(keyOf("game", current.meta.source, current.meta.ext_id));
  modal(`<h2>Change match</h2><p class="hint">Search RAWG for the right game. Your hours, rating and notes are kept.</p>
    <form id="rm-form" style="display:flex;gap:8px"><input id="rm-q" class="input" value="${esc(row.title)}"><button class="btn primary">Search</button></form>
    <div id="rm-res" style="display:grid;gap:6px"></div>
    <div class="modal-actions"><button class="btn ghost" data-act="modal-close">Close</button></div>`, (m) => {
    let results = [];
    m.querySelector("#rm-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const res = await rawg("/games", { search: m.querySelector("#rm-q").value, page_size: "8" });
        results = res.results.map((g) => metaFromRawg(g));
        m.querySelector("#rm-res").innerHTML = results.map((g, i) => `<button class="btn" style="justify-content:flex-start;text-align:left" data-act="rm-pick" data-i="${i}">${g.poster ? `<img src="${esc(rawgImg(g.poster, 80))}" alt="" style="width:40px;height:30px;object-fit:cover;border-radius:3px">` : ""}<span>${esc(g.title)} <span class="hint">${g.year || ""}</span></span></button>`).join("") || `<p class="hint">No results.</p>`;
      } catch (err) { toast(err.message, true); }
    });
    m.addEventListener("click", async (e) => {
      const b = e.target.closest('[data-act="rm-pick"]'); if (!b) return; e.stopPropagation();
      const g = results[+b.dataset.i];
      if (S.items.has(keyOf("game", g.source, g.ext_id))) return toast("That game is already in your library", true);
      const upd = { source: g.source, ext_id: g.ext_id, title: g.title, year: g.year, poster: g.poster, genres: g.genres || [] };
      // keep the old title as an import name, so the next PlayStation/Steam import lands on your pick
      const names = withName({ ...row, title: g.title }, row.title);
      if (names.length) upd.import_names = names;
      let { data, error } = await S.sb.from("items").update(upd).eq("id", row.id).select().single();
      if (error && /import_names/.test(error.message)) {
        delete upd.import_names;
        ({ data, error } = await S.sb.from("items").update(upd).eq("id", row.id).select().single());
        if (!error) upd.noAliases = true;
      }
      if (error) return toast(error.message, true);
      dropItem(row); putItem(data); closeModal();
      if (!upd.noAliases) toast("Match updated");
      else toast("Match updated. Run migrations/001_import_names.sql so imports remember it", true);
      location.hash = itemHref(data);
    });
  });
}

function openColEditor(id) {
  const c = id ? colOf(id) : null;
  modal(`<h2>${c ? "Rename collection" : "New collection"}</h2>
    ${c ? "" : `<p class="hint">Your own mix of films, series and games, e.g. “Christopher Nolan films” or “Batman everything”.</p>`}
    <div class="field"><label for="ce-name">Name</label><input id="ce-name" class="input" value="${esc(c?.name || "")}"></div>
    <div class="field"><label for="ce-desc">Description</label><textarea id="ce-desc" class="input" placeholder="Optional">${esc(c?.description || "")}</textarea></div>
    <div class="modal-actions"><button class="btn ghost" data-act="modal-close">Cancel</button><button class="btn primary" id="ce-save">Save</button></div>`, (m) => {
    m.querySelector("#ce-save").addEventListener("click", async (e) => {
      e.stopPropagation();
      const name = m.querySelector("#ce-name").value.trim(); if (!name) return toast("Give the collection a name", true);
      const description = m.querySelector("#ce-desc").value.trim() || null;
      const q = c ? S.sb.from("collections").update({ name, description }).eq("id", c.id) : S.sb.from("collections").insert({ name, description, kind: "custom" });
      const { data, error } = await q.select().single(); if (error) return toast(colErr(error), true);
      if (c) Object.assign(c, data); else S.cols.unshift(data);
      closeModal();
      if (c) drawCollection(c); else location.hash = `#/collection/${data.id}`;
    });
  });
}
function openColFind() {
  modal(`<h2>Find a franchise</h2><p class="hint">Film collections (like the Dark Knight trilogy) and TMDB keywords (like the MCU, which covers films and series).</p>
    <form id="cf-form" style="display:flex;gap:8px"><input id="cf-q" class="input" placeholder="e.g. Batman, Mad Max, Pixar"><button class="btn primary">Search</button></form>
    <div id="cf-res" style="display:grid;gap:6px;max-height:55vh;overflow:auto"></div>
    <div class="modal-actions"><button class="btn ghost" data-act="modal-close">Close</button></div>`, (m) => {
    let results = [];
    m.querySelector("#cf-form").addEventListener("submit", async (e) => {
      e.preventDefault(); const q = m.querySelector("#cf-q").value.trim(); if (!q) return;
      const out = m.querySelector("#cf-res"); out.innerHTML = `<p class="loading">Searching…</p>`;
      try {
        const [cs, ks] = await Promise.all([tmdb("/search/collection", { query: q }), tmdb("/search/keyword", { query: q })]);
        results = [
          ...(cs.results || []).slice(0, 10).map((x) => ({ name: x.name, kind: "tmdb_collection", ref: x.id, poster: x.poster_path ? TMDB_IMG + "w154" + x.poster_path : null })),
          ...(ks.results || []).slice(0, 8).map((x) => ({ name: x.name, kind: "tmdb_keyword", ref: x.id })),
        ];
        out.innerHTML = results.map((r, i) => `<button class="btn" style="justify-content:flex-start;text-align:left" data-act="cf-pick" data-i="${i}">${r.poster ? `<img src="${esc(r.poster)}" alt="" style="width:30px;height:44px;object-fit:cover;border-radius:3px">` : `<span class="tag">tag</span>`}<span>${esc(r.name)} <span class="hint">${r.kind === "tmdb_collection" ? "Film collection" : "Keyword · films and series"}</span></span></button>`).join("") || `<p class="hint">No franchises found. Try “New collection” to build your own.</p>`;
      } catch (err) { out.innerHTML = ""; toast(err.message === "NO_TMDB" ? "Add your TMDB key in Settings first" : err.message, true); }
    });
    m.addEventListener("click", async (e) => {
      const b = e.target.closest('[data-act="cf-pick"]'); if (!b) return; e.stopPropagation();
      const r = results[+b.dataset.i]; b.disabled = true;
      // keywords come back lower-case; tidy them up for the page title
      const name = r.kind === "tmdb_keyword" ? r.name.replace(/\b\w/g, (ch) => ch.toUpperCase()) : r.name;
      closeModal(); await followCollection({ ...r, name });
    });
  });
}
function openColAdd(c) {
  modal(`<h2>Add to ${esc(c.name)}</h2>
    <form id="ca-form" style="display:flex;gap:8px"><input id="ca-q" class="input" placeholder="Film, series or game"><button class="btn primary">Search</button></form>
    <div id="ca-res" style="display:grid;gap:6px;max-height:55vh;overflow:auto"></div>
    <div class="modal-actions"><button class="btn ghost" data-act="modal-close">Done</button></div>`, (m) => {
    let results = [];
    m.querySelector("#ca-form").addEventListener("submit", async (e) => {
      e.preventDefault(); const q = m.querySelector("#ca-q").value.trim(); if (!q) return;
      const out = m.querySelector("#ca-res"); out.innerHTML = `<p class="loading">Searching…</p>`;
      const k = keys();
      const [a, g] = await Promise.allSettled([k.tmdb ? tmdb("/search/multi", { query: q, include_adult: "false" }) : null, k.rawg ? rawg("/games", { search: q, page_size: "8" }) : null]);
      results = [
        ...((a.value?.results) || []).filter((r) => r.media_type === "movie" || r.media_type === "tv").slice(0, 12).map((r) => metaFromTmdb(r, r.media_type)),
        ...((g.value?.results) || []).map((x) => metaFromRawg(x)),
      ];
      const have = memberKeys(c.id);
      out.innerHTML = results.map((r, i) => { const has = have.has(keyOf(r.media_type, r.source, r.ext_id)); return `<button class="btn" style="justify-content:flex-start;text-align:left" data-act="ca-pick" data-i="${i}" ${has ? "disabled" : ""}>${r.poster ? `<img src="${esc(r.poster)}" alt="" style="width:30px;height:44px;object-fit:cover;border-radius:3px">` : ""}<span>${esc(r.title)} <span class="hint">${TYPES[r.media_type].label}${r.year ? " · " + r.year : ""}${has ? " · already in" : ""}</span></span></button>`; }).join("") || `<p class="hint">No results.</p>`;
    });
    m.addEventListener("click", async (e) => {
      const b = e.target.closest('[data-act="ca-pick"]'); if (!b) return; e.stopPropagation();
      b.disabled = true;
      try { await addToCollection(c, results[+b.dataset.i]); b.querySelector(".hint").insertAdjacentText("beforeend", " · added ✓"); drawCollection(c); } catch { b.disabled = false; }
    });
  });
}
function openColPicker() {
  const meta = current.meta;
  const inNow = colsWith(meta);
  modal(`<h2>Add to collection</h2>
    ${S.cols.length ? `<div style="display:grid;gap:6px">${S.cols.map((c) => { const has = inNow.includes(c); return `<button class="btn" style="justify-content:space-between" data-act="cp-pick" data-id="${c.id}" ${has ? "disabled" : ""}>${esc(c.name)}<span class="hint">${has ? "Already in" : colRows(c.id).length}</span></button>`; }).join("")}</div>` : `<p class="hint">You don't have any collections yet.</p>`}
    <div class="field"><label for="cp-name">Or start a new one</label><input id="cp-name" class="input" placeholder="e.g. Christopher Nolan films"></div>
    <div class="modal-actions"><button class="btn ghost" data-act="modal-close">Close</button><button class="btn primary" data-act="cp-new">Create and add</button></div>`, (m) => {
    m.addEventListener("click", async (e) => {
      const b = e.target.closest('[data-act="cp-pick"],[data-act="cp-new"]'); if (!b) return; e.stopPropagation();
      let c = colOf(b.dataset.id);
      if (b.dataset.act === "cp-new") {
        const name = m.querySelector("#cp-name").value.trim(); if (!name) return toast("Give the collection a name", true);
        const { data, error } = await S.sb.from("collections").insert({ name, kind: "custom" }).select().single();
        if (error) return toast(colErr(error), true);
        S.cols.unshift(data); c = data;
      }
      await addToCollection(c, meta); closeModal(); drawItem();
    });
  });
}

/* ---------- global events ---------- */
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act;
  if (b.closest(".modal") && !["modal-close"].includes(act)) return; // modal handles its own
  if (act === "modal-close-bg") { if (e.target === b) closeModal(); return; }
  if (act === "modal-close") return closeModal();
  if (act === "ep") return; // handled on change
  e.preventDefault();
  try {
    switch (act) {
      case "home-type": S.homeType = b.dataset.v; store.set("m.homeType", S.homeType); renderHome(); break;
      case "search-type": { const q = parseHash().q.get("q") || ""; location.hash = `#/search?q=${encodeURIComponent(q)}&type=${b.dataset.v}`; break; }
      case "lib-type": S.lib.type = b.dataset.v; store.set("m.libType", S.lib.type); renderLibrary(); break;
      case "lib-status": S.lib.status = b.dataset.v; renderLibrary(); break;
      case "lib-fav": S.lib.fav = !S.lib.fav; renderLibrary(); break;
      case "cal-view": CAL.view = b.dataset.v; store.set("m.calView", CAL.view); await renderCalendar(); break;
      case "cal-type": CAL.type = b.dataset.v; await renderCalendar(); break;
      case "cal-refresh": await renderCalendar(true); break;
      case "cal-wish": {
        const m = searchCache.get(b.dataset.key); if (!m) break;
        await saveItem(m, { status: "wishlist" }); toast("Added to Wishlist");
        CAL.mine = await loadMine(); await renderCalendar(); break;
      }
      case "cal-move": {
        const row = S.byId.get(b.dataset.id); if (!row) break;
        await saveItem(row, { status: "want" }); toast(`Moved to ${TYPES[row.media_type].status.want}`);
        CAL.mine = await loadMine(); await renderCalendar(); break;
      }
      case "quick-add": {
        const m = searchCache.get(b.dataset.key); if (!m) break;
        const st = addStatus(m);
        await saveItem(m, { status: st }); toast(`Added to ${TYPES[m.media_type].status[st]}`);
        b.remove(); break;
      }
      case "set-status": {
        const row = S.items.get(keyOf(current.meta.media_type, current.meta.source, current.meta.ext_id));
        const v = row?.status === b.dataset.v ? null : b.dataset.v;
        const patch = { status: v };
        if (v === "progress" && !row?.started_on) patch.started_on = today();
        await ensureRow(patch); drawItem(); break;
      }
      case "toggle-fav": { const row = S.items.get(keyOf(current.meta.media_type, current.meta.source, current.meta.ext_id)); await ensureRow({ favourite: !row?.favourite }); drawItem(); break; }
      case "rate": { const row = S.items.get(keyOf(current.meta.media_type, current.meta.source, current.meta.ext_id)); const v = +b.dataset.v; await ensureRow({ rating: row?.rating == v ? null : v }); drawItem(); break; }
      case "save-review": await ensureRow({ review: $("#f-review").value.trim() || null }); toast("Review saved"); break;
      case "save-game": {
        const plats = [...document.querySelectorAll(".plat-chips input:checked")].map((x) => x.value);
        const h = $("#f-hours").value;
        await ensureRow({ hours: h === "" ? null : +h, trophies: $("#f-trophies").value.trim() || null, started_on: $("#f-start").value || null, finished_on: $("#f-finish").value || null, platforms: plats });
        toast("Playtime saved"); break;
      }
      case "log": openLogModal(); break;
      case "add-to-list": openListPicker(); break;
      case "showcase": openShowcase(); break;
      case "rematch": openRematch(); break;
      case "remove-item": {
        const row = S.items.get(keyOf(current.meta.media_type, current.meta.source, current.meta.ext_id));
        modal(`<h2>Remove from library?</h2><p class="hint">This deletes your status, rating, review, diary entries and episode progress for “${esc(row.title)}”.</p><div class="modal-actions"><button class="btn ghost" data-act="modal-close">Keep it</button><button class="btn danger" id="rm-yes">Remove</button></div>`, (m) => {
          m.querySelector("#rm-yes").addEventListener("click", async (ev) => { ev.stopPropagation(); await deleteItem(row); closeModal(); drawItem(); });
        });
        break;
      }
      case "season-all": case "season-none": {
        const n = +b.dataset.season; const s = seasonCache.get(current.meta.ext_id + ":" + n); if (!s) break;
        const now = today();
        const eps = s.episodes.filter((x) => act === "season-none" || !x.air_date || x.air_date <= now).map((x) => x.episode_number);
        await setEpisodes(n, eps, act === "season-all"); break;
      }
      case "del-diary": {
        const { error } = await S.sb.from("diary").delete().eq("id", b.dataset.id); if (error) throw error;
        S.diary = S.diary.filter((d) => d.id !== b.dataset.id); renderDiary(); toast("Entry deleted"); break;
      }
      case "new-list": openListEditor(null); break;
      case "add-to-col": openColPicker(); break;
      case "col-new": openColEditor(null); break;
      case "col-rename": openColEditor(b.dataset.id); break;
      case "col-find": openColFind(); break;
      case "col-add": openColAdd(colOf(b.dataset.id)); break;
      case "col-preset": { const p = PRESETS.find((x) => x.name === b.dataset.v); b.disabled = true; try { await followPreset(p); } catch (err) { toast(err.message === "NO_TMDB" ? "Add your TMDB key in Settings first" : err.message, true); } b.disabled = false; break; }
      case "col-follow-tmdb": b.disabled = true; await followCollection({ name: b.dataset.name, kind: "tmdb_collection", ref: b.dataset.ref, poster: b.dataset.poster ? TMDB_IMG + "w342" + b.dataset.poster : null }); break;
      case "col-sync": { const c = colOf(b.dataset.id); b.disabled = true; b.textContent = "Refreshing…"; const n = await syncCollection(c); toast(`Up to date · ${n} titles from TMDB`); drawCollection(c); break; }
      case "col-edit-mode": COL.edit = !COL.edit; drawCollection(colOf(b.dataset.id)); break;
      case "col-filter": COL.filter = b.dataset.v; drawCollection(colOf(b.dataset.id)); break;
      case "col-hide": case "col-unhide": {
        const c = colOf(b.dataset.id); const hide = act === "col-hide";
        let q = S.sb.from("collection_items").update({ hidden: hide }).eq("collection_id", c.id);
        let match = (x) => x.collection_id === c.id && x.hidden;
        if (hide) { const [mt, src, ...rest] = b.dataset.key.split(":"); const ext = rest.join(":"); q = q.eq("media_type", mt).eq("source", src).eq("ext_id", ext); match = (x) => x.collection_id === c.id && x.media_type === mt && x.source === src && x.ext_id === ext; }
        const { error } = await q; if (error) throw new Error(colErr(error));
        S.colItems.filter(match).forEach((x) => (x.hidden = hide));
        drawCollection(c); break;
      }
      case "col-del": {
        const c = colOf(b.dataset.id);
        modal(`<h2>Delete “${esc(c.name)}”?</h2><p class="hint">Only the grouping goes. Titles stay in your library with their ratings and statuses.</p><div class="modal-actions"><button class="btn ghost" data-act="modal-close">Cancel</button><button class="btn danger" id="cd-yes">Delete collection</button></div>`, (m) => {
          m.querySelector("#cd-yes").addEventListener("click", async (ev) => { ev.stopPropagation(); const { error } = await S.sb.from("collections").delete().eq("id", c.id); if (error) return toast(error.message, true); S.cols = S.cols.filter((x) => x.id !== c.id); S.colItems = S.colItems.filter((x) => x.collection_id !== c.id); closeModal(); location.hash = "#/collections"; });
        });
        break;
      }
      case "edit-list": openListEditor(b.dataset.id); break;
      case "del-list": {
        const l = S.lists.find((x) => x.id === b.dataset.id);
        modal(`<h2>Delete “${esc(l.name)}”?</h2><p class="hint">The titles stay in your library.</p><div class="modal-actions"><button class="btn ghost" data-act="modal-close">Cancel</button><button class="btn danger" id="dl-yes">Delete list</button></div>`, (m) => {
          m.querySelector("#dl-yes").addEventListener("click", async (ev) => { ev.stopPropagation(); const { error } = await S.sb.from("lists").delete().eq("id", l.id); if (error) return toast(error.message, true); S.lists = S.lists.filter((x) => x.id !== l.id); S.listItems = S.listItems.filter((x) => x.list_id !== l.id); closeModal(); location.hash = "#/lists"; });
        });
        break;
      }
      case "list-move": {
        const lid = b.dataset.list; const its = S.listItems.filter((x) => x.list_id === lid).sort((a, c) => a.position - c.position);
        const i = its.findIndex((x) => x.item_id === b.dataset.item); const j = i + +b.dataset.dir; if (j < 0 || j >= its.length) break;
        [its[i], its[j]] = [its[j], its[i]]; its.forEach((x, n) => (x.position = n));
        renderList(lid);
        const { error } = await S.sb.from("list_items").upsert(its.map(({ list_id, item_id, position }) => ({ list_id, item_id, position })), { onConflict: "list_id,item_id" });
        if (error) toast(error.message, true);
        break;
      }
      case "list-remove": {
        const { error } = await S.sb.from("list_items").delete().eq("list_id", b.dataset.list).eq("item_id", b.dataset.item); if (error) throw error;
        S.listItems = S.listItems.filter((x) => !(x.list_id === b.dataset.list && x.item_id === b.dataset.item)); renderList(b.dataset.list); break;
      }
      case "save-keys": store.set("m.tmdb", cleanKey($("#k-tmdb").value)); store.set("m.rawg", cleanKey($("#k-rawg").value)); toast("Keys saved on this device"); break;
      case "test-keys": {
        store.set("m.tmdb", cleanKey($("#k-tmdb").value)); store.set("m.rawg", cleanKey($("#k-rawg").value));
        const r = await Promise.allSettled([tmdb("/configuration"), rawg("/games", { page_size: "1" })]);
        const msg = (x, n) => x.status === "fulfilled" ? `${n} works` : `${n}: ${x.reason.message.startsWith("NO_") ? "missing" : x.reason.message}`;
        toast(`${msg(r[0], "TMDB")} · ${msg(r[1], "RAWG")}`, r.some((x) => x.status === "rejected")); break;
      }
      case "run-import": b.disabled = true; await runImport(); b.disabled = false; break;
      case "export": await exportData(); break;
      case "get-covers": await fetchAllCovers(b); break;
      case "set-password": {
        const pw = $("#pw-new").value;
        if (pw.length < 8) { toast("Use at least 8 characters.", true); break; }
        const { error } = await S.sb.auth.updateUser({ password: pw });
        if (error) toast(error.message, true); else { $("#pw-new").value = ""; toast("Password saved. Use it to sign in on your phone."); }
        break;
      }
      case "sign-out": await S.sb.auth.signOut(); location.hash = ""; location.reload(); break;
    }
  } catch (err) { console.error(err); toast(err.message || "Something went wrong", true); }
});
document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.dataset?.act === "ep") setEpisodes(+el.dataset.season, [+el.dataset.ep], el.checked).catch((err) => toast(err.message, true));
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#modal-root").innerHTML) closeModal(); });
$("#top-search").addEventListener("submit", (e) => {
  e.preventDefault(); const q = $("#top-q").value.trim(); if (!q) return;
  const type = parseHash().parts[0] === "search" ? parseHash().q.get("type") || "all" : "all";
  location.hash = `#/search?q=${encodeURIComponent(q)}&type=${type}`;
});
window.addEventListener("hashchange", route);

/* ---------- auth + boot ---------- */
function renderAuth(sent = false) {
  document.body.classList.add("signed-out");
  $(".top").hidden = true;
  view.innerHTML = `<div class="auth">
    <span class="brand-bars" aria-hidden="true"><i></i><i></i><i></i></span>
    <h1>Marquee</h1>
    <p class="sub">Your films, series and games in one place.</p>
    ${sent ? `<div class="panel"><h2>Check your email</h2><p class="hint">We sent a sign-in link. Open it on this device to continue.</p><p class="hint"><a href="#" id="a-back">Back</a></p></div>`
      : `<form id="auth-form" class="panel"><div class="field"><label for="a-email">Email</label><input id="a-email" class="input" type="email" required autocomplete="email"></div><div class="field"><label for="a-pw">Password</label><input id="a-pw" class="input" type="password" autocomplete="current-password"></div><button class="btn primary" name="pw">Sign in</button><button class="btn" type="button" id="a-link">Email me a sign-in link instead</button><p class="hint">No password yet? Use the email link on your computer, then set one in Settings.</p></form>`}
  </div>`;
  $("#a-back")?.addEventListener("click", (e) => { e.preventDefault(); renderAuth(); });
  $("#auth-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[name=pw]");
    const password = $("#a-pw").value;
    if (!password) { toast("Enter your password, or use the email link.", true); return; }
    btn.disabled = true;
    const { error } = await S.sb.auth.signInWithPassword({ email: $("#a-email").value.trim(), password });
    if (error) { toast("Wrong email or password.", true); btn.disabled = false; }
  });
  $("#a-link")?.addEventListener("click", async (e) => {
    const email = $("#a-email").value.trim();
    if (!$("#a-email").checkValidity()) { toast("Enter your email first.", true); return; }
    e.target.disabled = true;
    const { error } = await S.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) { toast(error.message, true); e.target.disabled = false; } else renderAuth(true);
  });
}
async function onSignedIn(user) {
  if (S.user?.id === user.id) return;
  S.user = user; $(".top").hidden = false;
  view.innerHTML = `<p class="loading">Loading your library…</p>`;
  try { await loadEverything(); } catch (e) { view.innerHTML = `<div class="empty"><strong>Couldn't load your library.</strong><span>${esc(e.message)}. If this is a fresh setup, check you ran schema.sql in Supabase.</span></div>`; return; }
  route();
}
async function boot() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    $(".top").hidden = true;
    view.innerHTML = `<div class="auth"><span class="brand-bars" aria-hidden="true"><i></i><i></i><i></i></span><h1>Almost there</h1><div class="panel"><h2>Connect your database</h2><p class="hint">Open <b>config.js</b> and paste your Supabase project URL and anon key, then reload. The setup guide walks you through it.</p></div></div>`;
    return;
  }
  S.sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  const { data } = await S.sb.auth.getSession();
  S.sb.auth.onAuthStateChange((_ev, session) => { if (session?.user) onSignedIn(session.user); });
  if (data.session?.user) onSignedIn(data.session.user); else renderAuth();
}
boot();
