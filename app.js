// Oberfläche der App: Ansichten, Wischen, Prüfliste, Anwenden und Rückgängig.

import * as L from './logic.js';
import { store } from './store.js';
import * as sp from './spotify.js';

const VERSION = '0.1.0';
const ROUND_SIZES = [20, 50, 0]; // 0 = alle
const LIST_MAX_AGE_MS = 10 * 60 * 1000; // danach wird die Playlist-Liste beim Anzeigen neu geholt
const FRESH_MS = 20 * 1000; // vor dem Start einer Runde darf die Liste höchstens so alt sein
const MAX_EXACT_RUNS = 100; // mehr Einzelabrufe macht „Rückgängig“ nicht, dann kommen die Titel ans Ende
const UNDO_KEEP_MS = 7 * 24 * 60 * 60 * 1000; // so lange bleibt „Rückgängig“ für das letzte Anwenden angeboten

const root = document.getElementById('app');
const toastEl = document.getElementById('toast');

const S = {
  view: null,
  me: null,
  playlists: null,
  playlistsAt: 0, // wann die Liste zuletzt geladen wurde
  playlist: null, // gewählte Playlist
  tracks: null, // ihre Titel (ohne Dubletten)
  rawTotal: 0, // Zahl aller Einträge der Playlist, auch der übersprungenen
  session: null, // laufende Runde
  job: null, // begonnenes Anwenden, für einen erneuten Versuch
  animating: false,
};

let storageWarned = false;

const ui = {}; // Elemente des Swipe-Screens, die laufend aktualisiert werden

// ---------- Hilfen für die Oberfläche ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const svg = (size, body) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

// Feste Zeichnungen, keine Nutzerdaten.
const ICONS = {
  back: (s) => svg(s, '<path d="M15 18l-6-6 6-6"></path>'),
  next: (s) => svg(s, '<path d="M9 6l6 6-6 6"></path>'),
  close: (s) => svg(s, '<path d="M18 6L6 18M6 6l12 12"></path>'),
  check: (s) => svg(s, '<path d="M20 6L9 17l-5-5"></path>'),
  undo: (s) => svg(s, '<path d="M9 14L4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"></path>'),
  refresh: (s) => svg(s, '<path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 4v7h-7"></path>'),
  gear: (s) =>
    svg(
      s,
      '<circle cx="12" cy="12" r="3"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"></path>',
    ),
  note: (s) => svg(s, '<path d="M9 18V5l11-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="17" cy="16" r="3"></circle>'),
};

function icon(name, size = 24) {
  const tpl = document.createElement('template');
  tpl.innerHTML = ICONS[name](size);
  return tpl.content.firstChild;
}

/** Kleines Bild in Listen. Lädt es nicht, erscheint das Notensymbol. */
function thumbImg(url) {
  const placeholder = () => h('div', { class: 'row__img' }, icon('note', 24));
  if (!url) return placeholder();
  const img = h('img', { class: 'row__img', src: url, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(placeholder()));
  return img;
}

function whenText(timestamp) {
  return new Date(timestamp).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

let toastTimer = null;
function toast(text, ms = 4000) {
  toastEl.textContent = text;
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), ms);
}

function mount(view, extraClass, ...kids) {
  S.view = view;
  const el = h('section', { class: `view${extraClass ? ` ${extraClass}` : ''}` }, ...kids);
  root.replaceChildren(el);
  window.scrollTo(0, 0);
  return el;
}

/** Ladeansicht. Gibt eine Funktion zurück, mit der sich der Text ändern lässt. */
function mountLoading(text) {
  toastEl.classList.remove('is-on'); // alte Meldungen passen nicht mehr zum neuen Vorgang
  const label = h('div', { text });
  mount('loading', '', h('div', { class: 'loading' }, h('div', { class: 'spinner' }), label));
  return (next) => {
    label.textContent = next;
  };
}

/** Macht aus einem Fehler eine verständliche Meldung. */
function explain(err) {
  if (!(err instanceof sp.ApiError)) return err && err.message ? err.message : 'Unbekannter Fehler.';
  if (err.status === 0) return err.message;
  if (err.status === 429) {
    const wait = L.waitText(err.retryAfter);
    if (err.reason === 'QUOTA_EXCEEDED') {
      return `Das Abruf-Kontingent bei Spotify ist erschöpft. ${wait ? `Erneut möglich in ${wait}.` : 'Bitte später erneut versuchen.'}`;
    }
    return `Zu viele Abrufe bei Spotify. ${wait ? `Bitte ${wait} warten.` : 'Bitte kurz warten.'}`;
  }
  if (err.status === 401) return 'Die Anmeldung ist abgelaufen. Bitte neu verbinden.';
  if (err.status === 403) {
    return 'Spotify verweigert den Zugriff (403). Prüfe, ob dein Premium aktiv ist und ob dein Konto im Entwicklerportal unter „User Management“ eingetragen ist.';
  }
  if (err.status === 404) return 'Spotify findet die Playlist nicht mehr (404).';
  if (err.status >= 500) return `Spotify hat gerade ein Problem (${err.status}). Bitte später erneut versuchen.`;
  return err.message.startsWith('Anmeldung') ? err.message : `Spotify meldet einen Fehler (${err.status}): ${err.message}`;
}

/** Zeigt einen Fehler an. Gibt true zurück, wenn zur Anmeldung gewechselt wurde. */
function fail(err) {
  console.error(err);
  toast(explain(err), 7000);
  if (err && err.relogin) {
    showLogin();
    return true;
  }
  return false;
}

/** Zurück zur Playlist-Auswahl und erst danach die Fehlermeldung zeigen, damit die Ladeansicht sie nicht verdeckt. */
async function backToListWithError(err, note = '') {
  console.error(err);
  if (err && err.relogin) {
    showLogin();
    toast(explain(err), 7000);
    return;
  }
  await showPlaylists();
  toast(`${explain(err)}${note ? ` ${note}` : ''}`, 9000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Kopiert.');
  } catch {
    toast('Kopieren nicht möglich. Bitte von Hand markieren.');
  }
}

