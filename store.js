// Kleiner Speicher im Browser (localStorage). Bleibt nur auf diesem Gerät.

const PREFIX = 'sw.';
const CACHE_LIMIT = 4; // so viele Playlists bleiben zwischengespeichert

function read(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* Speicher nicht verfügbar */
  }
}

export const store = {
  get: read,
  set: write,
  remove,

  /** Zwischenspeicher für Playlist-Inhalte, damit Spotify seltener abgefragt wird. */
  cacheGet(playlistId) {
    return read(`cache.${playlistId}`);
  },

  cachePut(playlistId, data) {
    const order = (read('cacheOrder') || []).filter((id) => id !== playlistId);
    order.push(playlistId);
    while (order.length > CACHE_LIMIT) remove(`cache.${order.shift()}`);
    if (!write(`cache.${playlistId}`, data)) {
      // Speicher voll: alle Zwischenspeicher leeren und es einmal neu versuchen.
      for (const id of order) remove(`cache.${id}`);
      write(`cache.${playlistId}`, data);
      write('cacheOrder', [playlistId]);
      return;
    }
    write('cacheOrder', order);
  },

  cacheDrop(playlistId) {
    remove(`cache.${playlistId}`);
    write('cacheOrder', (read('cacheOrder') || []).filter((id) => id !== playlistId));
  },

  /**
   * Löscht alles, was zu den Playlists eines Kontos gehört: Zwischenspeicher, angefangene Runde,
   * Prüfverlauf, Archiv-Zuordnung und die Möglichkeit, das letzte Anwenden zurückzunehmen.
   */
  clearUserData() {
    for (const id of read('cacheOrder') || []) remove(`cache.${id}`);
    for (const key of ['me', 'cacheOrder', 'draft', 'archives', 'lastApply']) remove(key);
    try {
      for (let i = localStorage.length - 1; i >= 0; i -= 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(`${PREFIX}seen.`)) localStorage.removeItem(key);
      }
    } catch {
      /* Speicher nicht verfügbar */
    }
  },

  /** Abmelden: Anmeldung und alle Kontodaten auf diesem Gerät löschen. Die Client-ID bleibt. */
  clearAccount() {
    this.clearUserData();
    for (const key of ['auth', 'pending', 'user']) remove(key);
  },
};
