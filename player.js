// Anspielen über Spotify. Zwei Wege, beide brauchen Spotify Premium:
// - „Dieser Browser“: Spotifys Web Playback SDK macht die Seite selbst zu einem Spotify-Gerät (gedacht für den PC).
// - Spotify-Gerät: Die App steuert Spotify auf dem Handy oder PC fern (Spotify Connect), die Musik kommt aus der Spotify-App.
// Die Musik kommt in beiden Fällen von Spotify. Andere Dienste sind nach der Spotify Developer Policy nicht erlaubt.

import * as L from './logic.js?v=0.2.1';
import { store } from './store.js?v=0.2.1';
import * as sp from './spotify.js?v=0.2.1';

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
const SDK_READY_TIMEOUT_MS = 12000;
const LIMIT_PAUSE_MS = 60 * 1000; // nach einer Sperre durch Spotify so lange nicht automatisch anspielen

export const BROWSER = 'browser';
export const DEVICE = 'device';

const TEXTS = {
  scopes: 'Für das Anspielen braucht Swipelist einmal zusätzliche Rechte bei Spotify. Tippe auf „Neu verbinden“.',
  nodevice:
    'Kein Spotify-Gerät erreichbar. Öffne die Spotify-App auf diesem Handy oder deinem PC, starte kurz einen Titel und versuche es dann erneut.',
  nophone:
    'Spotify auf diesem Handy ist gerade nicht erreichbar. Öffne die Spotify-App, starte kurz einen Titel und komm zurück. Ein anderes Gerät wählst du über den Knopf unten links auf dem Cover.',
  premium: 'Abspielen geht nur mit Spotify Premium.',
  unsupported: 'Dieser Browser kann Spotify nicht selbst abspielen. Wähle die Spotify-App als Gerät.',
  browser: 'Der Spotify-Player im Browser reagiert nicht. Versuche es erneut, lade die Seite neu oder wähle über den Knopf unten links die Spotify-App.',
  autoplay: 'Der Browser hat das automatische Abspielen blockiert. Tippe auf Abspielen.',
  restricted: 'Spotify lässt diesen Titel oder dieses Gerät gerade nicht abspielen (403).',
  relogin: 'Die Anmeldung bei Spotify ist abgelaufen. Bitte neu verbinden.',
  limit: 'Spotify begrenzt gerade die Abrufe. Das automatische Anspielen pausiert kurz.',
  network: 'Keine Verbindung zu Spotify.',
};

// Diese Fehler lassen sich nur durch den Nutzer beheben. Bis dahin spielt die App nicht automatisch an.
const BLOCKING = new Set(['scopes', 'nodevice', 'premium', 'unsupported', 'relogin']);

const P = {
  status: 'idle', // idle | starting | playing | paused | error
  uri: null,
  durationMs: 0,
  basePos: 0, // Stelle beim letzten bekannten Stand
  baseAt: 0, // Zeitpunkt dieses Stands
  error: null, // { kind, text, auto }
  seq: 0, // jede neue Aktion erhöht die Zahl; ältere Antworten werden verworfen
  queue: Promise.resolve(), // Befehle an Spotify laufen nacheinander, weil Spotify die Reihenfolge sonst nicht garantiert
  deviceId: null, // gewähltes Spotify-Gerät in dieser Sitzung
  deviceName: '',
  blockedUntil: 0,
  audible: null, // was die App zuletzt nachweislich gestartet hat: { browser, deviceId }
  syncedAt: 0,
  sdk: { state: 'idle', player: null, deviceId: null, promise: null, activated: false, failKind: '', failText: '' },
};

const listeners = new Set();
let errorHandler = null;

// ---------- Einstellungen ----------

function prefs() {
  const saved = store.get('play');
  // target: null = automatisch, BROWSER oder DEVICE = ausdrücklich gewählt (dann gilt deviceId).
  // autoId: zuletzt automatisch genutztes Gerät, nur als Vorrang unter passenden Geräten.
  return { auto: true, target: null, deviceId: null, deviceName: '', autoId: null, ...(saved && typeof saved === 'object' ? saved : {}) };
}

