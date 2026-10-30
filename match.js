// Game matching for imports: ties PlayStation/Steam CSV titles to RAWG games and to games already in the library.
// Pure functions (no DOM, no network) so they can be tested with `node --test`.

const ROMAN = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10", xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15", xvi: "16" };

export const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[™®©]/g, "")
  .replace(/\b(ps4|ps5|playstation ?[345]|xbox series x\|s|xbox one|nintendo switch|switch|pc)\b/g, "")
  .replace(/\b(edition|remastered|definitive|complete|game of the year|goty|deluxe|digital|standard)\b/g, "")
  .replace(/&/g, " and ").replace(/['’]/g, "")
  .replace(/[^a-z0-9]+/g, " ").trim()
  .split(" ").map((w) => ROMAN[w] || w).join(" ");

// CSV platform names -> RAWG platform names
const PLATFORM = { ps5: "PlayStation 5", ps4: "PlayStation 4", ps3: "PlayStation 3", "ps vita": "PS Vita", steam: "PC", pc: "PC" };
export const rawgPlatforms = (csvPlatform) => String(csvPlatform || "").split(/\s*\+\s*/)
  .map((p) => PLATFORM[p.trim().toLowerCase()]).filter(Boolean);

// The names a library game answers to: its title plus every CSV title it was imported or re-matched from.
export const namesOf = (row) => [row.title, ...(row.import_names || [])].map(norm).filter(Boolean);

// The library game a CSV title belongs to, if any. Checks import names too, so a game you
// re-matched on the site keeps collecting hours from the next import instead of duplicating.
export function findOwned(games, title) {
  const n = norm(title);
  if (!n) return null;
  return games.find((g) => g.media_type === "game" && namesOf(g).includes(n)) || null;
}

const words = (s) => new Set(norm(s).split(" ").filter(Boolean));
// 0-100: how well a RAWG search result fits a CSV title (and platform, when known).
export function scoreCandidate(title, cand, csvPlatform) {
  const a = norm(title), b = norm(cand.name);
  let score;
  if (a && a === b) score = 100;
  else {
    const wa = words(title), wb = words(cand.name);
    const common = [...wa].filter((w) => wb.has(w)).length;
    score = wa.size && wb.size ? (80 * common) / (wa.size + wb.size - common) : 0;
    // a number that differs ("FIFA 22" vs "FIFA 23") is a different game
    const nums = (s) => [...s].filter((w) => /^\d+$/.test(w)).sort().join(",");
    if (nums(wa) !== nums(wb)) score -= 30;
  }
  const want = rawgPlatforms(csvPlatform);
  const has = (cand.platforms || []).map((p) => p.platform?.name);
  // platform only breaks ties between near matches; an exact title stays exact
  if (score < 100 && want.length && has.length) score += want.some((p) => has.includes(p)) ? 10 : -15;
  return Math.max(0, Math.min(100, score));
}

export const CONFIDENT = 90, POSSIBLE = 50;
// Best RAWG result for a CSV row: { pick, score, exact } or null when nothing fits well enough.
export function pickMatch(results, title, csvPlatform) {
  let best = null;
  for (const cand of results || []) {
    const score = scoreCandidate(title, cand, csvPlatform);
    if (!best || score > best.score) best = { pick: cand, score };
  }
  if (!best || best.score < POSSIBLE) return null;
  return { ...best, exact: best.score >= CONFIDENT };
}

// import_names after adding one more CSV title (kept unique by normalised form)
export function withName(row, title) {
  const list = [...(row?.import_names || [])];
  const n = norm(title);
  if (n && !namesOf(row || { title: "" }).includes(n)) list.push(title);
  return list;
}
