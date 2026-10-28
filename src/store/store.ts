import { useSyncExternalStore } from "react";
import type { Accent } from "../atlas/types";
import { mergeDoc, mergeProfiles, type SyncDoc } from "./merge";
import type { CardState, Grade } from "./srs";

export type QuizKind = "meaning" | "picture" | "listen" | "spell";
export type Step = { id: string; kind: "intro" } | { id: string; kind: QuizKind; retry?: boolean; options?: string[] };

export interface ActiveSession {
  id: string;
  started: number;
  steps: Step[];
  index: number;
  /** First-attempt grade per word; retries never change it. */
  graded: Record<string, Grade>;
  newIds: string[];
  reviewIds: string[];
  /** Answer shown but not yet continued; survives reload without double counting. */
  pending?: { correct: boolean; value: string };
  finished?: number;
}

export interface DayStat {
  n: number; // new words met
  r: number; // graded reviews (first attempts)
  c: number; // correct first attempts
  t: number; // active seconds
}

export interface TypingRound {
  at: number;
  mode: "word" | "sentence" | "dictation";
  items: number;
  wpm: number;
  accuracy: number;
}

export interface Progress {
  version: 2;
  datasetId: string;
  cards: Record<string, CardState>;
  bookmarks: string[];
  days: Record<string, DayStat>;
  typing: TypingRound[];
  session: ActiveSession | null;
  /** Rolling list of recent mistakes, newest first. */
  mistakes: string[];
}

export interface Settings {
  accent: Accent;
  autoplay: boolean;
  dailyNew: number;
  retention: number;
  theme: "system" | "light" | "dark";
  sfx: boolean;
  spell: boolean;
  startLevel: number;
  onboarded: boolean;
  dataset: "open" | "private";
  ambience: "off" | "stars" | "rain" | "sea" | "forest" | "fire" | "voyage" | "cafe";
  ambienceVolume: number;
  splash: boolean;
}

export const defaultSettings: Settings = {
  accent: "uk",
  autoplay: true,
  dailyNew: 10,
  retention: 0.9,
  theme: "dark",
  sfx: true,
  spell: true,
  startLevel: 0,
  onboarded: false,
  dataset: "open",
  ambience: "stars",
  ambienceVolume: 0.45,
  splash: true,
};

export const emptyProgress = (datasetId: string): Progress => ({
  version: 2,
  datasetId,
  cards: {},
  bookmarks: [],
  days: {},
  typing: [],
  session: null,
  mistakes: [],
});

export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* ---------- profiles: separate learners or study tracks, each with its own progress and settings ---------- */

export interface Profile {
  id: string;
  name: string;
  /** Last change, so the list merges across devices (newest edit wins). */
  at: number;
  deleted?: boolean;
}
export const DEFAULT_PROFILE = "default";
const PROFILES_KEY = "word-atlas:profiles";
/** Which profile this device uses. Deliberately per device, never synced. */
const ACTIVE_KEY = "word-atlas:profile";
// The default profile keeps the original keys, so existing progress needs no migration.
const scoped = (key: string, profile: string) => (profile === DEFAULT_PROFILE ? key : `${key}@${profile}`);
const settingsKey = (profile: string) => scoped("word-atlas:settings", profile);
const progressKey = (id: string, profile: string) => scoped(`word-atlas:v2:${id}`, profile);

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/* ---------- validation (backups and stored data are untrusted) ---------- */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, lo = -Infinity, hi = Infinity) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

function validCard(v: unknown): v is CardState {
  return (
    isObj(v) &&
    num(v.due, 0) &&
    num(v.s, 0) &&
    num(v.d, 0, 11) &&
    num(v.el, 0) &&
    num(v.sd, 0) &&
    num(v.ls, 0) &&
    num(v.reps, 0) &&
    num(v.lapses, 0) &&
    [0, 1, 2, 3].includes(v.st as number) &&
    (v.last === undefined || num(v.last, 0)) &&
    num(v.seen, 0)
  );
}

