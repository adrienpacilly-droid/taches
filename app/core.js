// Règles de Tâches, identiques à celles de l'app Mac (Board.swift et CloudSync.swift).
// Aucun accès au réseau ni à l'écran ici.

export const newID = () => crypto.randomUUID().toUpperCase();
export const now = () => Date.now() / 1000;

// --- Jours -----------------------------------------------------------------
const p2 = n => String(n).padStart(2, '0');
export const dayOf = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const today = () => dayOf(new Date());
export const dateOf = day => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, 12); };
export const addDays = (day, n) => { const d = dateOf(day); d.setDate(d.getDate() + n); return dayOf(d); };
export function nextMonth(day, anchor) {
  const [y, m] = day.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const last = new Date(ny, nm, 0).getDate();
  return `${ny}-${p2(nm)}-${p2(Math.min(anchor, last))}`;
}
const fr = o => new Intl.DateTimeFormat('fr-FR', o);
export function dayLabel(day, t = today()) {
  if (day < t) return 'En retard, ' + fr({ day: 'numeric', month: 'short' }).format(dateOf(day));
  if (day === t) return "Aujourd'hui";
  if (day === addDays(t, 1)) return 'Demain';
  return fr({ weekday: 'short', day: 'numeric', month: 'short' }).format(dateOf(day));
}

// --- Comparaison -----------------------------------------------------------
export function same(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const x = Object.keys(a), y = Object.keys(b);
  return x.length === y.length && x.every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
}
const copy = v => structuredClone(v);

// --- Lecture du tableau ----------------------------------------------------
export const emptyBoard = () => ({ columns: [], domains: [], views: [], tasks: [] });
export const doneColumn = b => b.columns.find(c => c.isDone);
export const firstOpen = b => b.columns.find(c => !c.isDone);
export const taskOf = (b, id) => b.tasks.find(t => t.id === id);
export const isDone = (b, t) => t.columnID === doneColumn(b).id;

export function matches(t, domains, due, day) {
  if (domains.length && !domains.includes(t.domainID)) return false;
  if (due === 'week') return !!t.due && t.due <= addDays(day, 7);
  if (due === 'late') return !!t.due && t.due < day;
  return true;
}
export function tasksIn(b, column, domains = [], due = 'all', day = today()) {
  const list = b.tasks.filter(t => t.columnID === column && matches(t, domains, due, day));
  return column === doneColumn(b).id ? list.sort((x, y) => (y.completedAt ?? -Infinity) - (x.completedAt ?? -Infinity) || 0) : list.sort((x, y) => x.order - y.order);
}
export const todayTasks = (b, day = today()) => b.tasks
  .filter(t => !isDone(b, t) && (t.today || (t.due && t.due <= day)))
  .sort((x, y) => (x.due ?? '9999') < (y.due ?? '9999') ? -1 : (x.due ?? '9999') > (y.due ?? '9999') ? 1 : x.order - y.order);

// --- Modifications ---------------------------------------------------------
const lastOrder = (b, column) => b.tasks.filter(t => t.columnID === column).reduce((m, t) => Math.max(m, t.order), -Infinity);
const endOrder = (b, column) => { const m = lastOrder(b, column); return (m === -Infinity ? 0 : m) + 1; };

export function addTask(b, title, { column, domain, due, today: pick = false, id = newID(), at = now() } = {}) {
  const clean = title.trim();
  if (!clean) return null;
  const columnID = column ?? firstOpen(b).id;
  const t = { id, title: clean, columnID, today: pick, subtasks: [], recurrence: 'none', order: endOrder(b, columnID), updatedAt: at };
  const d = domain ?? b.domains[0]?.id;
  if (d) t.domainID = d;
  if (due) t.due = due;
  b.tasks.push(t);
  return id;
}

/** `edited` : les seuls champs changés à l'écran. */
export function updateTask(b, id, edited, at = now(), day = today()) {
  const t = taskOf(b, id);
  if (!t) return;
  const e = { ...t, ...edited };
  const clean = (e.title ?? '').trim();
  if (clean) t.title = clean;
  if (e.domainID) t.domainID = e.domainID;
  if (t.due !== e.due || t.recurrence !== e.recurrence) {
    if (e.recurrence === 'monthly') t.anchorDay = Number((e.due ?? day).slice(8)); else delete t.anchorDay;
  }
  if (e.due) t.due = e.due; else delete t.due;
  t.today = e.today;
  t.subtasks = e.subtasks;
  t.recurrence = e.recurrence;
  t.updatedAt = at;
  if (t.columnID !== e.columnID) moveTask(b, id, e.columnID, null, at, day);
}

