# Swipelist

Private Web-App, mit der Nico seine Spotify-Playlists per Wisch aktuell hält. Diese Datei ist zugleich die Wissensdatei für das Projekt: Auftrag, Entscheidungen, Rahmenbedingungen, Stand und nächste Schritte.

Stand: Version 0.2.0 vom 11.11.2026 (Ausbaustufe 2 von 4). Version 0.1.0 läuft auf Nicos Geräten unter https://nicoheyder.github.io/swipelist/, das Anspielen ist dort noch nicht getestet.

## Was die App heute kann

- Anmeldung bei Spotify ohne Passwort in der App (Verfahren PKCE, kein geheimer Schlüssel).
- Auswahl einer eigenen Playlist. Fremde Playlists fehlen: Den Inhalt abonnierter Playlists sperrt Spotify für private Apps, und gemeinsame Playlists anderer ändert die App bewusst nicht.
- Runde mit 20, 50 oder allen Titeln. Zuerst kommen Titel, die noch nie oder am längsten nicht geprüft wurden.
- Pro Titel: behalten (rechts wischen, Pfeil rechts) oder entfernen (links wischen, Pfeil links). Rückgängig mit dem mittleren Knopf oder Taste Z.
- Nichts wird sofort geändert. Am Ende steht eine Prüfliste, erst die Bestätigung ändert die Playlist.
- Entfernte Titel wandern zuerst in die private Playlist „<Name> Archiv“, erst danach verschwinden sie aus der Playlist.
- Das letzte Entfernen lässt sich zurücknehmen: direkt danach oder bis zu 7 Tage lang in der Playlist-Auswahl, solange kein neues Entfernen dazwischenkommt (nur auf demselben Gerät).
- Eine angefangene Runde und ein unterbrochenes Entfernen überstehen das Schließen des Browsers (nur auf demselben Gerät).
- Anspielen: Jeder Titel startet automatisch bei ca. 35 % seiner Laufzeit (abschaltbar). Abspielknopf auf dem Cover, Leiste zum Springen, Leertaste am PC.
- Selbsttest in den Einstellungen: prüft lesend, welche Spotify-Daten für die nächsten Ausbaustufen verfügbar sind.

## Anspielen: wie es funktioniert

- Zwei Wege, beide nur mit Premium. Am PC spielt die Seite selbst ab (Spotifys Web Playback SDK, die Seite erscheint in Spotify als Gerät „Swipelist“). Am Handy steuert die App die Spotify-App fern (Spotify Connect), die Musik kommt aus der Spotify-App.
- Am Handy muss Spotify geöffnet sein oder im Hintergrund laufen. Ist kein Gerät erreichbar, zeigt die App einen Hinweis und versucht es nicht bei jeder Karte erneut.
- Gerät und Automatik lassen sich über den Knopf unten links auf dem Cover wählen. Ohne Wahl nimmt die App am Handy das Handy, am PC den Browser; als Ausweichgerät nur Computer oder Handy, nie Lautsprecher, Fernseher oder Auto. Ein ausdrücklich gewähltes Gerät wird nie still ersetzt.
- Alle 15 Sekunden und beim Zurückkehren in die App gleicht sie den Stand mit Spotify ab, damit eine Pause in der Spotify-App oder ein Titelende sichtbar wird.
- Die Startstelle ist geschätzt. Spotify gibt keine Daten zur meistgehörten Stelle heraus (Audio-Analyse ist für neue Apps seit 27.11.2024 gesperrt).
- Angespielte Titel landen in „Zuletzt gehört“ und können Spotifys Empfehlungen beeinflussen. Abhilfe: in der Spotify-App eine private Sitzung starten.
- Die vorher laufende Wiedergabe in Spotify wird ersetzt.
- Zugänge aus Version 0.1.0 haben die Abspielrechte noch nicht. Die App erkennt das und bietet „Neu verbinden“ an, die angefangene Runde bleibt erhalten.

## Grenzen von „Rückgängig“

- Die Titel kommen genau dann an ihre alten Plätze zurück, wenn die Playlist seit dem Entfernen unverändert ist und höchstens 100 getrennte Lücken zu füllen sind. Sonst hängt die App sie ans Ende und sagt das auch.
- Titel, die schon wieder in der Playlist stehen, fügt die App nicht doppelt ein. Ein abgebrochener Versuch lässt sich deshalb gefahrlos wiederholen.
- Spotify setzt bei zurückgeholten Titeln das Datum „Hinzugefügt am“ neu. Das lässt sich nicht verhindern.
- Eine eigene Playlist, die genau „<Name> Archiv“ heißt, behandelt die App als Archiv von „<Name>“ und blendet sie in der Auswahl aus.

## Was noch fehlt (Reihenfolge)

1. Vorschläge und Rückkehrer aus dem Archiv in der Rotation (Richtwert: 70 % Playlist, 20 % Vorschläge, 10 % Rückkehrer).
2. Playlist-Generator: wenige Fragen, Künstlerauswahl, Swipe über Vorschläge, neue Playlist.

## Entscheidungen von Nico

- Design B „Karte“: dunkler Grund, Kartenstapel, runde Knöpfe, Blau für Behalten, Orange für Entfernen.
- Nur eigene Playlists bearbeiten.
- Nutzung auf Handy und PC, privat, höchstens fünf Personen.
- Nur Spotify als Datenquelle. Keine Hörproben oder Ähnlichkeitsdaten anderer Dienste (siehe Rahmenbedingungen).
- Archiv als private Playlist in Spotify, nicht als eigene Datenbank.
- Änderungen sammeln und am Ende bestätigen, mit Rückgängig.

