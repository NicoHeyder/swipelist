// Anmeldung bei Spotify (PKCE, ohne Passwort und ohne geheimen Schlüssel) und Zugriff auf die Web API.
// Stand der Schnittstelle: Web API Changelog Februar 2026 (Development Mode).
// Playlist-Inhalte laufen seitdem über /playlists/{id}/items, nicht mehr über /tracks.

import { store } from './store.js?v=0.2.1';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_URL = 'https://api.spotify.com/v1';

// Rechte für das Anspielen: Wiedergabe auf Spotify-Geräten steuern und im Browser abspielen.
// Das Abspielen im Browser (Web Playback SDK) verlangt zusätzlich die Kontodaten-Rechte user-read-private und user-read-email.
export const PLAY_SCOPES = ['user-modify-playback-state', 'streaming', 'user-read-private', 'user-read-email'];

// Was die App bei Spotify darf: eigene Playlists lesen und ändern.
// Nur lesend, für spätere Vorschläge: Hörstatistik, gespeicherte Titel, Abspielgeräte samt Wiedergabestand.
export const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-top-read',
  'user-read-recently-played',
  'user-library-read',
  'user-read-playback-state',
  ...PLAY_SCOPES,
];

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfter = extra.retryAfter || 0;
    this.reason = extra.reason || '';
    this.relogin = Boolean(extra.relogin);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REQUEST_TIMEOUT_MS = 25000;
const PENDING_MAX_AGE_MS = 60 * 60 * 1000; // so lange gilt ein begonnener Anmeldeversuch
const STORAGE_HINT = 'Der Browser-Speicher ist voll oder gesperrt (zum Beispiel im privaten Modus). Ohne ihn kann sich die App die Anmeldung nicht merken.';

/** fetch mit Zeitlimit. Bei Schreibzugriffen ist nach einem Abbruch offen, ob Spotify die Änderung noch ausgeführt hat. */
async function timedFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    throw new ApiError(0, err && err.name === 'AbortError' ? 'Spotify antwortet nicht. Bitte erneut versuchen.' : 'Keine Verbindung zu Spotify.');
  } finally {
    clearTimeout(timer);
  }
}

/** Adresse, zu der Spotify nach der Anmeldung zurückleitet. Muss exakt so im Entwicklerportal stehen. */
export function redirectUri(loc = window.location) {
  let path = loc.pathname.replace(/index\.html$/, '');
  if (!path.endsWith('/')) path += '/';
  return loc.origin + path;
}

function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b & 63]).join('');
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isLoggedIn() {
  const auth = store.get('auth');
  return Boolean(auth && auth.refresh);
}

export function logout() {
  store.clearAccount();
}

/** Schritt 1: zur Spotify-Anmeldung weiterleiten. */
export async function beginLogin(clientId) {
  const verifier = randomString(64);
  const state = randomString(24);
  if (!store.set('pending', { verifier, state, ts: Date.now() })) throw new ApiError(0, STORAGE_HINT);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
    scope: SCOPES.join(' '),
    state,
  });
  window.location.assign(`${AUTH_URL}?${params}`);
}

function saveTokens(data, previous) {
  return store.set('auth', {
    access: data.access_token,
    refresh: data.refresh_token || (previous && previous.refresh) || null,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    // Erteilte Rechte. Fehlt die Angabe in der Antwort, gelten die bisherigen weiter.
    scope: typeof data.scope === 'string' ? data.scope : (previous && previous.scope) || null,
  });
}

/** Die bei der Anmeldung erteilten Rechte (durch Leerzeichen getrennt) oder null, wenn unbekannt. */
export function grantedScopes() {
  const auth = store.get('auth');
  return auth && typeof auth.scope === 'string' ? auth.scope : null;
}

async function tokenRequest(fields) {
  const res = await timedFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* keine lesbare Antwort */
  }
  if (!res.ok || !data || !data.access_token) {
    const detail = (data && (data.error_description || data.error)) || `HTTP ${res.status}`;
    throw new ApiError(res.status, `Anmeldung bei Spotify fehlgeschlagen (${detail}).`, {
      relogin: res.status === 400 || res.status === 401,
    });
  }
  return data;
}

/**
 * Schritt 2: Spotify hat zurückgeleitet. Tauscht den Einmal-Code gegen Zugangs-Token.
 * Gibt true zurück, wenn die Anmeldung geklappt hat.
 */
export async function completeLogin(clientId, params) {
  const pending = store.get('pending');
  store.remove('pending');
  if (params.get('error')) {
    throw new ApiError(0, 'Anmeldung abgebrochen. Spotify hat keinen Zugriff erteilt.');
  }
  const code = params.get('code');
  if (!code) return false;
  if (!pending || pending.state !== params.get('state') || Date.now() - (pending.ts || 0) > PENDING_MAX_AGE_MS) {
    throw new ApiError(0, 'Die Anmeldung ließ sich nicht zuordnen. Bitte erneut verbinden.');
  }
  const data = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: clientId,
    code_verifier: pending.verifier,
  });
  if (!saveTokens(data, null)) throw new ApiError(0, STORAGE_HINT);
  return true;
}

let refreshing = null;

