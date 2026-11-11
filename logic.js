// Reine Logik ohne Browser- und Netzwerkzugriff.
// Alles hier ist mit Beispieldaten testbar (siehe tests/logic.test.mjs).

export const ARCHIVE_SUFFIX = ' Archiv';
export const ARCHIVE_MARK = 'swipelist-archiv:';

/** Teilt eine Liste in Pakete fester Größe (Spotify erlaubt 100 Titel pro Abruf). */
export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Wählt das kleinste Bild, das mindestens minWidth breit ist, sonst das größte. */
export function pickImage(images, minWidth) {
  if (!Array.isArray(images) || images.length === 0) return null;
  const usable = images.filter((img) => img && img.url);
  if (usable.length === 0) return null;
  const sorted = [...usable].sort((a, b) => (b.width || 0) - (a.width || 0));
  const bigEnough = sorted.filter((img) => (img.width || 0) >= minWidth);
  return (bigEnough.length ? bigEnough[bigEnough.length - 1] : sorted[0]).url;
}

/**
 * Macht aus den Roh-Einträgen einer Playlist schlanke Titel-Objekte.
 * Seit Februar 2026 liefert Spotify den Titel im Feld "item" (früher "track").
 * Lokale Dateien, Podcast-Folgen und gelöschte Titel werden übersprungen.
 */
export function normalizeItems(rawEntries, startIndex = 0) {
  const tracks = [];
  let skipped = 0;
  rawEntries.forEach((entry, i) => {
    const t = entry && (entry.item ?? entry.track);
    const uri = t && typeof t.uri === 'string' ? t.uri : '';
    if (!t || entry.is_local || t.is_local || !t.id || !uri.startsWith('spotify:track:')) {
      skipped += 1;
      return;
    }
    const images = t.album && t.album.images;
    tracks.push({
      uri,
      name: t.name || 'Unbekannter Titel',
      artists: (t.artists || []).map((a) => a && a.name).filter(Boolean),
      image: pickImage(images, 500),
      thumb: pickImage(images, 60),
      durationMs: t.duration_ms || 0, // für das spätere Anspielen ab einer geschätzten Stelle
      indexes: [startIndex + i], // Plätze in der Playlist, gezählt ab 0 (Dubletten haben mehrere)
    });
  });
  return { tracks, skipped };
}

/** Fasst doppelte Titel zusammen und merkt sich alle Positionen (für Rückgängig). */
export function uniqueByUri(tracks) {
  const byUri = new Map();
  for (const t of tracks) {
    const known = byUri.get(t.uri);
    if (known) known.indexes.push(...t.indexes);
    else byUri.set(t.uri, { ...t, indexes: [...t.indexes] });
  }
  return [...byUri.values()];
}

export function artistText(track) {
  return track.artists && track.artists.length ? track.artists.join(', ') : 'Unbekannt';
}

/**
 * Stellt eine Runde zusammen: nie geprüfte Titel zuerst (zufällig gemischt),
 * danach die, deren letzte Prüfung am längsten zurückliegt.
 * size <= 0 bedeutet: alle Titel.
 */
export function buildDeck(tracks, seen, size, rng = Math.random) {
  const decorated = tracks.map((t) => ({ t, seen: (seen && seen[t.uri]) || 0, r: rng() }));
  decorated.sort((a, b) => a.seen - b.seen || a.r - b.r);
  const picked = size > 0 ? decorated.slice(0, size) : decorated;
  return picked.map((d) => d.t);
}

// ---------- Runde (Session) ----------

export function createSession(playlist, deck) {
  return {
    playlistId: playlist.id,
    playlistName: playlist.name,
    deck,
    pos: 0,
    decisions: {},
    history: [],
  };
}

export function currentCard(session) {
  return session.deck[session.pos] || null;
}

export function nextCard(session) {
  return session.deck[session.pos + 1] || null;
}

/** action: 'keep' oder 'remove'. Gibt die entschiedene Karte zurück. */
export function decide(session, action) {
  const card = currentCard(session);
  if (!card) return null;
  session.decisions[card.uri] = action;
  session.history.push(card.uri);
  session.pos += 1;
  return card;
}

