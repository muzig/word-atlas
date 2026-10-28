import type { CardState } from "./srs";
import type { DayStat, Profile, Progress, Settings, TypingRound } from "./store";

/** What a device syncs for one dataset. */
export interface SyncDoc {
  progress: Progress;
  settings: Settings;
}

/*
 * Three-way merge against the last snapshot both sides agreed on (base).
 * A side that did not touch a value since base defers to the other side,
 * so deletions (unbookmark, reset) survive instead of being resurrected.
 */

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function pick<T>(b: T, l: T, r: T, both: (l: T, r: T) => T): T {
  if (same(l, b)) return r;
  if (same(r, b)) return l;
  return both(l, r);
}

function mergeRecord<T>(b: Record<string, T>, l: Record<string, T>, r: Record<string, T>, both: (l: T | undefined, r: T | undefined, b: T | undefined) => T | undefined) {
  const out: Record<string, T> = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
    const v = pick<T | undefined>(b[k], l[k], r[k], (lv, rv) => both(lv, rv, b[k]));
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Both sides reviewed the same word: keep the more recent review. */
function newerCard(l: CardState | undefined, r: CardState | undefined) {
  if (!l || !r) return l ?? r;
  const lt = l.last ?? l.seen;
  const rt = r.last ?? r.seen;
  return lt !== rt ? (lt > rt ? l : r) : l.reps >= r.reps ? l : r;
}

/** Both sides studied on the same day: add up what each did since base. */
function addDays(l: DayStat | undefined, r: DayStat | undefined, b: DayStat | undefined): DayStat | undefined {
  if (!l || !r) return l ?? r;
  const z = b ?? { n: 0, r: 0, c: 0, t: 0 };
  const f = (k: keyof DayStat) => Math.max(0, l[k] + r[k] - z[k]);
  return { n: f("n"), r: f("r"), c: f("c"), t: f("t") };
}

/** Lists ordered newest first: local additions go in front, local removals are dropped. */
function mergeList<T>(b: T[], l: T[], r: T[], key: (x: T) => string = String) {
  const bk = new Set(b.map(key));
  const lk = new Set(l.map(key));
  const added = l.filter((x) => !bk.has(key(x)));
  const removed = new Set(b.map(key).filter((k) => !lk.has(k)));
  const seen = new Set<string>();
  return [...added, ...r].filter((x) => {
    const k = key(x);
    if (removed.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const roundKey = (t: TypingRound) => `${t.at}:${t.mode}`;

export function mergeDoc(base: SyncDoc | null, local: SyncDoc, remote: SyncDoc | null): SyncDoc {
  if (!remote) return local;
  // First sync on this device: merge progress as a union, but let the server's settings win over fresh defaults.
  const b = base ?? { progress: { ...remote.progress, cards: {}, bookmarks: [], days: {}, typing: [], mistakes: [], session: null }, settings: local.settings };
  const [bp, lp, rp] = [b.progress, local.progress, remote.progress];
  const progress: Progress = {
    ...lp,
    cards: mergeRecord(bp.cards, lp.cards, rp.cards, newerCard),
    days: mergeRecord(bp.days, lp.days, rp.days, addDays),
    bookmarks: mergeList(bp.bookmarks, lp.bookmarks, rp.bookmarks),
    mistakes: mergeList(bp.mistakes, lp.mistakes, rp.mistakes).slice(0, 300),
    typing: mergeList(bp.typing, lp.typing, rp.typing, roundKey)
      .sort((x, y) => x.at - y.at)
      .slice(-500),
    session: pick(bp.session, lp.session, rp.session, (l) => l),
  };
  const settings = { ...local.settings };
  for (const k of Object.keys(settings) as (keyof Settings)[])
    (settings as Record<string, unknown>)[k] = pick(b.settings[k], local.settings[k], remote.settings[k], (l) => l);
  return { progress, settings };
}

/** Profile lists merge per profile: the newest edit wins, and deletions are kept as tombstones. */
export function mergeProfiles(local: Profile[], remote: Profile[]): Profile[] {
  const byId = new Map<string, Profile>();
  for (const p of [...remote, ...local]) {
    const prev = byId.get(p.id);
    if (!prev || p.at > prev.at) byId.set(p.id, p);
  }
  // The default profile first, then creation order (ids are time-ordered).
  return [...byId.values()].sort((a, b) => (a.id === "default" ? -1 : b.id === "default" ? 1 : a.id < b.id ? -1 : 1));
}