function savePrefs(change) {
  store.set('play', { ...prefs(), ...change });
}

export function isTouch() {
  return window.matchMedia('(pointer: coarse)').matches;
}

export function autoEnabled() {
  return prefs().auto !== false;
}

export function setAuto(on) {
  savePrefs({ auto: Boolean(on) });
  P.blockedUntil = 0;
  emit();
}

/** Gewählter Weg: ausdrücklich gewählt, sonst am Handy die Spotify-App und am PC der Browser. */
export function target() {
  const chosen = prefs().target;
  const wanted = chosen === BROWSER || chosen === DEVICE ? chosen : isTouch() ? DEVICE : BROWSER;
  // Kann der Browser nicht selbst abspielen und wurde das nicht ausdrücklich gewählt, die Spotify-App nehmen.
  if (wanted === BROWSER && !chosen && P.sdk.failKind === 'unsupported') return DEVICE;
  return wanted;
}

/** Wo gerade abgespielt wird, für die Anzeige auf der Karte. */
export function deviceLabel() {
  if (target() === BROWSER) return 'diesem Browser';
  return P.deviceName || (prefs().target === DEVICE ? prefs().deviceName : '') || 'Spotify-App';
}

export function needsReconnect() {
  return L.missingScopes(sp.grantedScopes(), sp.PLAY_SCOPES).length > 0;
}

// ---------- Zustand für die Oberfläche ----------

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** fn(error) wird bei jedem neuen Fehler aufgerufen. error.auto: beim automatischen Anspielen entstanden. */
export function onError(fn) {
  errorHandler = fn;
}

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
  }
}

/** Geschätzte Stelle des laufenden Titels in Millisekunden. */
export function position() {
  if (P.status !== 'playing') return P.basePos;
  const pos = P.basePos + (Date.now() - P.baseAt);
  return P.durationMs ? Math.min(pos, P.durationMs) : pos;
}

export function state() {
  return { status: P.status, uri: P.uri, error: P.error };
}

export function isPlaying(uri) {
  return P.uri === uri && (P.status === 'playing' || P.status === 'starting');
}

function setError(kind, text, auto) {
  P.status = 'error';
  P.error = { kind, text: text || TEXTS[kind] || TEXTS.network, auto: Boolean(auto) };
  if (BLOCKING.has(kind)) P.blockedUntil = Infinity;
  else if (kind === 'limit') P.blockedUntil = Date.now() + LIMIT_PAUSE_MS;
  emit();
  if (errorHandler) errorHandler(P.error);
}

class PlayError extends Error {
  constructor(kind, text) {
    super(text || TEXTS[kind] || kind);
    this.kind = kind;
  }
}

/** Übersetzt einen Fehler von Spotify in eine Fehlerart. */
function classify(err) {
  if (err instanceof PlayError) return err;
  if (err instanceof sp.ApiError) {
    const reason = String(err.reason || '').toUpperCase();
    const message = String(err.message || '');
    if (err.relogin) return new PlayError('relogin');
    if (err.status === 401 || /scope/i.test(message)) return new PlayError('scopes');
    if (err.status === 404 || reason === 'NO_ACTIVE_DEVICE') return new PlayError('nodevice');
    if (reason === 'PREMIUM_REQUIRED' || /premium/i.test(message)) return new PlayError('premium');
    if (err.status === 403) return new PlayError('restricted');
    if (err.status === 429) {
      const wait = L.waitText(err.retryAfter);
      return new PlayError('limit', err.reason === 'QUOTA_EXCEEDED' ? `Das Abruf-Kontingent bei Spotify ist erschöpft.${wait ? ` Erneut möglich in ${wait}.` : ''}` : TEXTS.limit);
    }
    if (err.status === 0) return new PlayError('network', err.message);
    return new PlayError('other', `Spotify meldet beim Abspielen einen Fehler (${err.status}).`);
  }
  return new PlayError('other', (err && err.message) || 'Abspielen nicht möglich.');
}

// ---------- Browser-Player (Web Playback SDK) ----------