/** Nimmt die letzte Entscheidung zurück und zeigt die Karte wieder an. */
export function undo(session) {
  if (session.history.length === 0) return null;
  const uri = session.history.pop();
  delete session.decisions[uri];
  session.pos -= 1;
  return session.deck[session.pos] || null;
}

/** Ändert eine Entscheidung nachträglich (Prüfliste vor dem Anwenden). */
export function setDecision(session, uri, action) {
  if (uri in session.decisions) session.decisions[uri] = action;
}

export function removals(session) {
  return session.deck.filter((t) => session.decisions[t.uri] === 'remove');
}

export function counts(session) {
  const decided = session.history.length;
  const removed = removals(session).length;
  return { total: session.deck.length, decided, removed };
}

/** Entwurf für den Browser-Speicher, damit eine Runde ein Neuladen übersteht. */
export function serializeSession(session) {
  return {
    playlistId: session.playlistId,
    playlistName: session.playlistName,
    uris: session.deck.map((t) => t.uri),
    decisions: { ...session.decisions },
    history: [...session.history],
  };
}

/** Baut die Runde aus dem Entwurf und dem aktuellen Stand der Playlist wieder auf. */
export function restoreSession(draft, tracks) {
  const byUri = new Map(tracks.map((t) => [t.uri, t]));
  const history = (draft.history || []).filter((uri) => byUri.has(uri) && draft.decisions[uri]);
  const decided = new Set(history);
  const open = (draft.uris || []).filter((uri) => byUri.has(uri) && !decided.has(uri));
  const decisions = {};
  for (const uri of history) decisions[uri] = draft.decisions[uri];
  return {
    playlistId: draft.playlistId,
    playlistName: draft.playlistName,
    deck: [...history, ...open].map((uri) => byUri.get(uri)),
    pos: history.length,
    decisions,
    history,
  };
}

// ---------- Playlists und Archiv ----------

/** Bearbeitet werden nur Playlists, die dem Nutzer selbst gehören. Gemeinsame Playlists anderer bleiben außen vor. */
export function isEditable(playlist, meId) {
  return Boolean(playlist && meId && playlist.owner && playlist.owner.id === meId);
}

export function trackCount(playlist) {
  const box = playlist.items || playlist.tracks;
  return box && typeof box.total === 'number' ? box.total : null;
}

export function archiveName(name) {
  return `${name}${ARCHIVE_SUFFIX}`;
}

export function archiveDescription(sourceId) {
  return `Von Swipelist entfernte Titel. ${ARCHIVE_MARK}${sourceId}`;
}

