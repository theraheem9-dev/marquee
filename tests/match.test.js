// Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { norm, findOwned, pickMatch, scoreCandidate, withName } from "../match.js";

const cand = (name, ...plats) => ({ name, platforms: plats.map((p) => ({ platform: { name: p } })) });

test("norm drops platform and edition words, symbols and roman numerals", () => {
  assert.equal(norm("Marvel's Spider-Man Remastered (PS5)"), "marvels spider man");
  assert.equal(norm("FINAL FANTASY VII REBIRTH™"), "final fantasy 7 rebirth");
  assert.equal(norm("Ratchet & Clank"), "ratchet and clank");
});

test("a re-matched game is found by its old import title", () => {
  const games = [{ media_type: "game", title: "God of War Ragnarök", import_names: ["God of War Ragnarok Digital Deluxe"] }];
  assert.equal(findOwned(games, "God of War Ragnarok Digital Deluxe"), games[0]);
  assert.equal(findOwned(games, "God of War Ragnarök"), games[0]);
  assert.equal(findOwned(games, "God of War"), null);
});

test("films with the same title are not mistaken for games", () => {
  assert.equal(findOwned([{ media_type: "movie", title: "Halo" }], "Halo"), null);
});

test("exact title wins over the first search result", () => {
  const res = [cand("Spider-Man: Miles Morales", "PlayStation 5"), cand("Marvel's Spider-Man", "PlayStation 4")];
  const m = pickMatch(res, "Marvel's Spider-Man", "PS4");
  assert.equal(m.pick.name, "Marvel's Spider-Man");
  assert.ok(m.exact);
});

test("a different number in the title is a different game", () => {
  assert.ok(scoreCandidate("EA SPORTS FC 24", cand("EA SPORTS FC 25")) < 50);
  assert.equal(pickMatch([cand("FIFA 22")], "FIFA 23", "PS5"), null);
});

test("platform breaks ties between near matches", () => {
  const res = [cand("Death Stranding", "PC"), cand("Death Stranding", "PlayStation 4", "PlayStation 5")];
  const m = pickMatch(res, "Death Stranding Directors Cut", "PS5");
  assert.equal(m.pick, res[1]);
  assert.ok(!m.exact); // close but not exact: flagged for checking
  assert.equal(scoreCandidate("Death Stranding Directors Cut", cand("DEATH STRANDING DIRECTOR’S CUT")), 100);
});

test("nothing close enough means no match", () => {
  assert.equal(pickMatch([cand("Tetris Effect")], "Astro Bot", "PS5"), null);
  assert.equal(pickMatch([], "Astro Bot", "PS5"), null);
});

test("withName adds a new CSV title once", () => {
  const row = { title: "Elden Ring", import_names: [] };
  assert.deepEqual(withName(row, "ELDEN RING™"), []);
  assert.deepEqual(withName(row, "Elden Ring Shadow of the Erdtree Edition"), ["Elden Ring Shadow of the Erdtree Edition"]);
  assert.deepEqual(withName({ title: "X", import_names: ["Y"] }, "y"), ["Y"]);
});
