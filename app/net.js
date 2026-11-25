// Connexion et échanges avec la base. Tout est gardé sur l'appareil pour fonctionner hors connexion.
import { URL_BASE, CLE } from './config.js';
import * as C from './core.js';

const P = 'taches.', read = k => { try { return JSON.parse(localStorage.getItem(P + k)); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(P + k, JSON.stringify(v)); return true; } catch { return false; } };
const KEYS = ['session', 'tableau', 'synchro'];

export class Besoin extends Error {}

export const store = {
  board: read('tableau') ?? C.emptyBoard(), state: read('synchro'), session: read('session'),
  status: { busy: false, error: '', last: null }, full: false, onchange: () => {},
  save() { this.full = !(write('tableau', this.board) && write('synchro', this.state)); },
  change(fn) { fn(this.board); this.save(); this.onchange(); later(); },
  get pending() { return this.state ? C.changes(this.board, this.state).length : 0; },
  get connected() { return !!this.session; }
};

// Un autre onglet a modifié les données : on repart de ce qui est enregistré.
addEventListener('storage', e => {
  if (e.key && !KEYS.some(k => e.key === P + k)) return;
  store.board = read('tableau') ?? C.emptyBoard(); store.state = read('synchro'); store.session = read('session');
  store.onchange();
});

const locked = (name, fn) => navigator.locks ? navigator.locks.request(P + name, fn) : fn();

async function http(path, { method = 'GET', body, token } = {}) {
  const h = { apikey: CLE, 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const c = new AbortController(), t = setTimeout(() => c.abort(), 20000);
  try {
    const r = await fetch(`${URL_BASE}/${path}`, { method, headers: h, body: body && JSON.stringify(body), signal: c.signal, cache: 'no-store', credentials: 'omit' });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* réponse vide */ }
    return { ok: r.ok, code: r.status, json };
  } catch { throw Object.assign(new Error('Hors connexion'), { offline: true }); } finally { clearTimeout(t); }
}

const keep = j => { store.session = { access: j.access_token, refresh: j.refresh_token, until: Date.now() + (j.expires_in - 60) * 1000, id: j.user.id, email: j.user.email }; write('session', store.session); };

export async function signIn(email, password) {
  const r = await http('auth/v1/token?grant_type=password', { method: 'POST', body: { email: email.trim(), password } });
  if (!r.ok) throw new Error(r.json?.error_code === 'invalid_credentials' ? 'E-mail ou mot de passe incorrect.' : r.code === 429 ? 'Trop d’essais. Attends une minute.' : r.json?.msg ?? `La base a répondu ${r.code}.`);
  keep(r.json);
  if (store.state?.account !== r.json.user.id) { store.board = C.emptyBoard(); store.state = C.newState(r.json.user.id); }
  store.save(); store.status.error = '';
  store.onchange();
  await sync();
}

export async function signOut() {
  const s = store.session;
  store.session = null; store.board = C.emptyBoard(); store.state = null; store.status.last = null; store.status.error = '';
  for (const k of KEYS) localStorage.removeItem(P + k);
  store.onchange();
  if (s) try { await http('auth/v1/logout?scope=local', { method: 'POST', token: s.access }); } catch { /* hors connexion */ }
}

async function bearer() {
  if (!store.session) throw new Besoin();
  if (store.session.until > Date.now()) return store.session.access;
  return locked('jeton', async () => {
    const s = read('session') ?? store.session;
    if (!s) throw new Besoin();
    if (s.until > Date.now()) { store.session = s; return s.access; }
    const r = await http('auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh } });
    if (r.ok) { keep(r.json); return r.json.access_token; }
    if (r.code >= 400 && r.code < 500 && r.code !== 429) {
      store.session = null; localStorage.removeItem(P + 'session');
      throw new Besoin();
    }
    throw new Error(`La base a répondu ${r.code}.`);
  });
}

async function call(path, body) {
  const r = await http(path, { method: body ? 'POST' : 'GET', body, token: await bearer() });
  if (r.ok) return r.json;
  if (r.code === 401 && store.session) { store.session.until = 0; write('session', store.session); }
  throw new Error(r.json?.message ?? `La base a répondu ${r.code}.`);
}

async function pull(cursor) {
  const all = [];
  for (let from = cursor; ;) {
    const page = await call(`rest/v1/taches_items?select=kind,id,data,deleted,rev&rev=gt.${from}&order=rev.asc&limit=500`);
    all.push(...page);
    if (page.length < 500) return all;
    from = page.at(-1).rev;
  }
}

let timer, again = false;
export const later = () => { clearTimeout(timer); timer = setTimeout(sync, 1200); };

export async function sync() {
  if (!store.session || !store.state) return;
  if (store.status.busy) { again = true; return; }
  store.status.busy = true; store.onchange();
  const account = store.state.account, mine = () => store.session && store.state?.account === account;
  try {
    await locked('synchro', async () => {
      for (let n = 0; n < 4; n++) {
        const rows = await pull(store.state.cursor);
        if (!mine()) return;
        store.board = C.applyRows(rows, store.board, store.state);
        store.save();
        const list = C.changes(store.board, store.state);
        if (!list.length) break;
        let conflict = false;
        for (let i = 0; i < list.length; i += 200) {
          const part = list.slice(i, i + 200), acks = await call('rest/v1/rpc/taches_push', { items: part });
          if (!mine()) return;
          conflict = C.confirmPush(part, acks, store.state) || conflict;
          store.save();
        }
        if (!conflict) break;
      }
    });
    store.status.last = Date.now(); store.status.error = '';
  } catch (e) {
    store.status.error = e instanceof Besoin ? 'Reconnecte-toi' : e.offline ? 'Hors connexion' : e.message;
  } finally {
    store.status.busy = false; store.onchange();
    if (again) { again = false; later(); }
  }
}

addEventListener('online', sync);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 30000);