export function nextDue(t, day) {
  let d = t.due ?? day;
  do {
    if (t.recurrence === 'none') return d;
    if (t.recurrence === 'daily') d = addDays(d, 1);
    else if (t.recurrence === 'weekly') d = addDays(d, 7);
    else d = nextMonth(d, t.anchorDay ?? Number((t.due ?? day).slice(8)));
  } while (d <= day);
  return d;
}

function complete(b, id, at, day) {
  const t = taskOf(b, id);
  if (!t) return;
  t.previousColumnID = t.columnID;
  t.columnID = doneColumn(b).id;
  t.completedAt = at;
  t.updatedAt = at;
  if (t.recurrence === 'none' || t.link) return;
  const n = copy(t);
  n.id = newID();
  n.columnID = t.previousColumnID;
  for (const k of ['previousColumnID', 'spawnedID', 'completedAt']) delete n[k];
  n.today = false;
  n.due = nextDue(t, day);
  n.subtasks = t.subtasks.map(s => ({ id: newID(), title: s.title, done: false }));
  t.spawnedID = n.id;
  b.tasks.push(n);
}

function reopen(b, id, column, at) {
  const t = taskOf(b, id);
  if (!t) return;
  const spawned = t.spawnedID;
  if (t.sheetAnswered === true) delete t.link;
  for (const k of ['sheetAnswered', 'spawnedID', 'completedAt']) delete t[k];
  t.columnID = column;
  t.order = endOrder(b, column);
  t.updatedAt = at;
  const s = spawned && taskOf(b, spawned);
  if (s && !isDone(b, s)) deleteTask(b, spawned);
}

export function toggleTask(b, id, at = now(), day = today()) {
  const t = taskOf(b, id);
  if (!t) return;
  if (!isDone(b, t)) return complete(b, id, at, day);
  const back = b.columns.find(c => c.id === t.previousColumnID && !c.isDone)?.id ?? firstOpen(b).id;
  reopen(b, id, back, at);
}

/** `before` : la carte au-dessus de laquelle on dépose ; null = fin de colonne. */
export function moveTask(b, id, column, before = null, at = now(), day = today()) {
  const t = taskOf(b, id), dest = b.columns.find(c => c.id === column);
  if (!t || !dest || before === id) return;
  if (dest.isDone) { if (!isDone(b, t)) complete(b, id, at, day); return; }
  if (isDone(b, t)) reopen(b, id, column, at);
  const list = tasksIn(b, column).filter(x => x.id !== id);
  const i = before ? list.findIndex(x => x.id === before) : -1;
  list.splice(i < 0 ? list.length : i, 0, t);
  list.forEach((x, n) => {
    if (x.order !== n || x.id === id) x.updatedAt = at;
    x.order = n;
  });
  t.columnID = column;
}

/** Une relance se supprime sur le Mac, qui sait l'écarter du Google Sheet. */
export const canDelete = t => !t.link || t.sheetAnswered === true;
export function deleteTask(b, id) { b.tasks = b.tasks.filter(t => t.id !== id); }
export function setToday(b, id, value, at = now()) { const t = taskOf(b, id); if (t) { t.today = value; t.updatedAt = at; } }
export function toggleSub(b, id, sub, at = now()) {
  const t = taskOf(b, id), s = t?.subtasks.find(x => x.id === sub);
  if (s) { s.done = !s.done; t.updatedAt = at; }
}

// --- Synchro ---------------------------------------------------------------
const LISTS = { column: 'columns', domain: 'domains', view: 'views', task: 'tasks' };
const ORDER = { column: 0, domain: 1, view: 2, task: 3 };
export const keyOf = (kind, id) => `${kind}:${id.toUpperCase()}`;
const split = k => { const i = k.indexOf(':'); return [k.slice(0, i), k.slice(i + 1)]; };
export const newState = account => ({ account, cursor: 0, base: {} });

export function docs(b) {
  const out = {};
  for (const [kind, list] of Object.entries(LISTS)) b[list].forEach((item, n) => {
    const o = copy(item);
    if (kind !== 'task') o.rank = n;
    if (Array.isArray(o.domainIDs)) o.domainIDs.sort();
    out[keyOf(kind, item.id)] = o;
  });
  return out;
}

