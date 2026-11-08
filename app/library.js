// Prompts and snippets. This phone owns them (they work offline); the PC keeps a merged copy as a backup
// and for other devices. Merging is the same as on the PC (prompts.py): nothing is replaced wholesale,
// an older version never wins over a newer one, an entry is never doubled, deleting happens only here.
// Kept in IndexedDB (room for far more than localStorage); a failed save is reported, never silent.
import { api, setSetting, setting, toast } from "./api.js";

let entries = []; // every entry, deletion markers included
let version = null; // the PC's version of the library we last saw
let unsynced = false; // changed here since the PC last took it
let changes = 0; // counts local changes, so a sync doesn't clear "unsynced" for one made meanwhile
let syncing = false;
let again = false;
let timer = null;
let state = { ok: null, at: null, error: null };
const listeners = new Set();

const notify = () => listeners.forEach((fn) => fn());
export const onLibraryChange = (fn) => listeners.add(fn);
export const syncState = () => state;

// ---------- merging (mirrors prompts.py) ----------
export const isGone = (e) => !!e.deleted && e.deleted >= e.updated;
const greater = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};
const contentKey = (e) => [e.updated, e.text ? 1 : 0, e.text, e.name, e.kind];

export function mergeEntry(a, b) {
  const content = greater(contentKey(b), contentKey(a)) ? b : a; // newer text wins; a tie keeps the one with text
  const place = greater([b.posUpdated, b.pos], [a.posUpdated, a.pos]) ? b : a; // the list position has its own time
  const merged = { ...content, pos: place.pos, posUpdated: place.posUpdated, deleted: Math.max(a.deleted || 0, b.deleted || 0) || null };
  if (isGone(merged)) Object.assign(merged, { name: "", text: "" });
  return merged;
}

export function merge(ours, theirs) {
  const byId = new Map(ours.map((e) => [e.id, e]));
  for (const e of theirs) byId.set(e.id, byId.has(e.id) ? mergeEntry(byId.get(e.id), e) : e);
  return [...byId.values()].sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
}

/** Compares libraries by content only (not by the order of keys inside an entry). */
const same = (a, b) => {
  const flat = (list) => JSON.stringify(list.map((e) => [e.id, e.kind, e.name, e.text, e.created, e.updated, e.pos, e.posUpdated, e.deleted]));
  return flat(a) === flat(b);
};

// ---------- on this phone ----------
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("comfy-phone-prompts", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close(); // don't block another window's upgrade or delete
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}
const dbReady = db();

async function idb(mode, fn) {
  const d = await dbReady;
  return new Promise((resolve, reject) => {
    const t = d.transaction("kv", mode);
    const req = fn(t.objectStore("kv"));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error ?? new Error("storage error"));
  });
}

// Loading merges into what may already have been added (never replaces it). The library first lived in
// localStorage; that copy is merged in too, and removed once it is safely stored here.
const ready = (async () => {
  let saved = null;
  try {
    saved = await idb("readonly", (s) => s.get("library"));
  } catch (err) {
    state = { ...state, error: `can't open the phone's storage (${err.message})` };
  }
  let old = [];
  try {
    old = JSON.parse(localStorage.getItem("promptLibrary") ?? "[]");
  } catch { /* none */ }
  entries = merge(merge(saved?.entries ?? [], Array.isArray(old) ? old : []), entries);
  version = saved?.version ?? null;
  unsynced = saved ? saved.unsynced || old.length > 0 : entries.length > 0;
  state.at = Number(setting("promptSyncAt", 0)) || saved?.syncedAt || null;
  if (old.length || !saved) await persist();
  notify();
})();

let persisted = Promise.resolve();
/** Saves the library on this phone; tells the user if that fails. */
function persist() {
  persisted = persisted.then(async () => {
    try {
      await idb("readwrite", (s) => s.put({ entries, version, unsynced }, "library"));
      try {
        localStorage.removeItem("promptLibrary"); // now kept in IndexedDB
      } catch { /* nothing to remove */ }
      navigator.storage?.persist?.(); // asks Chrome not to clear it when space runs low
    } catch (err) {
      toast(`Couldn't save the prompts on this phone (${err.message}). Free some space; until then they live only in the open app.`, "bad");
    }
  });
  return persisted;
}

