import * as C from './core.js';
import { store, signIn, signOut, sync } from './net.js';

const $ = id => document.getElementById(id);
/** Crée un élément. Les textes passent toujours par `textContent`. */
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'on') for (const [ev, f] of Object.entries(v)) n.addEventListener(ev, f);
    else if (k === 'color') n.style.setProperty('--c', /^[0-9a-f]{6}$/i.test(v) ? '#' + v : '#75858a');
    else if (k === 'class') n.className = v;
    else if (k in n && k !== 'list') n[k] = v;
    else n.setAttribute(k, v);
  }
  n.append(...kids.flat().filter(x => x !== null && x !== undefined && x !== false));
  return n;
}
const svg = d => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); p.setAttribute('d', d); s.append(p); return s; };

const pref = { get: k => { try { return localStorage.getItem('taches.' + k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem('taches.' + k, v); } catch { /* plein */ } } };
const ui = { vue: pref.get('vue') === 'kanban' ? 'kanban' : 'jour', domaines: [], echeance: 'all', colonne: 0, scroll: {} };
const B = () => store.board;
const domain = id => B().domains.find(d => d.id === id);
const column = id => B().columns.find(c => c.id === id);

// --- Avis ------------------------------------------------------------------
let noticeTimer;
function notice(text, undo) {
  const a = $('avis'), b = a.querySelector('button');
  a.querySelector('span').textContent = text;
  b.hidden = !undo;
  b.onclick = () => { a.hidden = true; undo?.(); };
  a.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { a.hidden = true; }, 5000);
}

function toggle(t) {
  const was = C.isDone(B(), t);
  store.change(b => C.toggleTask(b, t.id));
  if (was) return notice('Tâche rouverte', () => store.change(b => { if (C.taskOf(b, t.id) && !C.isDone(b, C.taskOf(b, t.id))) C.toggleTask(b, t.id); }));
  notice(t.link ? 'Fait. Le Mac te proposera de mettre à jour le Sheet.' : t.recurrence !== 'none' ? 'Fait. La prochaine est prévue.' : 'Fait', () => store.change(b => { const x = C.taskOf(b, t.id); if (x && C.isDone(b, x)) C.toggleTask(b, t.id); }));
}

// --- Morceaux communs ------------------------------------------------------
function check(t) {
  const done = C.isDone(B(), t);
  return el('button', { class: 'coche', 'aria-pressed': String(done), 'aria-label': (done ? 'Rouvrir : ' : 'Terminer : ') + t.title, on: { click: () => toggle(t) } }, el('i'));
}
function meta(t, withDomain = true) {
  const d = domain(t.domainID), done = C.isDone(B(), t), day = C.today(), subs = t.subtasks.length, out = [];
  if (withDomain && d) out.push(el('span', {}, el('i', { class: 'pastille', color: d.color }), el('b', {}, d.name)));
  if (t.due && !done) out.push(el('span', { class: t.due < day ? 'retard' : '' }, C.dayLabel(t.due, day)));
  if (subs) out.push(el('span', {}, `${t.subtasks.filter(s => s.done).length} sur ${subs}`));
  if (t.recurrence !== 'none') out.push(el('span', {}, REC[t.recurrence]));
  if (t.link) out.push(el('span', {}, 'Google Sheet'));
  return out.length ? el('span', { class: 'infos' }, out) : null;
}
const REC = { none: 'Jamais', daily: 'Chaque jour', weekly: 'Chaque semaine', monthly: 'Chaque mois' };

// --- Aujourd'hui -----------------------------------------------------------
function dayView() {
  const b = B(), day = C.today(), list = C.todayTasks(b, day), ids = new Set(list.map(t => t.id));
  const open = b.tasks.filter(t => !C.isDone(b, t) && !ids.has(t.id)).sort((x, y) => (x.due ?? '9') < (y.due ?? '9') ? -1 : (x.due ?? '9') > (y.due ?? '9') ? 1 : x.order - y.order);
  const done = b.tasks.filter(t => C.isDone(b, t) && t.completedAt && C.dayOf(new Date(t.completedAt * 1000)) === day).sort((x, y) => y.completedAt - x.completedAt);
  const row = (t, pick) => el('li', { class: 'ligne' + (C.isDone(b, t) ? ' faite' : '') }, check(t),
    el('button', { class: 'ouvrir', on: { click: () => editor(t) } }, el('span', { class: 'nom' }, t.title), meta(t)),
    pick && el('button', { class: 'choisir', 'aria-label': `Ajouter à Aujourd'hui : ${t.title}`, on: { click: () => store.change(x => C.setToday(x, t.id, true)) } }, "Aujourd'hui"));
  const part = (name, items, pick, empty) => (items.length || empty) && el('section', {}, el('h2', {}, name), items.length ? el('ul', { class: 'liste' }, items.map(t => row(t, pick))) : el('p', { class: 'vide' }, empty));
  return el('div', { class: 'jour' }, part('À faire', list, false, open.length ? 'Rien de prévu. Pioche une tâche ci-dessous.' : 'Rien de prévu.'), part('À piocher', open, true), part("Terminé aujourd'hui", done));
}

