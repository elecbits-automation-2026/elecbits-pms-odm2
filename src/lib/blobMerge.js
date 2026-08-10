/* ─── MERGE-ON-SAVE — the end of last-writer-wins ────────────────────────────
   The workspace is stored as two JSON blobs in `app_kv`. Until now every save
   wrote this browser's entire copy over whatever was there, so with two people
   signed in the second save silently erased the first person's work.

   The fix is to merge before writing, and to merge on a timer so open browsers
   converge without a reload:

     save:  read server blob → merge with local state → write the union
     poll:  read server blob → merge into local state (no write)

   The merge is per item, keyed on id, with one piece of bookkeeping per
   browser: `known` — the set of ids this browser has CONFIRMED on the server
   (updated only after a successful server read, or after its own successful
   write). That one set is what lets additions and deletions travel in both
   directions without tombstones:

     on the server, not held locally
       · not in `known`  → someone else added it since we last looked → ADOPT
       · in `known`      → we had it and removed it → our deletion → DROP

     held locally, not on the server
       · not in `known`  → ours, newly created, not saved yet → KEEP
       · in `known`      → the server had it and no longer does →
                           someone else deleted it → LET IT GO

     held by both → whoever actually edited it wins. `base` is a snapshot of
       each item as of the last sync; if our copy still matches `base`, we
       didn't touch it, so a differing server copy is someone else's edit and
       is adopted. If our copy differs from `base`, we are mid-edit and our
       copy stands. Both sides edited → last save wins, for that item only.

   What this deliberately does not solve: two people editing the same field of
   the same object within one debounce window (one edit wins), and a sub-second
   read/write interleave that can drop a just-written item until its author
   saves again. Both are bounded to single items. The failure mode it replaces
   was unbounded — whole-workspace erasure.                                   */

const keyOf = (x) => (x && (x.id ?? x.projectId)) || null;

/* Merge one collection. `known` is a Set of ids confirmed on the server.
   Returns { merged, changed } — `changed` is true when the result differs
   from `local` (so the caller knows to update React state). */
export function mergeCollection(local, server, known, base) {
  const L = Array.isArray(local) ? local : [];
  const S = Array.isArray(server) ? server : [];
  const k = known instanceof Set ? known : new Set();
  const b = base instanceof Map ? base : new Map();
  const Lmap = new Map(L.map((x) => [keyOf(x), x]));
  const Smap = new Map(S.map((x) => [keyOf(x), x]));

  const merged = [];
  let changed = false;

  for (const item of L) {
    const id = keyOf(item);
    if (!id) { merged.push(item); continue; }          // keyless: keep, never merge
    const sItem = Smap.get(id);
    if (sItem === undefined) {
      if (k.has(id)) { changed = true; continue; }      // deleted elsewhere — let it go
      merged.push(item); continue;                      // ours, not saved yet
    }
    const localJson = JSON.stringify(item);
    const serverJson = JSON.stringify(sItem);
    if (localJson === serverJson) { merged.push(item); continue; }
    // Differs. Did WE change it since the last sync, or did they?
    if (b.get(id) === localJson) { merged.push(sItem); changed = true; } // untouched here → their edit wins
    else merged.push(item);                              // we are mid-edit → ours stands
  }
  for (const item of S) {
    const id = keyOf(item);
    if (!id || Lmap.has(id)) continue;
    if (k.has(id)) { changed = true; continue; }        // our own deletion — stays deleted
    merged.push(item); changed = true;                  // added elsewhere — adopt
  }
  return { merged, changed };
}

/* The two blobs, collection by collection. */
const A_KEYS = ["projects", "clients", "notes", "tasks"];
const B_KEYS = ["kpiLog", "workUpdates", "trainings", "memory", "syncLog", "assistantLog"];

/* One person, one day, one work update — if two browsers minted separate ids
   for the same (person, day), keep the newer and drop the other. */