/** Dialog am unteren Rand. build(close) liefert den Inhalt, close(wert) schließt. */
function sheet(build) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'sheet' });
    let closed = false;
    const close = (value) => {
      if (closed) return;
      closed = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.append(h('div', { class: 'sheet__body' }, ...build(close)));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close(null);
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close(null);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

function ask({ title, text, yes, no = 'Abbrechen', remove = false }) {
  return sheet((close) => [
    h('h2', { class: 'h2', text: title }),
    text ? h('p', { class: 'lead', text }) : null,
    h(
      'div',
      { class: 'btn-col' },
      h('button', { class: `btn${remove ? ' btn--remove' : ''}`, type: 'button', text: yes, onclick: () => close(true) }),
      h('button', { class: 'btn btn--ghost', type: 'button', text: no, onclick: () => close(false) }),
    ),
  ]).then(Boolean);
}

// ---------- Einrichtung und Anmeldung ----------

function showSetup() {
  const input = h('input', {
    class: 'field',
    id: 'client-id',
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    placeholder: 'Client-ID einfügen',
  });
  const save = async () => {
    const value = input.value.trim();
    if (!/^[0-9a-zA-Z]{20,64}$/.test(value)) {
      toast('Das sieht nicht nach einer Client-ID aus. Sie besteht nur aus Ziffern und Buchstaben, in der Regel 32 Zeichen.');
      return;
    }
    store.set('clientId', value);
    await connect();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') save();
  });
  mount(
    'setup',
    '',
    h('h1', { class: 'h1 mt-24', text: 'Swipelist' }),
    h('p', { class: 'lead mt-8', text: 'Halte deine Spotify-Playlists per Wisch aktuell. Vor dem ersten Start sind zwei Angaben nötig.' }),
    h(
      'div',
      { class: 'box mt-24' },
      h('div', { class: 'box__label', text: '1. Redirect URI' }),
      h('p', { class: 'small', text: 'Trage genau diese Adresse im Spotify-Entwicklerportal bei deiner App als „Redirect URI“ ein.' }),
      h('div', { class: 'mono', text: sp.redirectUri() }),
      h('button', { class: 'btn btn--ghost', type: 'button', text: 'Adresse kopieren', onclick: () => copyText(sp.redirectUri()) }),
    ),
    h(
      'div',
      { class: 'box mt-16' },
      h('label', { class: 'box__label', for: 'client-id', text: '2. Client-ID' }),
      h('p', { class: 'small', text: 'Du findest sie im Entwicklerportal in den Einstellungen deiner App. Sie ist kein Passwort und bleibt in diesem Browser gespeichert.' }),
      input,
    ),
    h('div', { class: 'grow' }),
    h('button', { class: 'btn mt-24', type: 'button', text: 'Speichern und mit Spotify verbinden', onclick: save }),
  );
}

async function connect() {
  try {
    mountLoading('Weiter zu Spotify …');
    await sp.beginLogin(sp.getClientId());
  } catch (err) {
    showLogin();
    toast(`Anmeldung nicht möglich: ${explain(err)}`, 7000);
  }
}

function showLogin() {
  const fromConfig = Boolean(window.SWIPE_CONFIG && window.SWIPE_CONFIG.clientId);
  mount(
    'login',
    '',
    h('h1', { class: 'h1 mt-24', text: 'Swipelist' }),
    h('p', { class: 'lead mt-8', text: 'Verbinde die App mit deinem Spotify-Konto.' }),
    h(
      'p',
      {
        class: 'small mt-16',
        text: 'Die App liest und ändert deine Playlists. Nur lesen darf sie deine Hörstatistik, deine gespeicherten Titel sowie deine Abspielgeräte samt aktuellem Wiedergabestand. Dein Passwort gibst du nur bei Spotify ein, die App sieht es nie.',
      },
    ),
    h('div', { class: 'grow' }),
    h(
      'div',
      { class: 'btn-col mt-24' },
      h('button', { class: 'btn', type: 'button', text: 'Mit Spotify verbinden', onclick: connect }),
      fromConfig ? null : h('button', { class: 'btn btn--text', type: 'button', text: 'Client-ID ändern', onclick: changeClientId }),
    ),
  );
}

const LOGOUT_TEXT =
  'Auf diesem Gerät werden gelöscht: die Anmeldung, der Zwischenspeicher, eine angefangene Runde, der Prüfverlauf (welche Titel du wann geprüft hast) und die Möglichkeit, das letzte Entfernen zurückzunehmen. Deine Playlists bleiben unverändert.';

async function changeClientId() {
  if (sp.isLoggedIn() || store.get('draft') || store.get('lastApply')) {
    const ok = await ask({ title: 'Client-ID ändern?', text: `Du wirst dabei abgemeldet. ${LOGOUT_TEXT}`, yes: 'Abmelden und ändern' });
    if (!ok) return;
  }
  sp.logout();
  store.remove('clientId');
  resetState();
  showSetup();
}

function resetState() {
  S.me = null;
  S.playlists = null;
  S.playlistsAt = 0;
  S.playlist = null;
  S.tracks = null;
  S.rawTotal = 0;
  S.session = null;
  S.job = null;
}

// ---------- Playlist-Auswahl ----------

function errorScreen(err, retry) {
  mount(
    'error',
    '',
    h('h1', { class: 'h1 mt-24', text: 'Das hat nicht geklappt' }),
    h('p', { class: 'lead mt-8', text: explain(err) }),
    h('div', { class: 'grow' }),
    h(
      'div',
      { class: 'btn-col mt-24' },
      h('button', { class: 'btn', type: 'button', text: 'Erneut versuchen', onclick: retry }),
      h('button', { class: 'btn btn--ghost', type: 'button', text: 'Einstellungen', onclick: showSettings }),
    ),
  );
}

/** Holt die Playlist-Liste neu, wenn sie älter als maxAgeMs ist. */
async function freshPlaylists(maxAgeMs) {
  if (!S.playlists || Date.now() - S.playlistsAt > maxAgeMs) {
    S.playlists = await sp.api.playlists();
    S.playlistsAt = Date.now();
  }
  return S.playlists;
}

async function loadMe() {
  if (!S.me) S.me = store.get('me');
  if (S.me) return;
  const me = await sp.api.me();
  // Hat sich ein anderes Konto angemeldet, die Daten des vorigen Kontos von diesem Gerät entfernen.
  const lastUser = store.get('user');
  if (lastUser && lastUser !== me.id) store.clearUserData();
  S.me = { id: me.id, name: me.display_name || me.id };
  store.set('user', me.id);
  store.set('me', S.me);
}

/** Das letzte Anwenden, solange es sich noch zurücknehmen lässt. */
function lastApply() {
  const record = store.get('lastApply');
  if (!record || !Array.isArray(record.removed)) return null;
  if (Date.now() - (record.at || 0) > UNDO_KEEP_MS) {
    store.remove('lastApply');
    return null;
  }
  return record;
}