// --- Kanban ----------------------------------------------------------------
function filters() {
  const chip = (name, on, f, color) => el('button', { class: 'puce', 'aria-pressed': String(on), on: { click: f } }, color && el('i', { class: 'pastille', color }), name);
  const none = !ui.domaines.length && ui.echeance === 'all', set = (d, e) => { ui.domaines = d; ui.echeance = e; render(); };
  const isView = v => v.due === ui.echeance && C.same([...v.domainIDs].sort(), [...ui.domaines].sort());
  return el('div', { class: 'filtres', role: 'group', 'aria-label': 'Filtres' },
    chip('Tout', none, () => set([], 'all')),
    B().views.map(v => chip(v.name, !none && isView(v), () => set([...v.domainIDs], v.due))),
    chip('7 jours', ui.echeance === 'week', () => set(ui.domaines, ui.echeance === 'week' ? 'all' : 'week')),
    chip('En retard', ui.echeance === 'late', () => set(ui.domaines, ui.echeance === 'late' ? 'all' : 'late')),
    B().domains.map(d => chip(d.name, ui.domaines.includes(d.id), () => set(ui.domaines.includes(d.id) ? ui.domaines.filter(x => x !== d.id) : [...ui.domaines, d.id], ui.echeance), d.color)));
}
function boardView() {
  const b = B(), board = el('div', { class: 'tableau', id: 'tableau' }, b.columns.map(c => {
    const all = C.tasksIn(b, c.id, ui.domaines, ui.echeance), shown = c.isDone ? all.slice(0, 50) : all;
    return el('section', { class: 'colonne', 'aria-label': c.name, 'data-id': c.id },
      el('h2', {}, el('i', { class: 'pastille', color: c.color }), c.name, el('b', {}, String(all.length))),
      el('div', { class: 'cartes', 'data-scroll': c.id },
        shown.map(t => el('article', { class: 'carte' + (c.isDone ? ' faite' : '') }, check(t),
          el('button', { class: 'ouvrir', on: { click: () => editor(t) } }, el('span', { class: 'nom' }, t.title), meta(t)),
          el('button', { class: 'plusInfos', 'aria-label': 'Déplacer : ' + t.title, on: { click: () => mover(t) } }, svg('M8 4v15M4.5 15.5 8 19l3.5-3.5M16 20V5M12.5 8.5 16 5l3.5 3.5')))),
        !shown.length && el('p', { class: 'vide' }, 'Aucune carte'),
        all.length > shown.length && el('p', { class: 'doux' }, `${all.length - shown.length} plus anciennes masquées`)),
      !c.isDone && el('button', { class: 'ajout', on: { click: () => editor(null, { columnID: c.id }) } }, '+ Ajouter'));
  }));
  return el('div', { class: 'kanban' }, filters(), board);
}

// --- Feuilles --------------------------------------------------------------
const sheet = $('feuille');
let opener = null;
function open(title, body, { left = 'Fermer', right, action } = {}) {
  if (!sheet.open) opener = document.activeElement;
  sheet.setAttribute('aria-label', title);
  sheet.replaceChildren(el('div', { class: 'barre' }, el('button', { type: 'button', on: { click: close } }, left), el('h2', { tabIndex: -1, autofocus: true }, title), right ? el('button', { type: 'button', on: { click: action } }, right) : el('button', { type: 'button', disabled: true, 'aria-hidden': 'true', tabIndex: -1 }, '')), el('div', { class: 'fiche' }, body));
  if (!sheet.open) sheet.showModal();
}
function close() { sheet.close(); }
sheet.addEventListener('close', () => { if (sheet.open) return; sheet.replaceChildren(); opener?.isConnected && opener.focus?.(); opener = null; });
sheet.addEventListener('click', e => { if (e.target === sheet) { const r = sheet.getBoundingClientRect(); if (e.clientY < r.top) close(); } });