function onSdkState(st) {
  if (!st) {
    // Die Wiedergabe läuft jetzt woanders, zum Beispiel weil sie in der Spotify-App übernommen wurde.
    if (target() === BROWSER && (P.status === 'playing' || P.status === 'starting')) {
      P.basePos = position();
      P.status = 'paused';
      emit();
    }
    return;
  }
  if (target() !== BROWSER || P.status === 'starting' || P.status === 'error') return;
  const current = st.track_window && st.track_window.current_track;
  if (current && current.uri && P.uri && current.uri !== P.uri) return; // Nachzügler eines vorigen Titels
  P.basePos = Number(st.position) || 0;
  P.baseAt = Date.now();
  P.status = st.paused ? 'paused' : 'playing';
  emit();
}

/** Trennt den Browser-Player. Beim nächsten Abspielen wird er neu verbunden. */
function resetSdk() {
  const s = P.sdk;
  if (s.player) {
    try {
      s.player.disconnect();
    } catch {
      /* schon getrennt */
    }
  }
  s.player = null;
  s.deviceId = null;
  s.activated = false;
  s.promise = null;
  if (s.state !== 'failed') s.state = 'idle';
}

function ensureSdk() {
  const s = P.sdk;
  if (s.state === 'ready' && s.deviceId) return Promise.resolve(s.deviceId);
  if (s.state === 'failed') return Promise.reject(new PlayError(s.failKind, s.failText));
  if (s.promise) return s.promise;
  s.state = 'loading';
  s.promise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, deviceId) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.promise = null;
      if (err) {
        // Grundsätzliche Gründe gelten bis zum Neuladen, Lade- und Zeitprobleme nur für diesen Versuch.
        s.state = ['unsupported', 'premium', 'scopes'].includes(err.kind) ? 'failed' : 'idle';
        s.failKind = err.kind;
        s.failText = err.message;
        reject(err);
      } else {
        s.state = 'ready';
        s.deviceId = deviceId;
        s.failKind = '';
        resolve(deviceId);
      }
    };
    const timer = setTimeout(() => finish(new PlayError('browser')), SDK_READY_TIMEOUT_MS);
    const create = () => {
      try {
        if (s.player) {
          s.player.disconnect();
          s.player = null;
        }
        const player = new window.Spotify.Player({
          name: 'Swipelist',
          volume: 0.8,
          getOAuthToken: (cb) => {
            sp.accessToken().then(cb, () => cb(''));
          },
        });
        s.player = player;
        s.activated = false;
        player.addListener('ready', ({ device_id: id }) => {
          s.deviceId = id;
          finish(null, id);
        });
        // Fehler nach dem ersten „ready“ gehen an die Oberfläche, davor beenden sie den Startversuch.
        const late = (kind) => {
          if (!settled) finish(new PlayError(kind));
          else if (s.player === player && target() === BROWSER) setError(kind, TEXTS[kind], false);
        };
        player.addListener('not_ready', () => {
          // Verbindung verloren. Beim nächsten Abspielen wird neu verbunden.
          if (s.player === player && s.state === 'ready') {
            s.state = 'idle';
            s.deviceId = null;
          }
        });
        player.addListener('initialization_error', () => late('unsupported'));
        player.addListener('authentication_error', () => late('scopes'));
        player.addListener('account_error', () => late('premium'));
        player.addListener('playback_error', ({ message } = {}) => {
          if (target() === BROWSER && P.status !== 'idle') setError('other', `Spotify meldet beim Abspielen im Browser einen Fehler${message ? ` (${message})` : ''}.`, false);
        });
        player.addListener('autoplay_failed', () => {
          if (target() === BROWSER) setError('autoplay', TEXTS.autoplay, true);
        });
        player.addListener('player_state_changed', onSdkState);
        player.connect().then(
          (ok) => {
            if (!ok) finish(new PlayError('unsupported'));
          },
          () => finish(new PlayError('browser')),
        );
      } catch {
        finish(new PlayError('unsupported'));
      }
    };
    if (window.Spotify && window.Spotify.Player) {
      create();
    } else {
      window.onSpotifyWebPlaybackSDKReady = create;
      if (!document.querySelector(`script[src="${SDK_URL}"]`)) {
        const script = document.createElement('script');
        script.src = SDK_URL;
        script.async = true;
        script.addEventListener('error', () => {
          script.remove();
          finish(new PlayError('browser'));
        });
        document.head.append(script);
      }
    }
  });
  return s.promise;
}