/** Spotify liefert Beschreibungen teils mit umschriebenen Sonderzeichen zurück. */
function plainDescription(playlist) {
  return String((playlist && playlist.description) || '').replace(/&#x3a;|&#58;|&colon;/gi, ':');
}

/**
 * Sucht die Archiv-Playlist zu einer Playlist:
 * 1. gemerkte Zuordnung auf diesem Gerät, 2. Markierung in der Beschreibung,
 * 3. gleicher Name mit dem Zusatz " Archiv".
 */
export function findArchive(playlists, source, meId, storedMap = {}) {
  const mine = playlists.filter((p) => p.owner && p.owner.id === meId && p.id !== source.id);
  const storedId = storedMap[source.id];
  return (
    (storedId && mine.find((p) => p.id === storedId)) ||
    mine.find((p) => plainDescription(p).includes(ARCHIVE_MARK + source.id)) ||
    mine.find((p) => p.name === archiveName(source.name)) ||
    null
  );
}

/** Archiv-Playlists werden in der Auswahl ausgeblendet. */
export function isArchivePlaylist(playlist, playlists, meId, storedMap = {}) {
  if (Object.values(storedMap).includes(playlist.id)) return true;
  if (plainDescription(playlist).includes(ARCHIVE_MARK)) return true;
  if (!playlist.name.endsWith(ARCHIVE_SUFFIX)) return false;
  const base = playlist.name.slice(0, -ARCHIVE_SUFFIX.length);
  return playlists.some((p) => p.id !== playlist.id && p.owner && p.owner.id === meId && p.name === base);
}

// ---------- Änderungen anwenden und zurücknehmen ----------

/** Schlanke Fassung eines Titels für gespeicherte Vorgänge (Anwenden, Rückgängig). */
export function slimTrack(track) {
  return { uri: track.uri, name: track.name, artists: track.artists || [], thumb: track.thumb || null, indexes: [...(track.indexes || [])] };
}

/**
 * Reihenfolge der Playlist als Liste von Titel-Adressen.
 * Plätze ohne prüfbaren Titel (lokale Dateien, Podcasts) bleiben leer, zählen aber mit.
 */
export function sequence(tracks, rawTotal) {
  const seq = new Array(rawTotal).fill('');
  for (const t of tracks) for (const index of t.indexes || []) if (index >= 0 && index < rawTotal) seq[index] = t.uri;
  return seq;
}

/** Die Reihenfolge, wie sie nach dem Entfernen der genannten Titel aussieht. */
export function sequenceWithout(seq, uris) {
  const gone = new Set(uris);
  return seq.filter((uri) => !gone.has(uri));
}

/** Kurzer Fingerabdruck einer Reihenfolge. Damit lassen sich zwei Stände vergleichen, ohne die ganze Liste zu speichern. */
export function fingerprint(seq) {
  const text = seq.join('\n');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${seq.length}:${(hash >>> 0).toString(16)}`;
}

/**
 * Plant das Wiedereinfügen an den ursprünglichen Positionen.
 * Aufsteigend eingefügt landet jeder Titel wieder genau an seinem alten Platz.
 * Benachbarte Titel werden zu einem Abruf zusammengefasst.
 */
export function restoreRuns(removedTracks) {
  const slots = [];
  for (const t of removedTracks) for (const index of t.indexes || []) slots.push({ index, uri: t.uri });
  slots.sort((a, b) => a.index - b.index);
  const runs = [];
  for (const slot of slots) {
    const last = runs[runs.length - 1];
    if (last && slot.index === last.position + last.uris.length && last.uris.length < 100) last.uris.push(slot.uri);
    else runs.push({ position: slot.index, uris: [slot.uri] });
  }
  return runs;
}

/** Welche entfernten Titel fehlen in der aktuellen Reihenfolge noch (je fehlendem Vorkommen ein Eintrag)? */
export function missingUris(removedTracks, seqNow) {
  const have = new Map();
  for (const uri of seqNow) if (uri) have.set(uri, (have.get(uri) || 0) + 1);
  const out = [];
  for (const t of removedTracks) {
    const need = Math.max(1, (t.indexes || []).length);
    for (let i = have.get(t.uri) || 0; i < need; i += 1) out.push(t.uri);
  }
  return out;
}

/**
 * Plant das Rückgängigmachen anhand des aktuellen Stands der Playlist:
 * - 'none': alle Titel sind schon wieder da.
 * - 'exact': die Playlist ist seit dem Entfernen unverändert, die Titel kommen an ihre alten Plätze.
 * - 'append': die Playlist wurde inzwischen geändert (oder es wären zu viele Einzelabrufe), fehlende Titel kommen ans Ende.
 */
export function planUndo(removedTracks, seqNow, afterPrint, maxRuns = 100) {
  const missing = missingUris(removedTracks, seqNow);
  if (missing.length === 0) return { mode: 'none', runs: [] };
  if (afterPrint && fingerprint(seqNow) === afterPrint) {
    const runs = restoreRuns(removedTracks);
    if (runs.length <= maxRuns) return { mode: 'exact', runs };
  }
  return { mode: 'append', runs: chunk(missing, 100).map((uris) => ({ position: null, uris })) };
}

// ---------- Texte ----------

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Wartezeit in Worten, z. B. für Sperren durch Spotify. */
export function waitText(seconds) {
  if (!seconds || seconds <= 0) return '';
  if (seconds < 90) return `ca. ${plural(Math.ceil(seconds), 'Sekunde', 'Sekunden')}`;
  if (seconds < 5400) return `ca. ${plural(Math.round(seconds / 60), 'Minute', 'Minuten')}`;
  return `ca. ${plural(Math.round(seconds / 3600), 'Stunde', 'Stunden')}`;
}
