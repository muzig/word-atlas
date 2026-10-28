import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeDoc, type SyncDoc } from "./merge";
import { defaultSettings, emptyProgress } from "./store";

const card = (last: number, reps = 1) => ({ due: last + 1, s: 2, d: 5, el: 0, sd: 1, ls: 0, reps, lapses: 0, st: 2 as const, last, seen: 1 });
const doc = (patch: Partial<SyncDoc["progress"]> = {}, settings: Partial<SyncDoc["settings"]> = {}): SyncDoc => ({
  progress: { ...emptyProgress("x"), ...patch },
  settings: { ...defaultSettings, ...settings },
});

test("keeps edits from both sides", () => {
  const base = doc({ cards: { a: card(10) } });
  const local = doc({ cards: { a: card(10), b: card(20) } });
  const remote = doc({ cards: { a: card(10), c: card(30) } });
  assert.deepEqual(Object.keys(mergeDoc(base, local, remote).progress.cards).sort(), ["a", "b", "c"]);
});

test("same word reviewed on two devices keeps the later review", () => {
  const base = doc({ cards: { a: card(10) } });
  const m = mergeDoc(base, doc({ cards: { a: card(50, 2) } }), doc({ cards: { a: card(40, 3) } }));
  assert.equal(m.progress.cards.a.last, 50);
});

test("deletions are not resurrected", () => {
  const base = doc({ cards: { a: card(10) }, bookmarks: ["a", "b"] });
  const local = doc({ bookmarks: ["b"] }); // reset cards, unbookmarked a
  const remote = doc({ cards: { a: card(10) }, bookmarks: ["c", "a", "b"] });
  const m = mergeDoc(base, local, remote);
  assert.deepEqual(m.progress.cards, {});
  assert.deepEqual(m.progress.bookmarks, ["c", "b"]);
});

test("same-day study adds up", () => {
  const day = (n: number, r: number) => ({ "2026-10-28": { n, r, c: r, t: r * 10 } });
  const m = mergeDoc(doc({ days: day(2, 4) }), doc({ days: day(5, 10) }), doc({ days: day(3, 7) }));
  assert.deepEqual(m.progress.days["2026-10-28"], { n: 6, r: 13, c: 13, t: 130 });
});

test("first sync unions progress and adopts the server's settings", () => {
  const local = doc({ cards: { a: card(10) }, bookmarks: ["a"] });
  const remote = doc({ cards: { b: card(20) }, bookmarks: ["b"] }, { accent: "us", dailyNew: 20 });
  const m = mergeDoc(null, local, remote);
  assert.deepEqual(Object.keys(m.progress.cards).sort(), ["a", "b"]);
  assert.deepEqual(m.progress.bookmarks, ["a", "b"]);
  assert.equal(m.settings.accent, "us");
  assert.equal(m.settings.dailyNew, 20);
});

test("a setting changed locally wins over an untouched remote", () => {
  const base = doc({}, { accent: "uk" });
  const m = mergeDoc(base, doc({}, { accent: "us" }), doc({}, { accent: "uk", sfx: false }));
  assert.equal(m.settings.accent, "us");
  assert.equal(m.settings.sfx, false);
});