/** Bei einer Berührung oder einem Klick aufrufen: Browser verlangen für Ton eine Nutzeraktion (vor allem Safari). */
export function unlock() {
  const s = P.sdk;
  if (s.player && !s.activated && target() === BROWSER) {
    s.activated = true;
    try {
      const result = s.player.activateElement();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      /* ältere Fassungen kennen activateElement nicht */
    }
  }
}

/** Beim Öffnen des Swipe-Screens: den Browser-Player schon einmal laden, damit das erste Anspielen schneller geht. */
export function prepare() {
  if (target() === BROWSER && !needsReconnect() && P.sdk.state === 'idle') {
    ensureSdk().catch(() => {
      /* der Fehler wird beim ersten Abspielen gemeldet */
    });
  }
}

// ---------- Spotify-Gerät (Connect) ----------

const PHONE_TYPES = new Set(['smartphone', 'tablet']);

async function deviceList() {
  const own = P.sdk.deviceId;
  return (await sp.api.devices()).filter((d) => d.id !== own);
}

/** Geräte, die ohne ausdrückliche Wahl infrage kommen: am Handy nur Handys und Tablets, am PC Computer und notfalls Handys. */
export function autoCandidates(devices, touch) {
  return devices.filter((d) => {
    const type = String(d.type || '').toLowerCase();
    return touch ? PHONE_TYPES.has(type) : type === 'computer' || PHONE_TYPES.has(type);
  });
}

/**
 * Gerät für den nächsten Befehl. Ein ausdrücklich gewähltes Gerät wird nie still durch ein anderes ersetzt.
 * Ohne ausdrückliche Wahl spielt das Handy auf sich selbst und nie auf PC, Lautsprecher, Fernseher oder Auto.
 */