export function boardOf(documents) {
  const b = emptyBoard();
  for (const [k, v] of Object.entries(documents)) b[LISTS[split(k)[0]]].push(copy(v));
  for (const kind of ['column', 'domain', 'view']) {
    const l = b[LISTS[kind]];
    l.sort((x, y) => (x.rank ?? 0) - (y.rank ?? 0) || (x.id < y.id ? -1 : 1));
    l.forEach(x => delete x.rank);
  }
  repair(b);
  return b;
}

export function repair(b) {
  if (!b.columns.length) return; // base vide : c'est le Mac qui crée le premier tableau
  const done = b.columns.filter(c => c.isDone);
  if (!done.length) b.columns.push({ id: newID(), name: 'Fait', color: '2F9E53', isDone: true });
  done.slice(1).forEach(c => { c.isDone = false; });
  if (!b.columns.some(c => !c.isDone)) b.columns.unshift({ id: newID(), name: 'À faire', color: '75858A', isDone: false });
  if (!b.domains.length) b.domains.push({ id: newID(), name: 'Perso', color: '2F9E53' });
  const cols = new Set(b.columns.map(c => c.id)), doms = new Set(b.domains.map(d => d.id));
  for (const t of b.tasks) {
    if (!cols.has(t.columnID)) t.columnID = firstOpen(b).id;
    if (t.domainID && !doms.has(t.domainID)) t.domainID = b.domains[0].id;
  }
  for (const v of b.views) v.domainIDs = v.domainIDs.filter(d => doms.has(d));
}

const GROUP = ['columnID', 'completedAt', 'previousColumnID', 'spawnedID', 'sheetAnswered', 'link'];
export function merge(base, local, remote) {
  const b = base ?? {}, l = local, r = remote;
  const remoteWins = (r.updatedAt ?? 0) > (l.updatedAt ?? 0);
  const out = {};
  const put = (k, v) => { if (v === undefined) delete out[k]; else out[k] = copy(v); };
  for (const k of new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(b)])) {
    const x = l[k], y = r[k], z = b[k];
    put(k, same(x, y) ? x : same(x, z) ? y : same(y, z) ? x : remoteWins ? y : x);
  }
  if (typeof l.updatedAt === 'number' && typeof r.updatedAt === 'number') out.updatedAt = Math.max(l.updatedAt, r.updatedAt);
  if (GROUP.some(k => !same(l[k], b[k])) && GROUP.some(k => !same(r[k], b[k])) && !same(l, r) && (base || l.columnID !== undefined)) {
    const side = remoteWins ? r : l;
    for (const k of GROUP) put(k, side[k]);
  }
  return out;
}

/** Applique les lignes reçues à `board` (modifie `state`). Une modification l'emporte sur une suppression. */
export function applyRows(rows, board, state) {
  if (!rows.length) return board;
  const local = docs(board);
  for (const row of [...rows].sort((a, b) => a.rev - b.rev)) {
    const key = keyOf(row.kind, row.id), mine = local[key], known = state.base[key];
    state.cursor = Math.max(state.cursor, row.rev);
    if (known && known.rev >= row.rev) continue;
    if (row.deleted) {
      if (mine && known?.data && same(mine, known.data)) delete local[key];
      state.base[key] = { rev: row.rev, data: null };
    } else {
      if (mine) local[key] = merge(known?.data, mine, row.data);
      else if (!known?.data || !same(known.data, row.data)) local[key] = copy(row.data);
      state.base[key] = { rev: row.rev, data: copy(row.data) };
    }
  }
  return boardOf(local);
}

export function changes(board, state) {
  if (!board.columns.length) return [];
  const local = docs(board), out = [];
  for (const [k, data] of Object.entries(local)) if (!state.base[k]?.data || !same(state.base[k].data, data)) {
    const [kind, id] = split(k);
    out.push({ kind, id, data, deleted: false, base_rev: state.base[k]?.rev ?? 0 });
  }
  for (const [k, v] of Object.entries(state.base)) if (v.data && !local[k]) {
    const [kind, id] = split(k);
    out.push({ kind, id, data: {}, deleted: true, base_rev: v.rev });
  }
  return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || (a.id < b.id ? -1 : 1));
}

export function confirmPush(sent, acks, state) {
  const byKey = new Map(sent.map(p => [keyOf(p.kind, p.id), p]));
  let conflict = false;
  for (const a of acks) {
    const k = keyOf(a.kind, a.id), p = byKey.get(k);
    if (!p) continue;
    if (a.ok) state.base[k] = { rev: a.rev, data: p.deleted ? null : copy(p.data) }; else conflict = true;
  }
  return conflict || acks.length !== sent.length;
}