const option = (v, text, sel) => el('option', { value: v, selected: v === sel }, text);

function editor(task, seed = {}) {
  const isNew = !task, t = task ? C.taskOf(B(), task.id) : { title: '', columnID: C.firstOpen(B()).id, domainID: ui.vue === 'kanban' && ui.domaines.length === 1 ? ui.domaines[0] : B().domains[0]?.id, today: ui.vue === 'jour', subtasks: [], recurrence: 'none', ...seed };
  if (!t) return;
  const start = structuredClone(t), draft = structuredClone(t), linked = !!t.link, done = !isNew && C.isDone(B(), t);

  const title = el('textarea', { rows: 1, value: draft.title, placeholder: 'Titre', 'aria-label': 'Titre', disabled: linked, enterKeyHint: 'done', maxLength: 500, on: { input: e => { draft.title = e.target.value; }, keydown: e => { if (e.key === 'Enter') { e.preventDefault(); save(); } } } });
  const date = el('input', { type: 'date', value: draft.due ?? '', 'aria-label': 'Échéance', on: { change: e => { draft.due = e.target.value || undefined; } } });
  const setDue = d => { draft.due = d; date.value = d ?? ''; };
  const quick = (n, d) => el('button', { type: 'button', class: 'puce', on: { click: () => setDue(d) } }, n);

  const subs = el('div', { class: 'groupe' });
  const adder = el('input', { class: 'texte', placeholder: 'Ajouter une sous-tâche', 'aria-label': 'Ajouter une sous-tâche', enterKeyHint: 'enter', maxLength: 300, on: { keydown: e => { if (e.key === 'Enter') { e.preventDefault(); pushSub(); } } } });
  const pushSub = () => { const v = adder.value.trim(); if (v) { draft.subtasks.push({ id: C.newID(), title: v, done: false }); adder.value = ''; drawSubs(); adder.focus(); } };
  function drawSubs() {
    subs.replaceChildren(...draft.subtasks.map(s => el('div', {},
      el('input', { type: 'checkbox', checked: s.done, 'aria-label': 'Faite : ' + s.title, on: { change: e => { s.done = e.target.checked; } } }),
      el('input', { class: 'texte', value: s.title, 'aria-label': 'Sous-tâche', maxLength: 300, on: { input: e => { s.title = e.target.value; } } }),
      el('button', { type: 'button', class: 'simple', 'aria-label': 'Retirer : ' + s.title, on: { click: () => { draft.subtasks = draft.subtasks.filter(x => x !== s); drawSubs(); } } }, '✕'))), el('div', {}, adder));
  }
  drawSubs();

  function save() {
    const pendingSub = adder.value.trim();
    if (pendingSub) draft.subtasks.push({ id: C.newID(), title: pendingSub, done: false });
    draft.subtasks = draft.subtasks.filter(s => s.title.trim());
    if (!draft.title.trim()) { title.focus(); return; }
    // Seuls les champs touchés ici sont écrits : ce que le Mac a changé entre-temps reste.
    const edited = {};
    for (const k of ['title', 'columnID', 'domainID', 'due', 'today', 'subtasks', 'recurrence']) if (!C.same(draft[k], start[k])) edited[k] = draft[k];
    close();
    if (isNew) store.change(b => { const id = C.addTask(b, draft.title, { column: draft.columnID, domain: draft.domainID, due: draft.due, today: draft.today }); C.updateTask(b, id, { subtasks: draft.subtasks, recurrence: draft.recurrence }); });
    else if (Object.keys(edited).length) store.change(b => C.updateTask(b, t.id, edited));
  }

  let sure = false;
  const remove = el('button', { type: 'button', class: 'danger', on: { click: () => { if (!sure) { sure = true; remove.textContent = 'Toucher encore pour supprimer'; return; } close(); store.change(b => C.deleteTask(b, t.id)); notice('Tâche supprimée'); } } }, 'Supprimer');

  open(isNew ? 'Nouvelle tâche' : 'Tâche', [
    el('div', { class: 'champ' }, title, linked && el('p', { class: 'doux' }, "Le titre et l'échéance viennent du Google Sheet.")),
    el('div', { class: 'groupe' },
      el('label', {}, el('span', {}, 'Colonne'), el('select', { on: { change: e => { draft.columnID = e.target.value; } } }, B().columns.map(c => option(c.id, c.name, draft.columnID)))),
      el('label', {}, el('span', {}, 'Domaine'), el('select', { on: { change: e => { draft.domainID = e.target.value; } } }, B().domains.map(d => option(d.id, d.name, draft.domainID)))),
      !linked && el('label', {}, el('span', {}, 'Échéance'), date),
      !linked && el('label', {}, el('span', {}, 'Répétition'), el('select', { on: { change: e => { draft.recurrence = e.target.value; } } }, Object.entries(REC).map(([k, v]) => option(k, v, draft.recurrence)))),
      !done && el('label', {}, el('span', {}, "Afficher dans Aujourd'hui"), el('input', { type: 'checkbox', checked: draft.today, on: { change: e => { draft.today = e.target.checked; } } }))),
    !linked && el('div', { class: 'jours', role: 'group', 'aria-label': 'Échéance rapide' }, quick("Aujourd'hui", C.today()), quick('Demain', C.addDays(C.today(), 1)), quick('7 jours', C.addDays(C.today(), 7)), quick('Aucune', undefined)),
    el('div', { class: 'champ' }, el('span', {}, 'Sous-tâches'), subs),
    !isNew && (C.canDelete(t) ? el('div', { class: 'groupe' }, remove) : el('p', { class: 'doux' }, 'Une relance se supprime depuis le Mac, qui sait l’écarter du Google Sheet.'))
  ], { left: 'Annuler', right: 'Enregistrer', action: save });
  if (isNew) title.focus();
}