async function resolveDevice(fresh) {
  if (target() === BROWSER) return ensureSdk();
  if (P.deviceId && !fresh) return P.deviceId;
  const pr = prefs();
  const list = await deviceList();
  let device;
  if (pr.target === DEVICE) {
    device = list.find((d) => d.id === pr.deviceId && !d.is_restricted) || null;
    if (!device) {
      throw new PlayError('nodevice', pr.deviceName ? `„${pr.deviceName}“ ist gerade nicht erreichbar. Öffne Spotify dort oder wähle über den Knopf unten links ein anderes Gerät.` : TEXTS.nodevice);
    }
  } else {
    const touch = isTouch();
    device = L.pickDevice(autoCandidates(list, touch), pr.autoId, touch);
    if (!device) throw new PlayError('nodevice', touch ? TEXTS.nophone : TEXTS.nodevice);
    savePrefs({ autoId: device.id });
  }
  P.deviceId = device.id;
  P.deviceName = device.name || '';
  return device.id;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Stale extends Error {}

/**
 * Führt einen Befehl an Spotify aus und gibt die benutzte Gerätekennung zurück.
 * Vor jedem Befehl wird geprüft, ob er inzwischen überholt ist (seq). Ist das Gerät nicht (mehr) bekannt,
 * wird einmal neu aufgelöst; beim Browser-Player wird er dafür neu verbunden.
 */
async function onDevice(seq, command) {
  const fresh = () => {
    if (seq !== null && seq !== P.seq) throw new Stale();
  };
  let deviceId = await resolveDevice(false);
  fresh();
  try {
    await command(deviceId);
    return deviceId;
  } catch (err) {
    if (!(err instanceof sp.ApiError) || err.status !== 404 || err.relogin) throw err;
    if (target() === BROWSER) {
      await sleep(1500); // ein frisch gestarteter Browser-Player ist bei Spotify oft erst nach einem Moment bekannt
      fresh();
      try {
        await command(deviceId);
        return deviceId;
      } catch (again) {
        if (!(again instanceof sp.ApiError) || again.status !== 404) throw again;
        resetSdk();
        deviceId = await resolveDevice(true);
        fresh();
        try {
          await command(deviceId);
          return deviceId;
        } catch (last) {
          if (last instanceof sp.ApiError && last.status === 404) throw new PlayError('browser');
          throw last;
        }
      }
    }
    P.deviceId = null;
    deviceId = await resolveDevice(true);
    fresh();
    await command(deviceId);
    return deviceId;
  }
}

function enqueue(task) {
  const run = P.queue.then(task, task);
  P.queue = run.catch(() => {});
  return run;
}

/** Hält an, was die App zuletzt nachweislich gestartet hat. Läuft in der Warteschlange. */
async function silence() {
  const audible = P.audible;
  if (!audible) return;
  P.audible = null;
  try {
    if (audible.browser) {
      if (P.sdk.player) await P.sdk.player.pause();
    } else {
      await sp.api.pause(audible.deviceId);
    }
  } catch {
    /* läuft schon nicht mehr */
  }
}

// ---------- Steuerung ----------

/**
 * Spielt einen Titel ab einer Stelle. auto: vom automatischen Anspielen ausgelöst
 * (dann unterbleibt es, solange ein Fehler eine Aktion des Nutzers braucht).
 */
export function play(track, positionMs, { auto = false } = {}) {
  if (!track || !track.uri) return Promise.resolve(false);
  if (auto && Date.now() < P.blockedUntil) return Promise.resolve(false);
  if (!auto) P.blockedUntil = 0;
  if (needsReconnect()) {
    P.uri = track.uri;
    setError('scopes', TEXTS.scopes, auto);
    return Promise.resolve(false);
  }
  const seq = ++P.seq;
  const pos = Math.max(0, Math.round(positionMs || 0));
  P.uri = track.uri;
  P.durationMs = track.durationMs || 0;
  P.basePos = pos;
  P.baseAt = Date.now();
  P.status = 'starting';
  P.error = null;
  emit();
  return enqueue(async () => {
    if (seq !== P.seq) return false; // inzwischen überholt
    const browser = target() === BROWSER;
    try {
      const deviceId = await onDevice(seq, (id) => sp.api.play(id, track.uri, pos));
      P.audible = { browser, deviceId };
      if (seq !== P.seq) return false;
      P.basePos = pos;
      P.baseAt = Date.now();
      P.status = 'playing';
      P.syncedAt = Date.now();
      emit();
      return true;
    } catch (err) {
      if (err instanceof Stale || seq !== P.seq) return false;
      // Der vorige Titel soll nicht unbemerkt weiterlaufen, während die Karte einen Fehler zeigt.
      await silence();
      const e = classify(err);
      setError(e.kind, e.message, auto);
      return false;
    }
  });
}

/** Anhalten. Hält auch dann an, wenn die Karte einen Fehler zeigt, aber vorher noch etwas lief. */
export function pause() {
  const active = P.status === 'playing' || P.status === 'starting';
  if (!active && !P.audible) return Promise.resolve();
  P.seq += 1;
  if (active) {
    P.basePos = position();
    P.status = 'paused';
    emit();
  }
  return enqueue(silence);
}

/** Abspielen oder Pause für die Karte. Ein neuer Titel startet an der geschätzten Stelle. */
export function toggle(track) {
  if (isPlaying(track.uri)) return pause();
  const resume = P.uri === track.uri && P.status === 'paused';
  return play(track, resume ? position() : L.startPosition(track.durationMs));
}

/** Springt an eine Stelle. Läuft der Titel noch nicht, startet er dort. */
export function seek(track, positionMs) {
  const pos = Math.max(0, Math.min(Math.round(positionMs), Math.max((track.durationMs || 0) - 1000, 0)));
  if (P.uri !== track.uri || P.status !== 'playing') return play(track, pos);
  const seq = ++P.seq;
  P.basePos = pos;
  P.baseAt = Date.now();
  emit();
  const browser = target() === BROWSER;
  return enqueue(async () => {
    if (seq !== P.seq) return;
    try {
      if (browser && P.sdk.player) await P.sdk.player.seek(pos);
      else await onDevice(seq, (id) => sp.api.seek(id, pos));
    } catch (err) {
      if (err instanceof Stale || seq !== P.seq) return;
      const e = classify(err);
      setError(e.kind, e.message, false);
    }
  });
}

/** Beim Verlassen des Swipe-Screens: anhalten. */
export function stop() {
  pause();
  P.seq += 1;
  if (P.status === 'error') {
    P.status = 'idle';
    P.error = null;
  }
  P.uri = null;
}

/** Beim Abmelden: Browser-Player trennen und alles vergessen. */
export function reset() {
  stop();
  resetSdk();
  P.sdk.state = 'idle';
  P.sdk.failKind = '';
  P.sdk.failText = '';
  P.deviceId = null;
  P.deviceName = '';
  P.audible = null;
  P.blockedUntil = 0;
  P.status = 'idle';
  P.error = null;
}

/**
 * Gleicht mit dem tatsächlichen Stand bei Spotify ab (nur Spotify-Gerät; der Browser-Player meldet sich selbst).
 * Hat jemand in der Spotify-App pausiert, einen anderen Titel gestartet oder ist der Titel zu Ende, zeigt die Karte das.
 */
export async function sync() {
  if (P.status !== 'playing' || target() !== DEVICE || !P.uri) return;
  const seq = P.seq;
  P.syncedAt = Date.now();
  let st;
  try {
    st = await sp.api.playbackState();
  } catch {
    return; // ein fehlgeschlagener Abgleich ändert nichts
  }
  if (seq !== P.seq || P.status !== 'playing') return;
  const item = st && st.item;
  if (!st || !item || item.uri !== P.uri || (st.device && st.device.id && st.device.id !== P.deviceId)) {
    // Läuft nicht mehr oder läuft etwas anderes: nicht mehr unser Titel.
    P.basePos = position();
    P.status = 'paused';
    P.audible = null;
  } else {
    P.basePos = Number(st.progress_ms) || 0;
    P.baseAt = Date.now();
    if (!st.is_playing) P.status = 'paused';
  }
  emit();
}

/** Für die Oberfläche: Zeit seit dem letzten Abgleich. */
export function sinceSync() {
  return Date.now() - (P.syncedAt || 0);
}

// ---------- Geräteauswahl ----------

/** Daten für die Auswahl: Modus, ob der Browser selbst abspielen kann und welche Spotify-Geräte erreichbar sind. */
export async function choices() {
  const browserOk = P.sdk.failKind !== 'unsupported' && P.sdk.failKind !== 'premium';
  let devices = [];
  let error = null;
  try {
    devices = await deviceList();
  } catch (err) {
    error = classify(err).message;
  }
  const pr = prefs();
  return {
    mode: pr.target === BROWSER || pr.target === DEVICE ? pr.target : 'auto',
    selectedId: pr.target === DEVICE ? pr.deviceId : null,
    currentId: target() === DEVICE ? P.deviceId : null,
    touch: isTouch(),
    browser: { available: browserOk, note: browserOk ? '' : P.sdk.failText || TEXTS.unsupported },
    devices,
    error,
  };
}

function afterChoice() {
  P.blockedUntil = 0;
  if (P.status === 'error') {
    P.status = 'idle';
    P.error = null;
  }
  emit();
}

export function chooseAuto() {
  pause();
  savePrefs({ target: null, deviceId: null, deviceName: '' });
  P.deviceId = null;
  P.deviceName = '';
  if (P.sdk.failKind && P.sdk.state !== 'failed') P.sdk.failKind = '';
  afterChoice();
}

export function chooseBrowser() {
  pause();
  savePrefs({ target: BROWSER });
  P.deviceId = null;
  P.deviceName = '';
  if (P.sdk.failKind && P.sdk.state !== 'failed') P.sdk.failKind = '';
  afterChoice();
}

export function chooseDevice(device) {
  pause();
  savePrefs({ target: DEVICE, deviceId: device.id, deviceName: device.name || '' });
  P.deviceId = device.id;
  P.deviceName = device.name || '';
  afterChoice();
}

/** Für Tests und den Selbsttest: Zustand des Browser-Players. */
export function sdkInfo() {
  return { state: P.sdk.state, failKind: P.sdk.failKind };
}
