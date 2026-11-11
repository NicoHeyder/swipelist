import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../logic.js';

const raw = (id, extra = {}) => ({
  added_at: '2026-01-01T00:00:00Z',
  is_local: false,
  item: { id, uri: `spotify:track:${id}`, name: `Titel ${id}`, type: 'track', artists: [{ name: 'A' }, { name: 'B' }],
    album: { name: 'Album', images: [{ url: 'big', width: 640 }, { url: 'mid', width: 300 }, { url: 'small', width: 64 }] },
    duration_ms: 1000, external_ids: { isrc: `ISRC${id}` } },
  ...extra,
});
const id = (t) => (t ? t.uri.split(':').pop() : null);
const pl = (id, name, owner = 'me', extra = {}) => ({ id, name, owner: { id: owner }, collaborative: false, description: null, ...extra });

test('chunk teilt in Pakete', () => {
  assert.deepEqual(L.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(L.chunk([], 100), []);
});

test('pickImage wählt das kleinste ausreichende Bild', () => {
  const imgs = [{ url: 'big', width: 640 }, { url: 'mid', width: 300 }, { url: 'small', width: 64 }];
  assert.equal(L.pickImage(imgs, 500), 'big');
  assert.equal(L.pickImage(imgs, 60), 'small');
  assert.equal(L.pickImage(imgs, 2000), 'big');
  assert.equal(L.pickImage([{ url: 'x', width: null }], 500), 'x');
  assert.equal(L.pickImage(null, 500), null);
  assert.equal(L.pickImage([], 500), null);
});

test('normalizeItems: neues Feld item, altes Feld track, Aussortieren', () => {
  const old = { added_at: null, track: { id: 'o', uri: 'spotify:track:o', name: 'Alt', artists: [], album: {} } };
  const entries = [raw('a'), { item: null }, raw('loc', { is_local: true }),
    { item: { id: 'e', uri: 'spotify:episode:e', name: 'Folge', type: 'episode' } }, old, null];
  const { tracks, skipped } = L.normalizeItems(entries, 10);
  assert.equal(skipped, 4);
  assert.deepEqual(tracks.map((t) => [id(t), t.indexes]), [['a', [10]], ['o', [14]]]);
  assert.equal(tracks[0].image, 'big');
  assert.equal(tracks[0].thumb, 'small');
  assert.equal(tracks[0].durationMs, 1000);
  assert.deepEqual(Object.keys(tracks[0]).sort(), ['artists', 'durationMs', 'image', 'indexes', 'name', 'thumb', 'uri'], 'nur benötigte Felder landen im Zwischenspeicher');
  assert.equal(L.artistText(tracks[0]), 'A, B');
  assert.equal(L.artistText(tracks[1]), 'Unbekannt');
  assert.equal(tracks[1].image, null);
});

test('uniqueByUri merkt sich alle Positionen', () => {
  const { tracks } = L.normalizeItems([raw('a'), raw('b'), raw('a')]);
  const unique = L.uniqueByUri(tracks);
  assert.equal(unique.length, 2);
  assert.deepEqual(unique[0].indexes, [0, 2]);
  assert.deepEqual(tracks[0].indexes, [0], 'Ausgangsliste bleibt unverändert');
});

test('buildDeck: nie geprüfte zuerst, dann älteste Prüfung, Größe begrenzt', () => {
  const { tracks } = L.normalizeItems([raw('a'), raw('b'), raw('c'), raw('d')]);
  const seen = { 'spotify:track:a': 300, 'spotify:track:c': 100 };
  let n = 0;
  const rng = () => [0.9, 0.1, 0.5, 0.2][n++ % 4];
  const deck = L.buildDeck(tracks, seen, 0, rng).map(id);
  // b (0,1) und d (0,2) sind ungeprüft und kommen zuerst, danach c (früher geprüft) vor a
  assert.deepEqual(deck, ['b', 'd', 'c', 'a']);
  n = 0;
  assert.deepEqual(L.buildDeck(tracks, seen, 3, rng).map(id), ['b', 'd', 'c']);
  assert.equal(L.buildDeck(tracks, null, 2).length, 2);
});

test('Runde: entscheiden, zurücknehmen, zählen', () => {
  const { tracks } = L.normalizeItems([raw('a'), raw('b'), raw('c')]);
  const s = L.createSession(pl('p', 'Liste'), tracks);
  assert.equal(id(L.currentCard(s)), 'a');
  assert.equal(id(L.nextCard(s)), 'b');
  L.decide(s, 'remove');
  L.decide(s, 'keep');
  assert.deepEqual(L.counts(s), { total: 3, decided: 2, removed: 1 });
  assert.deepEqual(L.removals(s).map(id), ['a']);
  assert.equal(id(L.undo(s)), 'b');
  assert.equal(id(L.currentCard(s)), 'b');
  assert.equal(s.decisions['spotify:track:b'], undefined);
  L.decide(s, 'remove');
  L.decide(s, 'remove');
  assert.equal(L.currentCard(s), null);
  assert.equal(L.decide(s, 'keep'), null, 'am Ende passiert nichts');
  L.setDecision(s, 'spotify:track:b', 'keep');
  assert.deepEqual(L.removals(s).map(id), ['a', 'c']);
  L.undo(s); L.undo(s); L.undo(s);
  assert.equal(L.undo(s), null);
  assert.equal(s.pos, 0);
});

test('Entwurf speichern und wiederherstellen, auch wenn Titel fehlen', () => {
  const { tracks } = L.normalizeItems([raw('a'), raw('b'), raw('c'), raw('d')]);
  const s = L.createSession(pl('p', 'Liste'), tracks);
  L.decide(s, 'remove'); L.decide(s, 'keep');
  const draft = JSON.parse(JSON.stringify(L.serializeSession(s)));
  assert.deepEqual(Object.keys(draft).sort(), ['decisions', 'history', 'playlistId', 'playlistName', 'uris']);
  const again = L.restoreSession(draft, tracks);
  assert.equal(again.pos, 2);
  assert.deepEqual(again.deck.map(id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(L.removals(again).map(id), ['a']);
  // Titel a und c sind inzwischen nicht mehr in der Playlist
  const fewer = tracks.filter((t) => id(t) !== 'a' && id(t) !== 'c');
  const partial = L.restoreSession(draft, fewer);
  assert.deepEqual(partial.deck.map(id), ['b', 'd']);
  assert.equal(partial.pos, 1);
  assert.deepEqual(partial.history, ['spotify:track:b']);
  assert.equal(L.removals(partial).length, 0);
  assert.equal(L.restoreSession(draft, []).deck.length, 0);
});

test('Playlists: bearbeitbar, Titelzahl, Archiv finden und ausblenden', () => {
  assert.equal(L.isEditable(pl('1', 'X', 'me'), 'me'), true);
  assert.equal(L.isEditable(pl('1', 'X', 'other'), 'me'), false);
  assert.equal(L.isEditable(pl('1', 'X', 'other', { collaborative: true }), 'me'), false, 'gemeinsame Playlists anderer bleiben außen vor');
  assert.equal(L.isEditable(pl('1', 'X', 'me', { collaborative: true }), 'me'), true);
  assert.equal(L.isEditable(pl('1', 'X', 'me'), null), false);
  assert.equal(L.trackCount({ items: { total: 7 } }), 7);
  assert.equal(L.trackCount({ tracks: { total: 3 } }), 3);
  assert.equal(L.trackCount({}), null);

  const src = pl('s', 'Roadtrip');
  const byName = pl('n', 'Roadtrip Archiv');
  const byMark = pl('m', 'Umbenannt', 'me', { description: L.archiveDescription('s') });
  const byStore = pl('st', 'Ganz anders');
  const foreign = pl('f', 'Roadtrip Archiv', 'other');
  assert.equal(L.findArchive([src, foreign], src, 'me'), null);
  assert.equal(L.findArchive([src, byName, foreign], src, 'me').id, 'n');
  assert.equal(L.findArchive([src, byName, byMark], src, 'me').id, 'm');
  assert.equal(L.findArchive([src, byName, byMark, byStore], src, 'me', { s: 'st' }).id, 'st');
  assert.equal(L.findArchive([src, byName], src, 'me', { s: 'weg' }).id, 'n', 'gemerkte, aber gelöschte Zuordnung');
  const encoded = pl('enc', 'Umbenannt', 'me', { description: L.archiveDescription('s').replace(':', '&#x3A;') });
  assert.equal(L.findArchive([src, encoded], src, 'me').id, 'enc', 'Markierung mit umschriebenem Doppelpunkt');
  assert.equal(L.isArchivePlaylist(encoded, [src, encoded], 'me'), true);

  const all = [src, byName, byMark, byStore, pl('x', 'Mein Archiv')];
  assert.equal(L.isArchivePlaylist(byName, all, 'me'), true);
  assert.equal(L.isArchivePlaylist(byMark, all, 'me'), true);
  assert.equal(L.isArchivePlaylist(byStore, all, 'me', { s: 'st' }), true);
  assert.equal(L.isArchivePlaylist(src, all, 'me'), false);
  assert.equal(L.isArchivePlaylist(all[4], all, 'me'), false, '„Mein Archiv“ ohne Playlist „Mein“ bleibt sichtbar');
});

test('restoreRuns stellt die ursprüngliche Reihenfolge exakt wieder her', () => {
  // Playlist mit 12 Einträgen, Titel 2 kommt doppelt vor (Position 2 und 9)
  const ids = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '2', '10', '11'];
  const original = ids.map((id) => `spotify:track:${id}`);
  const unique = L.uniqueByUri(L.normalizeItems(ids.map((id) => raw(id))).tracks);
  const removed = unique.filter((t) => ['2', '3', '7', '11', '0'].includes(id(t)));
  const removedUris = new Set(removed.map((t) => t.uri));
  let list = original.filter((uri) => !removedUris.has(uri));
  const runs = L.restoreRuns(removed);
  assert.deepEqual(runs.map((r) => [r.position, r.uris.length]), [[0, 1], [2, 2], [7, 1], [9, 1], [11, 1]]);
  for (const run of runs) list.splice(run.position, 0, ...run.uris);
  assert.deepEqual(list, original);
});

test('restoreRuns teilt Läufe über 100 Titel', () => {
  const tracks = Array.from({ length: 250 }, (_, i) => ({ uri: `u${i}`, indexes: [i] }));
  const runs = L.restoreRuns(tracks);
  assert.deepEqual(runs.map((r) => [r.position, r.uris.length]), [[0, 100], [100, 100], [200, 50]]);
});

test('sequence und fingerprint: gleicher Stand, gleicher Fingerabdruck', () => {
  const entries = [raw('a'), { item: null }, raw('b'), raw('a'), raw('c')];
  const unique = L.uniqueByUri(L.normalizeItems(entries).tracks);
  const seq = L.sequence(unique, entries.length);
  assert.deepEqual(seq, ['spotify:track:a', '', 'spotify:track:b', 'spotify:track:a', 'spotify:track:c']);
  assert.deepEqual(L.sequenceWithout(seq, ['spotify:track:a']), ['', 'spotify:track:b', 'spotify:track:c']);
  assert.equal(L.fingerprint(seq), L.fingerprint([...seq]));
  assert.notEqual(L.fingerprint(seq), L.fingerprint([...seq].reverse()), 'andere Reihenfolge');
  assert.notEqual(L.fingerprint(seq), L.fingerprint(seq.slice(1)), 'andere Länge');
  assert.match(L.fingerprint([]), /^0:[0-9a-f]+$/);
});

test('planUndo: exakt, ans Ende oder gar nichts', () => {
  const ids = ['0', '1', '2', '3', '4', '2', '6'];
  const unique = L.uniqueByUri(L.normalizeItems(ids.map((x) => raw(x))).tracks);
  const seq = L.sequence(unique, ids.length);
  const removed = unique.filter((t) => ['2', '4'].includes(id(t))).map(L.slimTrack);
  const after = L.sequenceWithout(seq, removed.map((t) => t.uri));
  const print = L.fingerprint(after);

  // Unverändert seit dem Entfernen: exakt zurück an die alten Plätze
  const exact = L.planUndo(removed, after, print);
  assert.equal(exact.mode, 'exact');
  const list = [...after];
  for (const run of exact.runs) list.splice(run.position, 0, ...run.uris);
  assert.deepEqual(list, seq);

  // Inzwischen geändert: fehlende Titel ans Ende, die Dublette zweimal
  const changed = [...after, 'spotify:track:neu'];
  const append = L.planUndo(removed, changed, print);
  assert.equal(append.mode, 'append');
  assert.deepEqual(append.runs, [{ position: null, uris: ['spotify:track:2', 'spotify:track:2', 'spotify:track:4'] }]);

  // Ein Vorkommen ist schon wieder da (zum Beispiel nach einem unklaren Abbruch): nur der Rest fehlt
  const partly = [...after, 'spotify:track:2'];
  assert.deepEqual(L.missingUris(removed, partly), ['spotify:track:2', 'spotify:track:4']);
  assert.equal(L.planUndo(removed, partly, print).mode, 'append');

  // Alles schon wieder da: nichts zu tun
  assert.deepEqual(L.planUndo(removed, seq, print), { mode: 'none', runs: [] });

  // Zu viele Einzelabrufe: lieber gesammelt ans Ende
  assert.equal(L.planUndo(removed, after, print, 1).mode, 'append');
  // Ohne Fingerabdruck (alter Datensatz) nie exakt
  assert.equal(L.planUndo(removed, after, null).mode, 'append');
});

test('slimTrack behält nur, was Anwenden und Rückgängig brauchen', () => {
  const [t] = L.normalizeItems([raw('a')]).tracks;
  assert.deepEqual(L.slimTrack(t), { uri: 'spotify:track:a', name: 'Titel a', artists: ['A', 'B'], thumb: 'small', indexes: [0] });
});

test('Texte: Mehrzahl und Wartezeit', () => {
  assert.equal(L.plural(1, 'Eintrag', 'Einträge'), '1 Eintrag');
  assert.equal(L.plural(3, 'Eintrag', 'Einträge'), '3 Einträge');
  assert.equal(L.waitText(0), '');
  assert.equal(L.waitText(30), 'ca. 30 Sekunden');
  assert.equal(L.waitText(600), 'ca. 10 Minuten');
  assert.equal(L.waitText(61887), 'ca. 17 Stunden');
  assert.equal(L.archiveName('Roadtrip'), 'Roadtrip Archiv');
});