async function showPlaylists(force = false) {
  if (!S.playlists || force || Date.now() - S.playlistsAt > LIST_MAX_AGE_MS) {
    mountLoading('Playlists werden geladen …');
    try {
      await loadMe();
      await freshPlaylists(0);
    } catch (err) {
      console.error(err);
      if (err && err.relogin) {
        showLogin();
        toast(explain(err), 7000);
      } else {
        errorScreen(err, () => showPlaylists(true));
      }
      return;
    }
  }

  const archives = store.get('archives') || {};
  const editable = S.playlists.filter((p) => L.isEditable(p, S.me.id));
  const visible = editable.filter((p) => !L.isArchivePlaylist(p, S.playlists, S.me.id, archives));
  const foreign = S.playlists.length - editable.length;

  const draft = store.get('draft');
  const draftPlaylist = draft && visible.find((p) => p.id === draft.playlistId);
  let draftBanner = null;
  if (draft && draftPlaylist && (draft.history || []).length > 0) {
    const pending = draft.job && Array.isArray(draft.job.removed);
    draftBanner = h(
      'div',
      { class: 'banner mt-16' },
      h(
        'div',
        null,
        h('div', { class: 'row__title', text: pending ? 'Unterbrochenes Entfernen' : 'Angefangene Runde' }),
        h('div', {
          class: 'row__sub',
          text: pending
            ? `${draftPlaylist.name}: ${L.plural(draft.job.removed.length, 'Titel', 'Titel')} noch nicht vollständig entfernt`
            : `${draftPlaylist.name}: ${draft.history.length} von ${draft.uris.length} geprüft`,
        }),
      ),
      h(
        'div',
        { class: 'banner__actions' },
        h('button', { class: 'btn', type: 'button', text: 'Fortsetzen', onclick: () => resumeDraft(draft) }),
        h('button', {
          class: 'btn btn--ghost',
          type: 'button',
          text: 'Verwerfen',
          onclick: () => {
            store.remove('draft');
            showPlaylists();
          },
        }),
      ),
    );
  }

  const last = lastApply();
  let undoBanner = null;
  if (last) {
    undoBanner = h(
      'div',
      { class: 'banner mt-16' },
      h(
        'div',
        null,
        h('div', { class: 'row__title', text: 'Zuletzt entfernt' }),
        h('div', { class: 'row__sub', text: `${L.plural(last.removed.length, 'Titel', 'Titel')} aus „${last.playlistName}“ am ${whenText(last.at)}` }),
      ),
      h(
        'div',
        { class: 'banner__actions' },
        h('button', { class: 'btn btn--ghost', type: 'button', text: 'Rückgängig', onclick: confirmUndo }),
        h('button', {
          class: 'btn btn--ghost',
          type: 'button',
          text: 'Ausblenden',
          onclick: () => {
            store.remove('lastApply');
            showPlaylists();
          },
        }),
      ),
    );
  }

  const rows = visible.map((p) => {
    const count = L.trackCount(p);
    return h(
      'button',
      { class: 'row', type: 'button', onclick: () => choosePlaylist(p) },
      thumbImg(L.pickImage(p.images, 60)),
      h(
        'div',
        { class: 'row__text' },
        h('div', { class: 'row__title', text: p.name }),
        h('div', { class: 'row__sub', text: count == null ? 'Playlist' : L.plural(count, 'Titel', 'Titel') }),
      ),
      h('div', { class: 'row__end' }, icon('next', 20)),
    );
  });

  mount(
    'playlists',
    '',
    h(
      'div',
      { class: 'pagehead' },
      h('h1', { class: 'h1', text: 'Playlists' }),
      h(
        'div',
        { class: 'banner__actions' },
        h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Playlists neu laden', onclick: () => showPlaylists(true) }, icon('refresh', 20)),
        h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Einstellungen', onclick: showSettings }, icon('gear', 20)),
      ),
    ),
    draftBanner,
    undoBanner,
    rows.length
      ? h('div', { class: 'list mt-16' }, rows)
      : h('p', { class: 'lead mt-24', text: 'Keine eigene Playlist gefunden. Lege in Spotify eine Playlist an und lade diese Ansicht neu.' }),
    foreign > 0
      ? h('p', {
          class: 'small mt-16',
          text: `${L.plural(foreign, 'fremde Playlist fehlt', 'fremde Playlists fehlen')} hier. Den Inhalt abonnierter Playlists sperrt Spotify für private Apps, und gemeinsame Playlists anderer ändert die App bewusst nicht.`,
        })
      : null,
  );
}

async function choosePlaylist(playlist) {
  const count = L.trackCount(playlist);
  let size = store.get('roundSize');
  if (!ROUND_SIZES.includes(size)) size = 20;
  const small = count != null && count <= 20;

  const start = await sheet((close) => {
    const options = ROUND_SIZES.map((value) =>
      h('button', {
        class: 'seg__opt',
        type: 'button',
        'aria-pressed': String(value === size),
        text: value === 0 ? 'Alle' : String(value),
        onclick: (event) => {
          size = value;
          for (const el of event.currentTarget.parentElement.children) el.setAttribute('aria-pressed', String(el === event.currentTarget));
        },
      }),
    );
    return [
      h('div', null, h('h2', { class: 'h2', text: playlist.name }), count == null ? null : h('p', { class: 'small', text: L.plural(count, 'Titel', 'Titel') })),
      small
        ? null
        : h(
            'div',
            { class: 'stack-gap' },
            h('div', { class: 'label', text: 'Wie viele Titel in dieser Runde?' }),
            h('div', { class: 'seg' }, options),
            h('p', { class: 'small', text: 'Zuerst kommen Titel, die du noch nie oder am längsten nicht geprüft hast.' }),
          ),
      h(
        'div',
        { class: 'btn-col' },
        h('button', { class: 'btn', type: 'button', text: 'Runde starten', onclick: () => close(true) }),
        h('button', { class: 'btn btn--text', type: 'button', text: 'Abbrechen', onclick: () => close(false) }),
      ),
    ];
  });
  if (!start) return;

  const draft = store.get('draft');
  if (draft && (draft.history || []).length > 0) {
    const pending = draft.job && Array.isArray(draft.job.removed);
    const ok = await ask({
      title: pending ? 'Unterbrochenes Entfernen verwerfen?' : 'Angefangene Runde verwerfen?',
      text: pending
        ? `In „${draft.playlistName}“ wurde das Entfernen unterbrochen. Eine neue Runde verwirft den Rest. Bereits archivierte Titel bleiben im Archiv.`
        : `In „${draft.playlistName}“ hast du schon ${L.plural(draft.history.length, 'Titel', 'Titel')} geprüft. Eine neue Runde ersetzt diesen Stand.`,
      yes: 'Neue Runde starten',
      remove: true,
    });
    if (!ok) return;
  }
  if (!small) store.set('roundSize', size);
  await startRound(playlist.id, small ? 0 : size);
}

/**
 * Lädt die Titel einer Playlist. Unveränderte Playlists kommen aus dem Zwischenspeicher,
 * erkannt an Spotifys Versionskennung (snapshot_id). force lädt immer frisch.
 */
async function loadTracks(playlist, onProgress, force = false) {
  const cached = force ? null : store.cacheGet(playlist.id);
  if (cached && playlist.snapshot_id && cached.snapshot === playlist.snapshot_id && typeof cached.rawTotal === 'number') return cached;
  const items = await sp.api.playlistItems(playlist.id, onProgress);
  const { tracks, skipped } = L.normalizeItems(items, 0);
  const data = { snapshot: playlist.snapshot_id || null, tracks: L.uniqueByUri(tracks), skipped, rawTotal: items.length };
  store.cachePut(playlist.id, data);
  return data;
}

/** Sucht die Playlist in einer aktuellen Liste. So startet keine Runde auf einem veralteten Stand. */
async function currentPlaylist(playlistId) {
  await freshPlaylists(FRESH_MS);
  return S.playlists.find((p) => p.id === playlistId && L.isEditable(p, S.me.id)) || null;
}

async function startRound(playlistId, size) {
  const status = mountLoading('Titel werden geladen …');
  let playlist;
  let data;
  try {
    playlist = await currentPlaylist(playlistId);
    if (playlist) data = await loadTracks(playlist, (done, total) => status(total ? `Titel werden geladen … ${done} von ${total}` : 'Titel werden geladen …'));
  } catch (err) {
    await backToListWithError(err);
    return;
  }
  if (!playlist) {
    await showPlaylists();
    toast('Diese Playlist gibt es nicht mehr.');
    return;
  }
  if (data.tracks.length === 0) {
    await showPlaylists();
    toast('Diese Playlist enthält keine Titel, die sich prüfen lassen.');
    return;
  }
  S.playlist = playlist;
  S.tracks = data.tracks;
  S.rawTotal = data.rawTotal;
  S.job = null;
  const seen = store.get(`seen.${playlist.id}`) || {};
  S.session = L.createSession(playlist, L.buildDeck(data.tracks, seen, size));
  saveDraft();
  showSwipe();
  if (data.skipped > 0) {
    toast(`${L.plural(data.skipped, 'Eintrag', 'Einträge')} übersprungen (lokale Dateien, Podcasts oder nicht mehr verfügbare Titel).`, 5000);
  }
}