const dedupeWorkUpdates = (list) => {
  const byKey = new Map();
  for (const w of list) {
    const key = `${w.userId}|${w.date}`;
    const prev = byKey.get(key);
    if (!prev || String(w.at || "") > String(prev.at || "")) byKey.set(key, w);
  }
  return byKey.size === list.length ? list : [...byKey.values()];
};

/* Merge the whole workspace against what the server holds.
   `knownMap` is a plain object { collection: Set } owned by the caller.
   Returns { state, changed: [names...], serverIds } — `serverIds` is what
   `knownMap` should become once this state is CONFIRMED on the server. */
export function mergeWorkspace(local, serverA, serverB, knownMap, baseMap) {
  const out = { ...local };
  const changed = [];
  const km = knownMap || {};
  const bm = baseMap || {};

  const one = (name, serverList) => {
    const { merged, changed: c } = mergeCollection(local[name], serverList, km[name], bm[name]);
    let final = merged;
    if (name === "workUpdates") final = dedupeWorkUpdates(merged);
    if (name === "syncLog") final = merged.slice(0, 60);          // the app caps these,
    if (name === "assistantLog") final = merged.slice(-400);      // a merge must not regrow them
    out[name] = final;
    if (c || final.length !== (Array.isArray(local[name]) ? local[name].length : 0)) changed.push(name);
  };

  for (const name of A_KEYS) one(name, serverA?.[name]);
  for (const name of B_KEYS) one(name, serverB?.[name]);

  // The roster: null means "seed roster, never edited". Whoever has a real
  // one wins; two real ones merge like any other collection.
  const localR = local.roster, serverR = serverB?.roster;
  if (Array.isArray(serverR)) {
    if (Array.isArray(localR)) {
      const { merged, changed: c } = mergeCollection(localR, serverR, km.roster, bm.roster);
      out.roster = merged; if (c) changed.push("roster");
    } else { out.roster = serverR; changed.push("roster"); }
  } else out.roster = localR ?? null;

  const serverIds = {}, baseAfter = {};
  for (const name of [...A_KEYS, ...B_KEYS, "roster"]) {
    const list = Array.isArray(out[name]) ? out[name] : [];
    serverIds[name] = new Set(list.map(keyOf).filter(Boolean));
    baseAfter[name] = new Map(list.filter(keyOf).map((x) => [keyOf(x), JSON.stringify(x)]));
  }
  return { state: out, changed, serverIds, baseAfter };
}

/* After a plain READ (no write), `base` must become what the SERVER holds —
   not the merged result. If a mid-edit item were snapshotted as its own base,
   the next save would judge it "untouched" and discard the user's edit in
   favour of the stale server copy. */
export function baseOf(serverA, serverB) {
  const bm = {};
  const take = (name, list) => {
    bm[name] = new Map((Array.isArray(list) ? list : []).filter(keyOf).map((x) => [keyOf(x), JSON.stringify(x)]));
  };
  for (const name of A_KEYS) take(name, serverA?.[name]);
  for (const name of B_KEYS) take(name, serverB?.[name]);
  take("roster", Array.isArray(serverB?.roster) ? serverB.roster : []);
  return bm;
}

/* What `known` should be after a plain READ (no write): exactly the ids the
   server holds right now. */
export function idsOf(serverA, serverB) {
  const ids = {};
  for (const name of A_KEYS) ids[name] = new Set((serverA?.[name] || []).map(keyOf).filter(Boolean));
  for (const name of B_KEYS) ids[name] = new Set((serverB?.[name] || []).map(keyOf).filter(Boolean));
  ids.roster = new Set((Array.isArray(serverB?.roster) ? serverB.roster : []).map(keyOf).filter(Boolean));
  return ids;
}

export const blobA = (s) => ({ projects: s.projects, clients: s.clients, notes: s.notes, tasks: s.tasks });
export const blobB = (s) => ({
  kpiLog: s.kpiLog, workUpdates: s.workUpdates, trainings: s.trainings, memory: s.memory,
  syncLog: s.syncLog, roster: s.roster ?? null,
  assistantLog: (s.assistantLog || []).slice(-200).filter((m) => !m.confirm),
});