export function sanitizeProgress(v: unknown, datasetId: string): Progress {
  const out = emptyProgress(datasetId);
  if (!isObj(v) || v.version !== 2) return out;
  if (isObj(v.cards)) for (const [k, c] of Object.entries(v.cards)) if (validCard(c)) out.cards[k] = c;
  if (Array.isArray(v.bookmarks)) out.bookmarks = v.bookmarks.filter((x): x is string => typeof x === "string").slice(0, 20000);
  if (Array.isArray(v.mistakes)) out.mistakes = v.mistakes.filter((x): x is string => typeof x === "string").slice(0, 300);
  if (isObj(v.days))
    for (const [k, d] of Object.entries(v.days))
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && isObj(d) && num(d.n, 0) && num(d.r, 0) && num(d.c, 0) && num(d.t, 0))
        out.days[k] = { n: d.n as number, r: d.r as number, c: d.c as number, t: d.t as number };
  if (Array.isArray(v.typing))
    out.typing = v.typing
      .filter(
        (t): t is TypingRound =>
          isObj(t) && num(t.at, 0) && ["word", "sentence", "dictation"].includes(t.mode as string) && num(t.items, 0) && num(t.wpm, 0, 400) && num(t.accuracy, 0, 100),
      )
      .slice(-500);
  const s = v.session;
  if (isObj(s) && typeof s.id === "string" && Array.isArray(s.steps) && num(s.index, 0) && isObj(s.graded))
    out.session = s as unknown as ActiveSession;
  return out;
}

export function sanitizeProfiles(v: unknown): Profile[] {
  const out: Profile[] = [];
  if (Array.isArray(v))
    for (const p of v.slice(0, 50))
      if (isObj(p) && typeof p.id === "string" && /^[a-z0-9]{1,16}$/.test(p.id) && typeof p.name === "string" && num(p.at, 0) && !out.some((o) => o.id === p.id))
        out.push({ id: p.id, name: p.name.trim().slice(0, 20) || "未命名", at: p.at as number, ...(p.deleted === true ? { deleted: true } : {}) });
  if (!out.some((p) => p.id === DEFAULT_PROFILE)) out.unshift({ id: DEFAULT_PROFILE, name: "我", at: 0 });
  return out;
}

export function sanitizeSettings(v: unknown): Settings {
  const s = { ...defaultSettings };
  if (!isObj(v)) return s;
  if (v.accent === "uk" || v.accent === "us") s.accent = v.accent;
  if (typeof v.autoplay === "boolean") s.autoplay = v.autoplay;
  if (num(v.dailyNew, 0, 100)) s.dailyNew = Math.round(v.dailyNew as number);
  if (num(v.retention, 0.7, 0.97)) s.retention = v.retention as number;
  if (v.theme === "system" || v.theme === "light" || v.theme === "dark") s.theme = v.theme;
  if (typeof v.sfx === "boolean") s.sfx = v.sfx;
  if (typeof v.spell === "boolean") s.spell = v.spell;
  if (num(v.startLevel, 0, 5)) s.startLevel = Math.round(v.startLevel as number);
  if (typeof v.onboarded === "boolean") s.onboarded = v.onboarded;
  if (v.dataset === "open" || v.dataset === "private") s.dataset = v.dataset;
  if (["off", "stars", "rain", "sea", "forest", "fire", "voyage", "cafe"].includes(v.ambience as string)) s.ambience = v.ambience as Settings["ambience"];
  if (num(v.ambienceVolume, 0, 1)) s.ambienceVolume = v.ambienceVolume as number;
  if (typeof v.splash === "boolean") s.splash = v.splash;
  return s;
}

/* ---------- store ---------- */

/** "off" means no sync server answered, which is the normal static deployment. */
export type SyncStatus = "off" | "syncing" | "ok" | "error";

interface State {
  progress: Progress;
  settings: Settings;
  saveError: boolean;
  sync: SyncStatus;
  profile: string;
  profiles: Profile[];
}

const initialProfiles = sanitizeProfiles(read(PROFILES_KEY));
const storedProfile = read<string>(ACTIVE_KEY);
const initialProfile = initialProfiles.some((p) => p.id === storedProfile && !p.deleted) ? (storedProfile as string) : DEFAULT_PROFILE;

let state: State = {
  progress: emptyProgress("word-atlas-open"),
  settings: sanitizeSettings(read(settingsKey(initialProfile))),
  saveError: false,
  sync: "off",
  profile: initialProfile,
  profiles: initialProfiles,
};
const listeners = new Set<() => void>();
let saveTimer: number | undefined;
/** Only write when this tab changed something, so idle tabs never clobber newer data. */
let dirty = false;
/** Progress is written only after it has been read from storage for this dataset. */
let loadedId: string | null = null;