function mover(task) {
  const b = B(), t = C.taskOf(b, task.id);
  if (!t) return;
  const list = C.tasksIn(b, t.columnID, ui.domaines, ui.echeance), i = list.findIndex(x => x.id === t.id), done = C.isDone(b, t);
  const go = f => { close(); store.change(f); };
  open('Déplacer', [
    el('p', {}, t.title),
    el('div', { class: 'groupe' }, b.columns.map(c => el('button', { type: 'button', disabled: c.id === t.columnID, on: { click: () => go(x => C.moveTask(x, t.id, c.id)) } }, el('span', {}, c.name), c.id === t.columnID ? el('span', { class: 'lieu' }, 'Ici') : el('i', { class: 'pastille', color: c.color })))),
    !done && el('div', { class: 'groupe' },
      el('button', { type: 'button', disabled: i <= 0, on: { click: () => go(x => C.moveTask(x, t.id, t.columnID, list[0].id)) } }, 'Tout en haut'),
      el('button', { type: 'button', disabled: i <= 0, on: { click: () => go(x => C.moveTask(x, t.id, t.columnID, list[i - 1].id)) } }, 'Monter'),
      el('button', { type: 'button', disabled: i < 0 || i >= list.length - 1, on: { click: () => go(x => C.moveTask(x, t.id, t.columnID, list[i + 2]?.id ?? null)) } }, 'Descendre'),
      el('button', { type: 'button', on: { click: () => go(x => C.setToday(x, t.id, !t.today)) } }, t.today ? "Retirer d'Aujourd'hui" : "Ajouter à Aujourd'hui"))
  ]);
}

function account() {
  const n = store.pending, s = store.status;
  let sure = false;
  const out = el('button', { type: 'button', class: 'danger', on: { click: async () => {
    if (!sure) { sure = true; out.textContent = n ? `${n} modification${n > 1 ? 's' : ''} non envoyée${n > 1 ? 's' : ''} : toucher encore pour tout effacer ici` : 'Toucher encore pour se déconnecter'; return; }
    close(); await signOut();
  } } }, 'Se déconnecter');
  open('Synchronisation', [
    el('div', { class: 'groupe' },
      el('div', {}, el('span', {}, 'Compte'), el('span', { class: 'lieu' }, store.session?.email ?? 'Déconnecté')),
      el('div', {}, el('span', {}, 'Dernière synchro'), el('span', { class: 'lieu' }, s.last ? new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(s.last) : 'Pas encore')),
      el('div', {}, el('span', {}, 'En attente d’envoi'), el('span', { class: 'lieu' }, String(n)))),
    s.error && el('p', { class: 'erreur' }, s.error),
    el('div', { class: 'groupe' }, el('button', { type: 'button', on: { click: () => { close(); sync(); } } }, 'Synchroniser maintenant'), out),
    el('p', { class: 'doux' }, 'Les tâches sont gardées sur cet appareil et dans ta base en ligne. Se déconnecter les efface d’ici seulement. Les colonnes, domaines et vues se modifient sur le Mac.')
  ]);
}