async function refreshTokens() {
  const auth = store.get('auth');
  const clientId = getClientId();
  if (!auth || !auth.refresh || !clientId) {
    throw new ApiError(401, 'Nicht angemeldet.', { relogin: true });
  }
  try {
    const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refresh, client_id: clientId });
    saveTokens(data, auth);
    return data.access_token;
  } catch (err) {
    // Nur bei einer echten Absage von Spotify abmelden, nicht bei fehlender Verbindung.
    if (err.status === 400 || err.status === 401) store.remove('auth');
    throw err;
  }
}

function refresh() {
  if (!refreshing) {
    refreshing = refreshTokens().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

export async function accessToken() {
  const auth = store.get('auth');
  if (!auth || !auth.refresh) throw new ApiError(401, 'Nicht angemeldet.', { relogin: true });
  if (auth.access && auth.expiresAt - Date.now() > 60000) return auth.access;
  return refresh();
}

export function getClientId() {
  const fromConfig = window.SWIPE_CONFIG && typeof window.SWIPE_CONFIG.clientId === 'string' ? window.SWIPE_CONFIG.clientId.trim() : '';
  return fromConfig || store.get('clientId') || '';
}

/** Ein Abruf an die Web API. Erneuert abgelaufene Token und fängt Sperren (429) ab. */
async function request(method, path, { query, body } = {}, attempt = 0) {
  const token = await accessToken();
  const url = new URL(API_URL + path);
  if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));

  const res = await timedFetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && attempt === 0) {
    await refresh();
    return request(method, path, { query, body }, 1);
  }

  let data = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    /* Antwort ohne lesbaren Inhalt */
  }

  const reason = (data && (data.reason || (data.error && data.error.reason))) || '';
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After')) || 0;
    // Kurze Sperren abwarten. Ein erschöpftes Kontingent wird nie automatisch wiederholt.
    // Nennt Spotify keine Wartezeit (oder gibt der Browser sie nicht preis), genau einmal nach 2 Sekunden neu versuchen.
    const wait = retryAfter > 0 ? retryAfter : attempt === 0 ? 2 : 0;
    if (reason !== 'QUOTA_EXCEEDED' && wait > 0 && wait <= 5 && attempt < 2) {
      await sleep((wait + 0.5) * 1000);
      return request(method, path, { query, body }, attempt + 1);
    }
    throw new ApiError(429, 'Spotify begrenzt gerade die Abrufe.', { retryAfter, reason });
  }

  if (!res.ok) {
    const message = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    throw new ApiError(res.status, message, { relogin: res.status === 401, reason });
  }
  return data;
}

/** Holt alle Seiten einer Liste nacheinander (nie parallel, um das Limit zu schonen). */
async function paged(path, pageSize, onProgress) {
  const items = [];
  for (let page = 0; page < 200; page += 1) {
    const data = await request('GET', path, { query: { limit: pageSize, offset: page * pageSize } });
    const batch = (data && data.items) || [];
    items.push(...batch);
    if (onProgress) onProgress(items.length, data && typeof data.total === 'number' ? data.total : null);
    if (!data || !data.next || batch.length === 0) break;
  }
  return items;
}

export const api = {
  me: () => request('GET', '/me'),

  /** Alle Playlists des Nutzers (eigene und abonnierte). */
  async playlists() {
    return (await paged('/me/playlists', 50)).filter(Boolean);
  },

  /** Alle Einträge einer Playlist in ihrer Reihenfolge. Spotify erlaubt das nur für eigene oder gemeinsam bearbeitete Playlists. */
  playlistItems: (playlistId, onProgress) => paged(`/playlists/${encodeURIComponent(playlistId)}/items`, 50, onProgress),

  createPlaylist: (name, description) =>
    request('POST', '/me/playlists', { body: { name, description, public: false } }),

  /** Fügt bis zu 100 Titel hinzu. Ohne position wird hinten angehängt. */
  addItems(playlistId, uris, position) {
    const body = { uris };
    if (Number.isInteger(position)) body.position = position;
    return request('POST', `/playlists/${encodeURIComponent(playlistId)}/items`, { body });
  },

  /** Entfernt bis zu 100 Titel (alle Vorkommen der genannten Titel). */
  removeItems: (playlistId, uris) =>
    request('DELETE', `/playlists/${encodeURIComponent(playlistId)}/items`, {
      body: { items: uris.map((uri) => ({ uri })) },
    }),

  // ----- Wiedergabe (nur mit Premium) -----

  /** Spotify-Geräte, auf denen Spotify gerade geöffnet ist. */
  async devices() {
    const data = await request('GET', '/me/player/devices');
    return ((data && data.devices) || []).filter(Boolean);
  },

  /** Spielt einen Titel ab einer Stelle auf einem bestimmten Gerät. */
  play: (deviceId, uri, positionMs) =>
    request('PUT', '/me/player/play', { query: { device_id: deviceId }, body: { uris: [uri], position_ms: Math.max(0, Math.round(positionMs || 0)) } }),

  /** Aktueller Wiedergabestand (leer, wenn nichts läuft). */
  playbackState: () => request('GET', '/me/player'),

  pause: (deviceId) => request('PUT', '/me/player/pause', { query: { device_id: deviceId } }),

  seek: (deviceId, positionMs) =>
    request('PUT', '/me/player/seek', { query: { device_id: deviceId, position_ms: Math.max(0, Math.round(positionMs)) } }),

  /** Einzelner lesender Abruf, für den Selbsttest. */
  get: (path, query) => request('GET', path, { query }),
};