async function resumeDraft(draft) {
  mountLoading('Runde wird fortgesetzt …');
  const pending = draft.job && Array.isArray(draft.job.removed) ? draft.job : null;
  let playlist;
  let data;
  try {
    playlist = await currentPlaylist(draft.playlistId);
    // Nach einem unterbrochenen Entfernen ist der Stand unklar, deshalb frisch laden.
    if (playlist) data = await loadTracks(playlist, null, Boolean(pending));
  } catch (err) {
    await backToListWithError(err);
    return;
  }
  if (!playlist) {
    store.remove('draft');
    await showPlaylists();
    toast('Die Playlist dieser Runde gibt es nicht mehr.');
    return;
  }
  // Titel, die das unterbrochene Entfernen schon aus der Playlist genommen hat, gehören weiter zur Runde.
  const known = new Set(data.tracks.map((t) => t.uri));
  const pool = pending ? [...data.tracks, ...pending.removed.filter((t) => !known.has(t.uri))] : data.tracks;
  const session = L.restoreSession(draft, pool);
  if (session.deck.length === 0) {
    store.remove('draft');
    await showPlaylists();
    toast('Die Titel dieser Runde sind nicht mehr in der Playlist.');
    return;
  }
  S.playlist = playlist;
  S.tracks = data.tracks;
  S.rawTotal = data.rawTotal;
  S.session = session;
  S.job = pending ? { removed: pending.removed, planned: pending.planned || null, wrote: true, afterPrint: pending.afterPrint || null } : null;
  if (S.job || !L.currentCard(session)) showReview();
  else showSwipe();
}

/** Sichert die laufende Runde im Browser. Ein begonnenes Entfernen wird mitgesichert, damit es nach einem Neuladen weitergeht. */
function saveDraft() {
  if (!S.session) return;
  const draft = L.serializeSession(S.session);
  if (S.job && S.job.wrote) draft.job = { removed: S.job.removed, planned: S.job.planned, afterPrint: S.job.afterPrint };
  if (!store.set('draft', draft) && !storageWarned) {
    storageWarned = true;
    toast('Der Browser-Speicher ist voll oder gesperrt. Die Runde läuft weiter, übersteht aber kein Neuladen.', 7000);
  }
}

// ---------- Swipe-Screen ----------

function showSwipe() {
  const s = S.session;
  ui.counter = h('div', { class: 'topbar__sub' });
  ui.doneCount = h('span', { class: 'pill__count' });
  ui.stack = h('div', { class: 'stack' });
  ui.undo = h('button', { class: 'undo', type: 'button', 'aria-label': 'Rückgängig', onclick: pointerBlur(undoLast) }, icon('undo', 22));
  mount(
    'swipe',
    'view--swipe',
    h(
      'div',
      { class: 'topbar' },
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Zur Playlist-Auswahl', onclick: () => showPlaylists() }, icon('back', 22)),
      h('div', { class: 'topbar__center' }, h('div', { class: 'topbar__title', text: s.playlistName }), ui.counter),
      h('button', { class: 'pill', type: 'button', onclick: showReview }, h('span', { text: 'Fertig' }), ui.doneCount),
    ),
    ui.stack,
    h(
      'div',
      { class: 'actions' },
      h(
        'div',
        { class: 'act' },
        h('button', { class: 'act__btn act__btn--remove', type: 'button', 'aria-label': 'Entfernen', onclick: pointerBlur(() => commit('remove')) }, icon('close', 28)),
        h('div', { class: 'act__label', text: 'Entfernen' }),
      ),
      ui.undo,
      h(
        'div',
        { class: 'act' },
        h('button', { class: 'act__btn act__btn--keep', type: 'button', 'aria-label': 'Behalten', onclick: pointerBlur(() => commit('keep')) }, icon('check', 28)),
        h('div', { class: 'act__label', text: 'Behalten' }),
      ),
    ),
    h('p', { class: 'keys', text: '← Entfernen · → Behalten · Z Rückgängig' }),
  );
  refreshSwipe();
}

/** Nach einem Mausklick den Fokus lösen, damit Leertaste oder Eingabetaste danach nicht denselben Knopf noch einmal auslösen. */
function pointerBlur(handler) {
  return (event) => {
    if (event.detail > 0) event.currentTarget.blur();
    handler();
  };
}

function noCover() {
  return h('div', { class: 'card__nocover' }, icon('note', 56));
}