// ---------- reading and changing ----------
/** The prompts or snippets to show, in their order. */
export const visible = (kind) => entries.filter((e) => e.kind === kind && !isGone(e))
  .sort((a, b) => a.pos - b.pos || a.created - b.created);

/** One id for prompts and snippets alike: the time plus 64 random bits (no clash between devices), and
 * never one this phone already has. */
function newId() {
  for (;;) {
    const random = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const id = `${Date.now().toString(36)}-${random}`;
    if (!entries.some((e) => e.id === id)) return id;
  }
}

function changed() {
  unsynced = true;
  changes++;
  ready.then(persist);
  notify();
  clearTimeout(timer);
  timer = setTimeout(syncLibrary, 800); // a burst of edits goes to the PC once
}

export function addEntry(kind, text, name = "") {
  const now = Date.now();
  const last = visible(kind).at(-1);
  // Within the PC's limit (prompts.py), or it refuses the whole sync until the name is cut by hand. Counted in
  // characters, as the PC counts, so an emoji is never cut in half.
  entries.push({ id: newId(), kind, name: [...name].slice(0, 200).join(""), text, created: now, updated: now,
    pos: last ? last.pos + 1 : 0, posUpdated: now, deleted: null });
  changed();
}

export function editEntry(id, fields) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  Object.assign(e, fields, { updated: Date.now() });
  changed();
}

export function deleteEntry(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  // The marker tells other devices; never earlier than the last change (another device's clock may run ahead).
  Object.assign(e, { deleted: Math.max(Date.now(), e.updated), name: "", text: "" });
  changed();
}

/** Deletes every prompt and/or snippet (kinds: ["prompt", "snippet"]); like deleting each, on all devices. */
export async function deleteAllOf(kinds) {
  await ready;
  const now = Date.now();
  for (const e of entries) {
    if (kinds.includes(e.kind) && !isGone(e)) Object.assign(e, { deleted: Math.max(now, e.updated), name: "", text: "" });
  }
  changed();
}

export const libraryReady = ready;

export function reorder(ids) {
  const now = Date.now();
  ids.forEach((id, i) => {
    const e = entries.find((x) => x.id === id);
    if (e) Object.assign(e, { pos: i, posUpdated: now });
  });
  changed();
}

// ---------- with the PC ----------
/** Takes in the PC's library (merged, never replacing). true if the PC is missing something from here. */
function takeIn(theirs) {
  version = theirs.version;
  const next = merge(entries, theirs.entries);
  if (!same(next, entries)) entries = next;
  return !same(next, merge(theirs.entries, []));
}

/** Only changes go up: unchanged, the phone just asks the PC "anything new?" (a few bytes if not).
 * Taking in the PC's answer starts no new sync, so nothing goes back and forth. */
export async function syncLibrary() {
  await ready;
  if (syncing) {
    again = true; // changed meanwhile: once more afterwards
    return;
  }
  syncing = true;
  clearTimeout(timer);
  try {
    let news = true; // false when the PC answers "unchanged": then nothing here needs saving
    if (unsynced) {
      const sent = changes;
      takeIn(await api("api/prompts", { method: "PUT", body: { entries } }));
      if (changes === sent) unsynced = false;
    } else {
      const res = await fetch("api/prompts", { cache: "no-store", headers: version ? { "If-None-Match": `"${version}"` } : {} });
      news = res.status !== 304;
      if (news) {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (takeIn(await res.json())) again = unsynced = true; // e.g. the PC lost its copy: give it ours
      }
    }
    state = { ok: true, at: Date.now(), error: null };
    setSetting("promptSyncAt", String(state.at)); // just the time, kept apart from the library
    if (news) await persist();
  } catch (err) {
    state = { ...state, ok: false, error: err.message };
  } finally {
    syncing = false;
    notify();
    if (again) {
      again = false;
      syncLibrary();
    }
  }
}