// --- Affichage -------------------------------------------------------------
function status() {
  const s = store.status, n = store.pending, e = $('etat');
  const off = s.error === 'Hors connexion' || !navigator.onLine;
  e.dataset.e = !store.connected || (s.error && !off) ? 'erreur' : off || n ? 'attente' : 'ok';
  $('etatTexte').textContent = !store.connected ? 'Reconnecte-toi' : store.full ? 'Mémoire pleine' : off ? (n ? `Hors connexion, ${n} en attente` : 'Hors connexion') : s.error ? 'Synchro en panne' : s.busy && (n || !s.last) ? 'Synchro…' : n ? `${n} en attente` : 'À jour';
}
function render() {
  const has = B().columns.length > 0;
  // Session expirée : on garde l'accès aux tâches déjà sur l'appareil.
  const login = !store.connected && !has;
  $('connexion').hidden = !login; $('app').hidden = login;
  if (login) { if (sheet.open) close(); return; }
  status();
  ui.domaines = ui.domaines.filter(d => domain(d));
  const main = $('contenu'), old = $('tableau');
  if (old) { ui.scroll.x = old.scrollLeft; old.querySelectorAll('[data-scroll]').forEach(c => { ui.scroll[c.dataset.scroll] = c.scrollTop; }); ui.scroll.f = main.querySelector('.filtres')?.scrollLeft; } else if (main.firstChild) ui.scroll.y = main.scrollTop;
  $('titre').textContent = ui.vue === 'jour' ? "Aujourd'hui" : 'Kanban';
  $('sousTitre').textContent = ui.vue === 'jour' ? new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date()) : '';
  document.querySelectorAll('[data-vue]').forEach(b => b.dataset.vue === ui.vue ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  $('plus').disabled = !has;
  const label = document.activeElement?.getAttribute?.('aria-label');
  main.replaceChildren(!has ? el('div', { class: 'jour' }, el('p', { class: 'vide' }, store.status.busy ? 'Chargement…' : store.status.error || 'La base est vide. Ouvre Tâches sur le Mac pour l’envoyer.')) : ui.vue === 'jour' ? dayView() : boardView());
  main.style.overflowY = ui.vue === 'kanban' ? 'hidden' : 'auto';
  const now = $('tableau');
  if (now) { now.scrollLeft = ui.scroll.x ?? 0; now.querySelectorAll('[data-scroll]').forEach(c => { c.scrollTop = ui.scroll[c.dataset.scroll] ?? 0; }); const f = main.querySelector('.filtres'); if (f) f.scrollLeft = ui.scroll.f ?? 0; } else main.scrollTop = ui.scroll.y ?? 0;
  if (label && document.activeElement === document.body) [...main.querySelectorAll('[aria-label]')].find(x => x.getAttribute('aria-label') === label)?.focus({ preventScroll: true });
}

let frame = 0;
store.onchange = () => { if (!frame) frame = setTimeout(() => { frame = 0; render(); }, 0); };

document.querySelectorAll('[data-vue]').forEach(b => b.addEventListener('click', () => { ui.vue = b.dataset.vue; pref.set('vue', ui.vue); render(); }));
$('plus').addEventListener('click', () => editor(null));
$('etat').addEventListener('click', () => {
  if (store.connected) return account();
  open('Se reconnecter', [loginForm()]);
});

async function submit(form, error) {
  const f = new FormData(form), b = form.querySelector('button'), password = f.get('password');
  error.hidden = true; b.disabled = true;
  try { await signIn(f.get('email'), password); form.reset(); if (sheet.open) close(); } catch (e) { error.textContent = e.offline ? 'Pas de connexion internet.' : e.message; error.hidden = false; } finally { b.disabled = false; }
}
function loginForm() {
  const error = el('p', { class: 'erreur', role: 'alert', hidden: true });
  const f = el('form', { class: 'fiche', on: { submit: e => { e.preventDefault(); submit(f, error); } } },
    el('label', { class: 'champ' }, el('span', {}, 'E-mail'), el('input', { name: 'email', type: 'email', autocomplete: 'username', required: true })),
    el('label', { class: 'champ' }, el('span', {}, 'Mot de passe'), el('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })), error, el('button', { class: 'plein' }, 'Se connecter'));
  return f;
}
$('formulaire').addEventListener('submit', e => { e.preventDefault(); submit(e.target, $('erreur')); });
addEventListener('offline', () => store.onchange());
let shownDay = C.today();
setInterval(() => { if (C.today() !== shownDay) { shownDay = C.today(); render(); } }, 30000);

if (window.top === window.self) { // jamais dans la page d'un autre site
  render();
  sync();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