function buildCard(track, top) {
  const cover = h('div', { class: 'card__cover' });
  if (track.image) {
    const img = h('img', { src: track.image, alt: '', draggable: 'false', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(noCover()));
    cover.append(img);
  } else {
    cover.append(noCover());
  }
  if (top) {
    ui.stampKeep = h('div', { class: 'stamp stamp--keep', text: 'Bleibt' });
    ui.stampRemove = h('div', { class: 'stamp stamp--remove', text: 'Raus' });
    cover.append(ui.stampKeep, ui.stampRemove);
  }
  return h(
    'article',
    { class: `card ${top ? 'card--top' : 'card--next'}`, 'aria-hidden': top ? null : 'true', 'aria-label': top ? `${track.name} von ${L.artistText(track)}` : null },
    cover,
    h(
      'div',
      { class: 'card__meta' },
      h('div', { class: 'chip', text: 'In deiner Playlist' }),
      h('div', { class: 'card__title', text: track.name }),
      h('div', { class: 'card__artist', text: L.artistText(track) }),
    ),
  );
}

function refreshSwipe() {
  const s = S.session;
  const card = L.currentCard(s);
  const next = L.nextCard(s);
  const c = L.counts(s);
  const left = s.deck.length - s.pos;

  ui.counter.textContent = `${Math.min(s.pos + 1, c.total)} von ${c.total}`;
  ui.doneCount.textContent = String(c.removed);
  ui.doneCount.hidden = c.removed === 0;
  ui.undo.disabled = s.history.length === 0;

  const layers = [];
  if (left > 2) layers.push(h('div', { class: 'stack__edge stack__edge--back' }));
  if (left > 1) layers.push(h('div', { class: 'stack__edge stack__edge--mid' }));
  if (next) layers.push(buildCard(next, false));
  if (card) {
    ui.top = buildCard(card, true);
    attachDrag(ui.top);
    layers.push(ui.top);
  }
  ui.stack.replaceChildren(...layers);
}

// ----- Wischen -----

function setCardOffset(dx, dy) {
  ui.top.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 22}deg)`;
  const strength = Math.min(Math.abs(dx) / 90, 1);
  ui.stampKeep.style.opacity = dx > 0 ? String(strength) : '0';
  ui.stampRemove.style.opacity = dx < 0 ? String(strength) : '0';
}

function attachDrag(card) {
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let startedAt = 0;

  card.addEventListener('pointerdown', (event) => {
    if (S.animating || pointerId !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    dx = 0;
    startedAt = performance.now();
    try {
      card.setPointerCapture(pointerId);
    } catch {
      /* nicht jeder Zeiger lässt sich festhalten */
    }
    card.classList.remove('is-returning');
    card.classList.add('is-dragging');
  });

  card.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    dx = event.clientX - startX;
    setCardOffset(dx, (event.clientY - startY) * 0.25);
  });

  const release = (event, cancelled) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    card.classList.remove('is-dragging');
    const speed = dx / Math.max(performance.now() - startedAt, 1); // Pixel pro Millisekunde
    const far = Math.abs(dx) > card.offsetWidth * 0.3;
    const flick = Math.abs(speed) > 0.6 && Math.abs(dx) > 40;
    if (!cancelled && (far || flick)) {
      commit(dx > 0 ? 'keep' : 'remove');
    } else {
      card.classList.add('is-returning');
      setCardOffset(0, 0);
    }
  };
  card.addEventListener('pointerup', (event) => release(event, false));
  card.addEventListener('pointercancel', (event) => release(event, true));
}

function flyOut(action) {
  return new Promise((resolve) => {
    const card = ui.top;
    if (!card || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      resolve();
      return;
    }
    const direction = action === 'keep' ? 1 : -1;
    (action === 'keep' ? ui.stampKeep : ui.stampRemove).style.opacity = '1';
    card.classList.remove('is-returning');
    card.classList.add('is-flying');
    card.style.transform = `translate(${direction * (window.innerWidth + card.offsetWidth)}px, 24px) rotate(${direction * 18}deg)`;
    setTimeout(resolve, 250);
  });
}

async function commit(action) {
  const session = S.session;
  if (S.view !== 'swipe' || S.animating || !L.currentCard(session)) return;
  S.animating = true;
  // Die Entscheidung gilt sofort, nicht erst nach der Animation. So geht sie auch bei einem schnellen Wechsel der Ansicht nicht verloren.
  L.decide(session, action);
  saveDraft();
  await flyOut(action);
  S.animating = false;
  if (S.view !== 'swipe' || S.session !== session) return;
  if (L.currentCard(session)) refreshSwipe();
  else showReview();
}

function undoLast() {
  if (S.view !== 'swipe' || S.animating) return;
  if (!L.undo(S.session)) return;
  saveDraft();
  refreshSwipe();
}

document.addEventListener('keydown', (event) => {
  if (S.view !== 'swipe' || document.querySelector('dialog[open]')) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    // Eine gedrückt gehaltene Taste entscheidet nur eine Karte.
    if (!event.repeat) commit(event.key === 'ArrowLeft' ? 'remove' : 'keep');
  } else if (event.key === 'z' || event.key === 'Z' || event.key === 'Backspace') {
    event.preventDefault();
    undoLast();
  }
});

// ---------- Prüfliste ----------

function showReview() {
  const s = S.session;
  const c = L.counts(s);
  const open = c.total - c.decided;
  const listed = S.job ? S.job.removed : L.removals(s);
  const existing = S.playlists && S.me ? L.findArchive(S.playlists, { id: s.playlistId, name: s.playlistName }, S.me.id, store.get('archives') || {}) : null;
  const target = existing ? `die Archiv-Playlist „${existing.name}“` : `die neue private Playlist „${L.archiveName(s.playlistName)}“`;
  const canSwipeOn = open > 0 && !S.job;
  const canRedoLast = open === 0 && c.decided > 0 && !S.job;
  const backLabel = canSwipeOn ? 'Weiter swipen' : 'Letzte Karte noch einmal';
  const backToSwipe = () => {
    if (canRedoLast) {
      L.undo(s);
      saveDraft();
    }
    showSwipe();
  };

  const applyButton = h('button', { class: 'btn btn--remove', type: 'button', onclick: applyChanges });
  const summary = h('p', { class: 'lead mt-16' });
  const update = () => {
    const n = S.job ? S.job.removed.length : L.removals(s).length;
    applyButton.textContent = S.job ? 'Erneut versuchen' : n === 0 ? 'Nichts zu entfernen' : `${L.plural(n, 'Titel', 'Titel')} entfernen`;
    applyButton.disabled = n === 0;
    summary.textContent =
      n === 0
        ? 'Kein Titel ist zum Entfernen markiert.'
        : `${L.plural(n, 'Titel wird', 'Titel werden')} aus der Playlist entfernt und in ${target} verschoben.`;
  };

  const rows = listed.map((track) => {
    const toggle = S.job
      ? null
      : h('button', {
          class: 'row__toggle',
          type: 'button',
          text: 'Behalten',
          onclick: () => {
            const keep = s.decisions[track.uri] === 'remove';
            L.setDecision(s, track.uri, keep ? 'keep' : 'remove');
            row.classList.toggle('is-off', keep);
            toggle.textContent = keep ? 'Entfernen' : 'Behalten';
            toggle.setAttribute('aria-label', `${track.name}: ${keep ? 'doch entfernen' : 'doch behalten'}`);
            saveDraft();
            update();
          },
        });
    if (toggle) toggle.setAttribute('aria-label', `${track.name}: doch behalten`);
    const row = h(
      'div',
      { class: 'row' },
      thumbImg(track.thumb),
      h('div', { class: 'row__text' }, h('div', { class: 'row__title', text: track.name }), h('div', { class: 'row__sub', text: L.artistText(track) })),
      toggle,
    );
    return row;
  });

  mount(
    'review',
    '',
    h(
      'div',
      { class: 'topbar' },
      canSwipeOn || canRedoLast ? h('button', { class: 'iconbtn', type: 'button', 'aria-label': backLabel, onclick: backToSwipe }, icon('back', 22)) : h('span'),
      h(
        'div',
        { class: 'topbar__center' },
        h('div', { class: 'topbar__title', text: 'Änderungen prüfen' }),
        h('div', { class: 'topbar__sub', text: `${c.decided} von ${c.total} geprüft` }),
      ),
      h('span'),
    ),
    S.job
      ? h('p', {
          class: 'lead warn mt-16',
          text: 'Das Entfernen wurde unterbrochen. Es ist nichts verloren gegangen: Titel landen immer erst im Archiv und werden dann entfernt. „Erneut versuchen“ prüft den aktuellen Stand und holt nur das Fehlende nach.',
        })
      : null,
    summary,
    rows.length ? h('div', { class: 'list mt-16' }, rows) : null,
    h('div', { class: 'grow' }),
    h(
      'div',
      { class: 'sticky-foot btn-col' },
      applyButton,
      canSwipeOn || canRedoLast ? h('button', { class: 'btn btn--ghost', type: 'button', text: backLabel, onclick: backToSwipe }) : null,
      S.job
        ? h('button', { class: 'btn btn--text', type: 'button', text: 'Später fortsetzen', onclick: () => showPlaylists() })
        : h('button', { class: 'btn btn--text', type: 'button', text: 'Runde ohne Änderungen beenden', onclick: endWithoutChanges }),
    ),
  );
  update();
}

function markSeen(playlistId, uris, forget = []) {
  const seen = store.get(`seen.${playlistId}`) || {};
  const now = Date.now();
  for (const uri of uris) seen[uri] = now;
  for (const uri of forget) delete seen[uri];
  if (S.tracks) {
    const alive = new Set(S.tracks.map((t) => t.uri));
    for (const uri of Object.keys(seen)) if (!alive.has(uri)) delete seen[uri];
  }
  store.set(`seen.${playlistId}`, seen);
}

async function endWithoutChanges() {
  const s = S.session;
  if (L.removals(s).length > 0) {
    const ok = await ask({
      title: 'Ohne Änderungen beenden?',
      text: 'Die zum Entfernen markierten Titel bleiben in der Playlist.',
      yes: 'Beenden',
    });
    if (!ok) return;
  }
  markSeen(s.playlistId, s.history.filter((uri) => s.decisions[uri] === 'keep'));
  store.remove('draft');
  S.session = null;
  showPlaylists();
}

// ---------- Anwenden und Rückgängig ----------

/** Sucht die Archiv-Playlist in der frisch geladenen Liste oder legt sie an. Liefert auch, welche Titel schon darin liegen. */
async function ensureArchive(playlist, forceReload) {
  const stored = store.get('archives') || {};
  let ref = L.findArchive(S.playlists, playlist, S.me.id, stored);
  let uris = new Set();
  if (ref) {
    const data = await loadTracks(ref, null, forceReload);
    uris = new Set(data.tracks.map((t) => t.uri));
  } else {
    ref = await sp.api.createPlaylist(L.archiveName(playlist.name), L.archiveDescription(playlist.id));
    if (!ref.owner) ref.owner = { id: S.me.id };
    S.playlists.push(ref);
  }
  stored[playlist.id] = ref.id;
  store.set('archives', stored);
  return { ref, uris };
}

function adjustCount(playlist, delta) {
  const box = playlist.items || playlist.tracks;
  if (box && typeof box.total === 'number') box.total = Math.max(0, box.total + delta);
}

/** Zahl der Plätze, die die Titel in der Playlist belegen (Dubletten zählen mehrfach). */
function slotCount(tracks) {
  return tracks.reduce((sum, t) => sum + Math.max(1, (t.indexes || []).length), 0);
}

/** Merkt sich vor dem ersten Schreibzugriff, dass ab jetzt etwas geändert sein kann, auch über ein Neuladen hinweg. */
function markWrote(job) {
  if (job.wrote) return;
  job.wrote = true;
  saveDraft();
}

/**
 * Wendet die Runde an. Reihenfolge mit Absicht: erst ins Archiv, dann aus der Playlist.
 * Jeder Versuch liest zuerst den aktuellen Stand und holt nur das Fehlende nach.
 * Deshalb ist „Erneut versuchen“ auch dann sicher, wenn offen ist, ob ein Abruf noch angekommen war.
 */
async function applyChanges() {
  const session = S.session;
  if (!S.job) {
    const removed = L.removals(session).map(L.slimTrack);
    if (removed.length === 0) return;
    S.job = {
      removed,
      planned: null, // Titel, die diese Runde neu ins Archiv legt (wichtig für Rückgängig)
      wrote: false, // true, sobald der erste Schreibzugriff abgeschickt wurde
      // Erwarteter Stand der Playlist nach dem Entfernen. Daran erkennt „Rückgängig“ später, ob die alten Plätze noch stimmen.
      afterPrint: L.fingerprint(L.sequenceWithout(L.sequence(S.tracks, S.rawTotal), removed.map((t) => t.uri))),
    };
  }
  const job = S.job;
  const uris = job.removed.map((t) => t.uri);
  const status = mountLoading('Archiv wird vorbereitet …');
  let playlist;
  let archive;
  try {
    await freshPlaylists(0); // immer frisch, damit auch ein Archiv gefunden wird, das ein anderes Gerät angelegt hat
    playlist = S.playlists.find((p) => p.id === session.playlistId);
    if (!playlist) throw new sp.ApiError(404, 'Playlist nicht gefunden.');
    archive = await ensureArchive(playlist, job.wrote);
    if (!job.planned) job.planned = uris.filter((uri) => !archive.uris.has(uri));
    for (const part of L.chunk(job.planned.filter((uri) => !archive.uris.has(uri)), 100)) {
      markWrote(job);
      await sp.api.addItems(archive.ref.id, part);
    }
    status('Titel werden entfernt …');
    for (const part of L.chunk(uris, 100)) {
      markWrote(job);
      await sp.api.removeItems(playlist.id, part);
    }
  } catch (err) {
    if (job.wrote) {
      // Stand unklar: Zwischenspeicher verwerfen, der nächste Versuch liest frisch.
      store.cacheDrop(session.playlistId);
      if (archive) store.cacheDrop(archive.ref.id);
    } else {
      S.job = null; // noch nichts geschrieben: die Prüfliste ist wieder frei bearbeitbar
    }
    saveDraft();
    if (!fail(err)) showReview();
    return;
  }

  // Erfolg: Zwischenspeicher verwerfen und die Liste beim nächsten Anzeigen neu holen.
  store.cacheDrop(playlist.id);
  store.cacheDrop(archive.ref.id);
  playlist.snapshot_id = null;
  archive.ref.snapshot_id = null;
  adjustCount(playlist, -slotCount(job.removed));
  adjustCount(archive.ref, job.planned.length);
  S.playlistsAt = 0;
  const gone = new Set(uris);
  if (S.tracks) S.tracks = S.tracks.filter((t) => !gone.has(t.uri));
  markSeen(playlist.id, session.history.filter((uri) => session.decisions[uri] === 'keep'), uris);
  S.tracks = null;
  store.remove('draft');
  const record = {
    playlistId: playlist.id,
    playlistName: playlist.name,
    archiveId: archive.ref.id,
    archiveName: archive.ref.name,
    removed: job.removed,
    archived: job.planned,
    afterPrint: job.afterPrint,
    at: Date.now(),
  };
  store.set('lastApply', record);
  S.job = null;
  S.session = null;
  showResult(record);
}

function showResult(record) {
  const n = record.removed.length;
  mount(
    'result',
    '',
    h('div', { class: 'grow' }),
    h(
      'div',
      { class: 'stack-gap center' },
      h('div', { class: 'result-icon' }, icon('check', 36)),
      h('h1', { class: 'h1', text: `${L.plural(n, 'Titel', 'Titel')} entfernt` }),
      h('p', { class: 'lead', text: `${n === 1 ? 'Er liegt' : 'Sie liegen'} jetzt in der Playlist „${record.archiveName}“.` }),
      h('p', { class: 'small', text: 'Rückgängig geht auch später noch: 7 Tage lang in der Playlist-Auswahl, bis du das nächste Mal Titel entfernst.' }),
    ),
    h('div', { class: 'grow' }),
    h(
      'div',
      { class: 'btn-col mt-24' },
      h('button', {
        class: 'btn',
        type: 'button',
        text: 'Weitere Runde',
        onclick: () => {
          const playlist = (S.playlists || []).find((p) => p.id === record.playlistId);
          if (playlist) choosePlaylist(playlist);
          else showPlaylists();
        },
      }),
      h('button', { class: 'btn btn--ghost', type: 'button', text: 'Zur Playlist-Auswahl', onclick: () => showPlaylists() }),
      h('button', { class: 'btn btn--text', type: 'button', text: 'Rückgängig machen', onclick: () => undoApply(record) }),
    ),
  );
}

async function confirmUndo() {
  const record = lastApply();
  if (!record) {
    showPlaylists();
    return;
  }
  const n = record.removed.length;
  const ok = await ask({
    title: 'Entfernen rückgängig machen?',
    text: `${L.plural(n, 'Titel kommt', 'Titel kommen')} zurück in „${record.playlistName}“.`,
    yes: 'Rückgängig machen',
  });
  if (ok) await undoApply(record);
}

const UNDO_TEXT = {
  exact: 'Rückgängig gemacht. Die Titel stehen wieder an ihren alten Plätzen.',
  append: 'Rückgängig gemacht. Die Titel sind wieder in der Playlist, stehen aber am Ende statt an ihren alten Plätzen.',
  none: 'Die Titel waren schon wieder in der Playlist. Das Archiv ist bereinigt.',
};

/**
 * Nimmt das letzte Anwenden zurück. Liest zuerst den aktuellen Stand der Playlist:
 * Ist sie seit dem Entfernen unverändert, kommen die Titel an ihre alten Plätze, sonst ans Ende.
 * Titel, die schon wieder da sind, werden nicht doppelt eingefügt. Erst danach wird das Archiv bereinigt.
 */
async function undoApply(record) {
  const status = mountLoading('Titel werden zurückgeholt …');
  let mode;
  let playlist;
  try {
    await freshPlaylists(0);
    playlist = S.playlists.find((p) => p.id === record.playlistId);
    if (playlist) {
      const items = await sp.api.playlistItems(playlist.id);
      const seqNow = L.sequence(L.uniqueByUri(L.normalizeItems(items, 0).tracks), items.length);
      const plan = L.planUndo(record.removed, seqNow, record.afterPrint, MAX_EXACT_RUNS);
      mode = plan.mode;
      for (let i = 0; i < plan.runs.length; i += 1) {
        const run = plan.runs[i];
        try {
          await sp.api.addItems(playlist.id, run.uris, run.position);
        } catch (err) {
          if (!(err.status === 400 && run.position != null)) throw err;
          // Die alte Position passt nicht mehr: diesen und alle weiteren Titel hinten anhängen.
          mode = 'append';
          for (const part of L.chunk(plan.runs.slice(i).flatMap((r) => r.uris), 100)) await sp.api.addItems(playlist.id, part);
          break;
        }
      }
      status('Archiv wird bereinigt …');
      if (record.archived.length > 0 && S.playlists.some((p) => p.id === record.archiveId)) {
        for (const part of L.chunk(record.archived, 100)) await sp.api.removeItems(record.archiveId, part);
      }
    }
  } catch (err) {
    // Der Vorgang bleibt gemerkt. Ein neuer Versuch prüft den Stand und fügt nichts doppelt ein.
    store.cacheDrop(record.playlistId);
    store.cacheDrop(record.archiveId);
    S.playlistsAt = 0;
    await backToListWithError(err, 'Das Rückgängigmachen bleibt hier in der Playlist-Auswahl verfügbar.');
    return;
  }

  store.remove('lastApply');
  S.playlistsAt = 0;
  S.tracks = null;
  if (!playlist) {
    await showPlaylists();
    toast(`Die Playlist „${record.playlistName}“ gibt es nicht mehr. Die Titel liegen weiter in „${record.archiveName}“.`, 7000);
    return;
  }
  store.cacheDrop(record.playlistId);
  store.cacheDrop(record.archiveId);
  const seen = store.get(`seen.${record.playlistId}`) || {};
  const now = Date.now();
  for (const t of record.removed) seen[t.uri] = now;
  store.set(`seen.${record.playlistId}`, seen);
  await showPlaylists();
  toast(UNDO_TEXT[mode], 7000);
}

// ---------- Einstellungen und Selbsttest ----------

function showSettings() {
  const fromConfig = Boolean(window.SWIPE_CONFIG && window.SWIPE_CONFIG.clientId);
  const loggedIn = sp.isLoggedIn();
  mount(
    'settings',
    '',
    h(
      'div',
      { class: 'topbar' },
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Zurück', onclick: () => (loggedIn ? showPlaylists() : sp.getClientId() ? showLogin() : showSetup()) }, icon('back', 22)),
      h('div', { class: 'topbar__center' }, h('div', { class: 'topbar__title', text: 'Einstellungen' })),
      h('span'),
    ),
    h(
      'div',
      { class: 'box mt-16' },
      h('div', { class: 'box__label', text: 'Konto' }),
      h('p', { text: loggedIn ? `Angemeldet als ${S.me ? S.me.name : 'Spotify-Nutzer'}` : 'Nicht angemeldet' }),
      loggedIn
        ? h('button', {
            class: 'btn btn--ghost',
            type: 'button',
            text: 'Abmelden',
            onclick: async () => {
              const ok = await ask({ title: 'Abmelden?', text: LOGOUT_TEXT, yes: 'Abmelden' });
              if (!ok) return;
              sp.logout();
              resetState();
              showLogin();
            },
          })
        : null,
    ),
    h(
      'div',
      { class: 'box mt-16' },
      h('div', { class: 'box__label', text: 'Spotify-App' }),
      h('p', { class: 'small', text: 'Redirect URI dieser Installation:' }),
      h('div', { class: 'mono', text: sp.redirectUri() }),
      h('p', { class: 'small', text: 'Client-ID:' }),
      h('div', { class: 'mono', text: sp.getClientId() || 'nicht gesetzt' }),
      fromConfig ? null : h('button', { class: 'btn btn--ghost', type: 'button', text: 'Client-ID ändern', onclick: changeClientId }),
    ),
    h(
      'div',
      { class: 'box mt-16' },
      h('div', { class: 'box__label', text: 'Selbsttest' }),
      h('p', { class: 'small', text: 'Prüft lesend, welche Spotify-Daten für Vorschläge und das Anspielen verfügbar sind. Das Ergebnis hilft beim weiteren Ausbau der App.' }),
      h('button', { class: 'btn btn--ghost', type: 'button', text: 'Selbsttest öffnen', onclick: showDiagnose }),
    ),
    h('p', { class: 'small mt-16', text: `Swipelist ${VERSION}` }),
  );
}

function showDiagnose() {
  const output = h('div', { class: 'mono pre', text: 'Noch nicht gestartet.' });
  const runButton = h('button', { class: 'btn', type: 'button', text: 'Test starten' });
  const copyButton = h('button', { class: 'btn btn--ghost', type: 'button', text: 'Ergebnis kopieren', disabled: true, onclick: () => copyText(output.textContent) });
  runButton.addEventListener('click', async () => {
    runButton.disabled = true;
    copyButton.disabled = true;
    output.textContent = '';
    await runDiagnose((line) => {
      output.textContent += `${output.textContent ? '\n' : ''}${line}`;
    });
    runButton.disabled = false;
    copyButton.disabled = false;
  });
  mount(
    'diagnose',
    '',
    h(
      'div',
      { class: 'topbar' },
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Zurück', onclick: showSettings }, icon('back', 22)),
      h('div', { class: 'topbar__center' }, h('div', { class: 'topbar__title', text: 'Selbsttest' })),
      h('span'),
    ),
    h('p', { class: 'lead mt-16', text: 'Der Test dauert wenige Sekunden und ändert nichts an deinen Playlists.' }),
    h('p', {
      class: 'small mt-8',
      text: 'Das Ergebnis enthält Zahlen, Gerätearten, Datum und Uhrzeit, die Kennung deines Browsers und im Fehlerfall die Meldung von Spotify. Es enthält keine Titel-, Künstler- oder Gerätenamen und keine Kontodaten.',
    }),
    h('div', { class: 'btn-col mt-16' }, runButton, copyButton),
    h('div', { class: 'box mt-16' }, output),
  );
}

/** Prüft lesend, welche Spotify-Daten für Vorschläge und das Anspielen verfügbar sind. Ändert nichts. */
async function runDiagnose(log) {
  const line = (ok, name, detail) => log(`${ok === true ? '[OK]    ' : ok === false ? '[FEHLER]' : '[--]    '} ${name}${detail ? `: ${detail}` : ''}`);
  const message = (err) => (err instanceof sp.ApiError ? `HTTP ${err.status} ${err.reason || err.message}` : (err && err.message) || 'unbekannt');
  const list = (data) => ((data && data.items) || []).filter(Boolean);
  log(`Swipelist ${VERSION}, ${new Date().toLocaleString('de-DE')}`);
  log(`Browser: ${navigator.userAgent}`);

  if (!sp.isLoggedIn()) {
    line(null, 'Spotify', 'übersprungen, nicht angemeldet');
    return;
  }

  const found = { meId: S.me ? S.me.id : null, artist: null, albumId: null };
  const skip = 'übersprungen, kein Künstler aus den vorigen Schritten';
  const checks = [
    ['Konto', async () => {
      const me = await sp.api.get('/me');
      if (me && me.id) found.meId = me.id;
      return [Boolean(me && me.id), me && me.id ? 'erreichbar' : 'Antwort ohne Kennung'];
    }],
    ['Playlists', async () => {
      const items = list(await sp.api.get('/me/playlists', { limit: 50 }));
      const own = items.filter((p) => L.isEditable(p, found.meId)).length;
      const counted = items.filter((p) => L.trackCount(p) != null).length;
      // Bilder lädt die App nur von Spotifys Bildservern. Andere Adressen würden als Platzhalter erscheinen.
      const hosts = new Set();
      for (const p of items) {
        for (const img of Array.isArray(p.images) ? p.images : []) {
          try {
            const host = new URL(img.url).hostname;
            if (!/(^|\.)(scdn\.co|spotifycdn\.com)$/.test(host)) hosts.add(host);
          } catch {
            /* keine gültige Adresse */
          }
        }
      }
      const images = hosts.size === 0 ? 'Bilder von Spotifys Servern' : `Bilder auch von: ${[...hosts].slice(0, 5).join(', ')}`;
      return [items.length > 0, `${own} eigene, ${items.length - own} fremde, Titelzahl bei ${counted} von ${items.length}, ${images}`];
    }],
    ['Top-Künstler', async () => {
      const items = list(await sp.api.get('/me/top/artists', { limit: 10 }));
      if (items[0] && items[0].id) found.artist = { id: items[0].id, name: items[0].name || '' };
      const genres = items.some((a) => Array.isArray(a.genres) && a.genres.length > 0);
      return [items.length > 0, `${items.length} Einträge, Genres ${genres ? 'vorhanden' : 'fehlen'}`];
    }],
    ['Top-Titel', async () => {
      const items = list(await sp.api.get('/me/top/tracks', { limit: 10 }));
      const first = items[0] && items[0].artists && items[0].artists[0];
      if (!found.artist && first && first.id) found.artist = { id: first.id, name: first.name || '' };
      const isrc = items.some((t) => t.external_ids && t.external_ids.isrc);
      return [items.length > 0, `${items.length} Einträge, Titelkennung (ISRC) ${isrc ? 'vorhanden' : 'fehlt'}`];
    }],
    ['Zuletzt gehört', async () => {
      const items = list(await sp.api.get('/me/player/recently-played', { limit: 10 }));
      return [items.length > 0, `${items.length} Einträge`];
    }],
    ['Gespeicherte Titel', async () => {
      const data = await sp.api.get('/me/tracks', { limit: 5 });
      const total = data && typeof data.total === 'number' ? data.total : list(data).length;
      return [total > 0, `${total} insgesamt`];
    }],
    ['Suche nach Titeln eines Künstlers', async () => {
      if (!found.artist || !found.artist.name) return [null, skip];
      const name = found.artist.name.replace(/"/g, '');
      const data = await sp.api.get('/search', { q: `artist:"${name}"`, type: 'track', limit: 10 });
      const count = data && data.tracks ? list(data.tracks).length : 0;
      return [count > 0, `${count} Treffer`];
    }],
    ['Alben eines Künstlers', async () => {
      if (!found.artist) return [null, skip];
      const items = list(await sp.api.get(`/artists/${encodeURIComponent(found.artist.id)}/albums`, { limit: 5 }));
      if (items[0] && items[0].id) found.albumId = items[0].id;
      return [items.length > 0, `${items.length} Einträge`];
    }],
    ['Titel eines Albums', async () => {
      if (!found.albumId) return [null, 'übersprungen, kein Album aus dem vorigen Schritt'];
      const items = list(await sp.api.get(`/albums/${encodeURIComponent(found.albumId)}/tracks`, { limit: 5 }));
      const featured = items.some((t) => Array.isArray(t.artists) && t.artists.length > 1);
      return [items.length > 0, `${items.length} Einträge, Gastkünstler ${featured ? 'vorhanden' : 'in dieser Stichprobe keine'}`];
    }],
    ['Abspielgeräte', async () => {
      const data = await sp.api.get('/me/player/devices');
      const devices = ((data && data.devices) || []).filter(Boolean);
      if (devices.length === 0) return [null, 'keines gefunden (Spotify ist gerade auf keinem Gerät geöffnet)'];
      const kinds = devices.map((d) => `${d.type || 'Gerät'}${d.is_active ? ' (aktiv)' : ''}`).join(', ');
      return [true, `${devices.length}: ${kinds}`];
    }],
  ];
  for (const [name, run] of checks) {
    try {
      const [ok, detail] = await run();
      line(ok, name, detail);
    } catch (err) {
      line(false, name, message(err));
      if (err instanceof sp.ApiError && (err.reason === 'QUOTA_EXCEEDED' || err.relogin)) {
        log('Abgebrochen, weitere Abrufe wären zwecklos.');
        return;
      }
    }
  }
  log('Fertig.');
}

// Kommt die App nach längerer Pause wieder in den Vordergrund, die Playlist-Liste auffrischen.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.view === 'playlists' && !document.querySelector('dialog[open]') && Date.now() - S.playlistsAt > LIST_MAX_AGE_MS) {
    showPlaylists();
  }
});

// ---------- Start ----------

async function init() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('code') || params.has('error')) {
    // Den Einmal-Code sofort aus der Adresszeile entfernen.
    window.history.replaceState(null, '', sp.redirectUri());
    const clientId = sp.getClientId();
    if (clientId) {
      mountLoading('Anmeldung wird abgeschlossen …');
      try {
        await sp.completeLogin(clientId, params);
        store.remove('me');
      } catch (err) {
        console.error(err);
        toast(explain(err), 7000);
      }
    }
  }
  if (!sp.getClientId()) showSetup();
  else if (!sp.isLoggedIn()) showLogin();
  else await showPlaylists();
}

init();