function emit() {
  listeners.forEach((l) => l());
}

function scheduleSave() {
  dirty = true;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flush, 250);
}

export function flush() {
  window.clearTimeout(saveTimer);
  if (!dirty) return;
  dirty = false;
  const progressOk = loadedId !== state.progress.datasetId || write(progressKey(state.progress.datasetId, state.profile), state.progress);
  const ok = progressOk && write(settingsKey(state.profile), state.settings);
  if (ok === state.saveError) {
    state = { ...state, saveError: !ok };
    emit();
  }
  scheduleSync(2000);
}

/* ---------- server sync (only when the page is served together with /api/sync) ---------- */

const SYNC_API = `${import.meta.env?.BASE_URL ?? "/"}api/sync/`;
const syncKey = (id: string, profile: string) => scoped(`word-atlas:sync:${id}`, profile);
/** Server doc key; the profile list itself lives under "profiles". */
const remoteKey = (id: string, profile: string) => encodeURIComponent(profile === DEFAULT_PROFILE ? id : `${id}--${profile}`);
/** The last doc both this device and the server agreed on, used as the merge base. */
interface SyncBase {
  rev: number;
  doc: SyncDoc;
}
/** null until the first request tells whether a sync server exists. */
let syncAvailable: boolean | null = null;
let syncTimer: number | undefined;
let syncing = false;
let syncAgain = false;

function setSync(sync: SyncStatus) {
  if (state.sync === sync) return;
  state = { ...state, sync };
  emit();
}

const cleanDoc = (doc: unknown, id: string): SyncDoc => {
  const d = isObj(doc) ? doc : {};
  return { progress: sanitizeProgress(d.progress, id), settings: sanitizeSettings(d.settings) };
};

/** Take the merged result locally without counting it as a local edit. */
function adopt(doc: SyncDoc) {
  if (JSON.stringify(doc) === JSON.stringify({ progress: state.progress, settings: state.settings })) return;
  state = { ...state, progress: doc.progress, settings: doc.settings };
  write(progressKey(doc.progress.datasetId, state.profile), doc.progress);
  write(settingsKey(state.profile), doc.settings);
  emit();
}

function setProfiles(profiles: Profile[]) {
  if (JSON.stringify(profiles) === JSON.stringify(state.profiles)) return;
  write(PROFILES_KEY, profiles);
  state = { ...state, profiles };
  emit();
  // Deleted on another device: fall back instead of writing into a removed profile.
  if (!profiles.some((p) => p.id === state.profile && !p.deleted)) store.useProfile(DEFAULT_PROFILE);
}

/** The list is tiny, so it is always fetched whole and merged per profile (newest edit wins). */
async function syncProfiles() {
  const got = await fetch(`${SYNC_API}profiles?rev=-1`, { cache: "no-store" });
  const head = await syncJson(got);
  if (!got.ok) throw new Error(`sync ${got.status}`);
  syncAvailable = true;
  let remote = { rev: head.rev, list: sanitizeProfiles(isObj(head.doc) ? head.doc.profiles : null) };
  for (let tries = 0; tries < 3; tries++) {
    const merged = mergeProfiles(state.profiles, remote.list);
    setProfiles(merged);
    if (JSON.stringify(merged) === JSON.stringify(remote.list)) return;
    const put = await fetch(`${SYNC_API}profiles`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRev: remote.rev, doc: { profiles: merged } }),
    });
    const body = await syncJson(put);
    if (put.ok) return;
    if (put.status !== 409) throw new Error(`sync ${put.status}`);
    remote = { rev: body.rev, list: sanitizeProfiles(isObj(body.doc) ? body.doc.profiles : null) };
  }
}

async function syncJson(res: Response) {
  if (!res.headers.get("content-type")?.includes("application/json")) throw new TypeError("no sync server");
  return (await res.json()) as { rev: number; doc?: unknown };
}

function scheduleSync(delay = 0) {
  if (typeof window === "undefined" || syncAvailable === false) return;
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => void syncNow(), delay);
}