## Rahmenbedingungen bei Spotify (geprüft am 11.11.2026)

- Neue Apps laufen im „Development Mode“: Der Besitzer braucht Spotify Premium, höchstens 5 Nutzer pro App.
- Für neue Apps gesperrt: Empfehlungen, ähnliche Künstler, Top-Titel eines Künstlers, 30-Sekunden-Hörproben, Beliebtheitswerte.
- Verfügbar: eigene Playlists lesen und ändern, eigene Top-Titel und Top-Künstler, zuletzt Gehörtes, gespeicherte Titel, Suche (höchstens 10 Treffer pro Abruf), Alben und Albumtitel eines Künstlers, Wiedergabe steuern.
- Playlist-Inhalte laufen über `/playlists/{id}/items` (früher `/tracks`), das Feld heißt `item` (früher `track`).
- Abruf-Kontingent pro Entwicklerkonto, Höhe nicht veröffentlicht. Die App ruft deshalb sparsam ab und speichert zwischen.
- Developer Policy, Abschnitt III.5: keine Verbindung mit „streams or content from another service“. Deshalb kein Deezer und kein Last.fm.

Quellen:
- https://developer.spotify.com/documentation/web-api/references/changes/february-2026
- https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
- https://developer.spotify.com/documentation/web-api/concepts/quota-modes
- https://developer.spotify.com/policy
- https://developer.spotify.com/documentation/web-playback-sdk
- https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback

## Einrichtung in Kurzform

1. Diesen Ordner als öffentliches Repository bei GitHub hochladen und GitHub Pages einschalten (Settings, Pages, „Deploy from a branch“, Branch `main`).
2. Die App unter `https://<nutzername>.github.io/<repository>/` öffnen. Sie zeigt die „Redirect URI“ an.
3. Im Spotify-Entwicklerportal eine App anlegen und genau diese Redirect URI eintragen.
4. Die Client-ID aus dem Portal in der App einfügen und mit Spotify verbinden.

Die Client-ID steht in `config.js`, dann muss sie nicht auf jedem Gerät eingetippt werden. Sie ist kein Passwort.

## Aufbau

| Datei | Aufgabe |
|---|---|
| `index.html` | Grundgerüst und Schutzregel (CSP): nur eigene Skripte und Spotifys Abspiel-Baustein, Abrufe nur an Spotify, Bilder nur von Spotifys Bildservern |
| `app.js` | Oberfläche: Ansichten, Wischen, Prüfliste, Anwenden, Rückgängig, Selbsttest |
| `logic.js` | Reine Logik ohne Netzwerk: Runde, Entscheidungen, Archiv-Zuordnung, Wiederherstellen |
| `spotify.js` | Anmeldung und Abrufe an Spotify, Umgang mit Sperren (429) |
| `player.js` | Anspielen: Browser-Player oder Spotify-Gerät, Reihenfolge der Befehle, Fehlerarten |
| `store.js` | Speicher im Browser: Anmeldung, Zwischenspeicher, angefangene Runde |
| `styles.css` | Gestaltung |
| `config.js` | Optionale feste Client-ID |
| `tests/` | Automatische Tests mit nachgebauter Spotify-Schnittstelle |

Gespeichert wird nur im Browser des jeweiligen Geräts (`localStorage`). Es gibt keinen eigenen Server.

## Sicherheit

- Die Anmeldung (Zugangs- und Erneuerungs-Token) liegt unverschlüsselt im `localStorage`. Das ist bei Web-Apps ohne Server üblich.
- `localStorage` gilt je Herkunft, also für `https://<nutzername>.github.io` insgesamt, nicht nur für den Ordner dieser App. Jede andere Seite, die unter demselben GitHub-Konto veröffentlicht wird, könnte die Anmeldung lesen. Deshalb: unter diesem GitHub-Konto keine fremden oder ungeprüften Seiten veröffentlichen.
- Für das Abspielen im Browser lädt die App Spotifys Skript von `sdk.scdn.co`. Es läuft mit denselben Rechten wie die App und könnte die Anmeldung lesen. Das ist bei jeder Web-App mit Spotifys Player so. Am Handy wird es nicht geladen, solange dort die Spotify-App gewählt ist.
- Spotify verlangt für den Browser-Player die Rechte `user-read-private` und `user-read-email`. Die App liest weder Kontoart noch E-Mail-Adresse aus.
- „Abmelden“ in den Einstellungen löscht die Anmeldung und alle Daten der App auf dem Gerät.
- Die Schutzregel im HTML gilt nur für diese Seite. Ein Schutz gegen das Einbetten in fremde Seiten ist auf GitHub Pages nicht einstellbar.

## Tests

- `node --test tests/logic.test.mjs` prüft die Logik.
- `python3 tests/e2e.py` spielt die ganze App im Browser gegen eine nachgebaute Spotify-Schnittstelle durch (braucht Python mit playwright und Pillow).

Die Tests ersetzen keinen Test mit einem echten Spotify-Konto. Der Nachbau trifft Annahmen über Spotify, die nur der echte Test bestätigt: zum Beispiel die genaue Form der Antworten, die Fehlermeldung bei erschöpftem Kontingent, die Anmeldung als installierte App auf dem Handy und das Verhalten des echten Browser-Players (der Test nutzt einen Nachbau).