export async function syncNow() {
  const id = loadedId;
  if (!id || syncAvailable === false) return;
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  flush();
  window.clearTimeout(syncTimer);
  setSync("syncing");
  try {
    await syncProfiles();
    const pid = state.profile;
    const baseKey = syncKey(id, pid);
    const raw = read<SyncBase>(baseKey);
    const saved = raw && num(raw.rev, 1) ? { rev: raw.rev, doc: cleanDoc(raw.doc, id) } : null;
    const got = await fetch(`${SYNC_API}${remoteKey(id, pid)}?rev=${saved?.rev ?? 0}`, { cache: "no-store" });
    const head = await syncJson(got);
    if (!got.ok) throw new Error(`sync ${got.status}`);
    syncAvailable = true;
    let remote: SyncBase | null = head.doc ? { rev: head.rev, doc: cleanDoc(head.doc, id) } : head.rev && head.rev === saved?.rev ? saved : null;
    // Stop if the learner switched dataset or profile while a request was in flight.
    for (let tries = 0; tries < 3 && loadedId === id && state.profile === pid; tries++) {
      const merged = mergeDoc(saved?.doc ?? null, { progress: state.progress, settings: state.settings }, remote?.doc ?? null);
      adopt(merged);
      if (remote && JSON.stringify(merged) === JSON.stringify(remote.doc)) {
        write(baseKey, { rev: remote.rev, doc: merged });
        break;
      }
      const put = await fetch(`${SYNC_API}${remoteKey(id, pid)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseRev: remote?.rev ?? 0, doc: merged }),
      });
      const body = await syncJson(put);
      if (put.ok) {
        write(baseKey, { rev: body.rev, doc: merged });
        break;
      }
      // Another device pushed first: merge on top of its version and try again.
      if (put.status !== 409) throw new Error(`sync ${put.status}`);
      remote = { rev: body.rev, doc: cleanDoc(body.doc, id) };
    }
    setSync("ok");
  } catch (e) {
    if (syncAvailable === null && e instanceof TypeError) {
      syncAvailable = false;
      setSync("off");
    } else setSync("error");
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      scheduleSync();
    }
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => (document.visibilityState === "hidden" ? flush() : scheduleSync()));
  window.addEventListener("online", () => scheduleSync());
  window.setInterval(() => document.visibilityState === "visible" && scheduleSync(), 60_000);
  // Another tab saved: adopt its data instead of keeping a stale copy.
  window.addEventListener("storage", (e) => {
    if (!e.newValue) return;
    try {
      if (e.key === settingsKey(state.profile)) state = { ...state, settings: sanitizeSettings(JSON.parse(e.newValue)) };
      else if (e.key === progressKey(state.progress.datasetId, state.profile))
        state = { ...state, progress: sanitizeProgress(JSON.parse(e.newValue), state.progress.datasetId) };
      else if (e.key === PROFILES_KEY) state = { ...state, profiles: sanitizeProfiles(JSON.parse(e.newValue)) };
      else return;
      emit();
    } catch {
      /* ignore malformed writes */
    }
  });
}

export const store = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  useDataset(datasetId: string) {
    flush();
    state = { ...state, progress: sanitizeProgress(read(progressKey(datasetId, state.profile)), datasetId) };
    loadedId = datasetId;
    emit();
    scheduleSync();
  },
  useProfile(id: string) {
    if (id === state.profile || !state.profiles.some((p) => p.id === id && !p.deleted)) return;
    flush();
    write(ACTIVE_KEY, id);
    const datasetId = state.progress.datasetId;
    state = {
      ...state,
      profile: id,
      settings: sanitizeSettings(read(settingsKey(id))),
      progress: sanitizeProgress(read(progressKey(datasetId, id)), datasetId),
    };
    emit();
    scheduleSync();
  },
  progress(fn: (p: Progress) => Progress) {
    state = { ...state, progress: fn(state.progress) };
    emit();
    scheduleSave();
  },
  settings(patch: Partial<Settings>) {
    state = { ...state, settings: { ...state.settings, ...patch } };
    emit();
    scheduleSave();
  },
};

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(state), () => select(state));
}

export function bumpDay(p: Progress, patch: Partial<DayStat>): Progress {
  const k = dayKey();
  const d = p.days[k] ?? { n: 0, r: 0, c: 0, t: 0 };
  return {
    ...p,
    days: {
      ...p.days,
      [k]: { n: d.n + (patch.n ?? 0), r: d.r + (patch.r ?? 0), c: d.c + (patch.c ?? 0), t: d.t + (patch.t ?? 0) },
    },
  };
}

export function toggleBookmark(id: string) {
  store.progress((p) => ({
    ...p,
    bookmarks: p.bookmarks.includes(id) ? p.bookmarks.filter((x) => x !== id) : [id, ...p.bookmarks],
  }));
}

/* ---------- profile management ---------- */

export interface ProfileSummary {
  /** False when this profile has never been opened on this device, so the numbers are unknown here. */
  known: boolean;
  learned: number;
  dueToday: number;
  startLevel: number;
}

/** Numbers for the profile switcher, read from this device's storage without switching. */
export function profileSummary(id: string): ProfileSummary {
  const datasetId = state.progress.datasetId;
  const raw = id === state.profile ? state.progress : read(progressKey(datasetId, id));
  const settings = id === state.profile ? state.settings : read(settingsKey(id));
  const progress = sanitizeProgress(raw, datasetId);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const cards = Object.values(progress.cards);
  return {
    known: raw !== null || settings !== null,
    learned: cards.length,
    dueToday: cards.filter((c) => c.due <= end.getTime()).length,
    startLevel: sanitizeSettings(settings).startLevel,
  };
}

const profileName = (name: string) => name.trim().slice(0, 20);

export function createProfile(name: string) {
  const n = profileName(name);
  if (!n) return;
  // Time-ordered ids keep the list in creation order on every device.
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  // A fresh learner goes through onboarding to pick a level, but keeps this device's look.
  write(settingsKey(id), { ...defaultSettings, theme: state.settings.theme });
  setProfiles([...state.profiles, { id, name: n, at: Date.now() }]);
  store.useProfile(id);
}

export function renameProfile(id: string, name: string) {
  const n = profileName(name);
  if (!n) return;
  setProfiles(state.profiles.map((p) => (p.id === id ? { ...p, name: n, at: Date.now() } : p)));
  scheduleSync();
}

export function deleteProfile(id: string) {
  if (id === DEFAULT_PROFILE || id === state.profile) return;
  const suffix = `@${id}`;
  const datasets = new Set<string>();
  try {
    for (const k of Object.keys(localStorage)) {
      if (!k.endsWith(suffix)) continue;
      const m = k.match(/^word-atlas:v2:(.+)@/);
      if (m) datasets.add(m[1]);
      localStorage.removeItem(k);
    }
  } catch {
    /* storage unavailable: the tombstone below still hides the profile */
  }
  datasets.add(state.progress.datasetId);
  setProfiles(state.profiles.map((p) => (p.id === id ? { ...p, deleted: true, at: Date.now() } : p)));
  if (syncAvailable) for (const ds of datasets) void fetch(`${SYNC_API}${remoteKey(ds, id)}`, { method: "DELETE" }).catch(() => null);
  scheduleSync();
}

/* ---------- backup ---------- */

export function exportBackup() {
  flush();
  const { progress, settings } = state;
  return JSON.stringify({ app: "word-atlas", version: 2, exported: new Date().toISOString(), progress: { ...progress, session: null }, settings }, null, 1);
}

function markDirty() {
  dirty = true;
}

export function importBackup(text: string): { ok: true; cards: number } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "文件不是有效的 JSON。" };
  }
  if (!isObj(data) || data.app !== "word-atlas" || data.version !== 2 || !isObj(data.progress))
    return { ok: false, error: "这不是词光的学习备份。" };
  const id = state.progress.datasetId;
  if (data.progress.datasetId !== id) return { ok: false, error: "备份来自另一个词库，请先切换到对应词库。" };
  const progress = sanitizeProgress({ ...data.progress, session: null }, id);
  state = { ...state, progress, settings: { ...sanitizeSettings(data.settings), onboarded: true } };
  emit();
  markDirty();
  flush();
  return { ok: true, cards: Object.keys(progress.cards).length };
}

export function resetProgress() {
  state = { ...state, progress: emptyProgress(state.progress.datasetId) };
  emit();
  markDirty();
  flush();
}
