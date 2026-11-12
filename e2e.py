"""Browser-Test der ganzen App gegen eine nachgebaute Spotify-Schnittstelle.

Aufruf: python3 tests/e2e.py (braucht Python mit playwright und Pillow). Bildschirmfotos landen in tests/shots/.
"""
import json
import os
import subprocess
import sys
import time
from urllib.parse import urlparse, parse_qs

from playwright.sync_api import sync_playwright, expect

from mock import World, APP, CORS, make_png, entry, track_obj, fake_sdk

SHOTS = os.path.join(os.path.dirname(__file__), "shots")
os.makedirs(SHOTS, exist_ok=True)
CLIENT_ID = "0123456789abcdef0123456789abcdef"
results = []
png_cache = {}


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("  ok   " if cond else "  FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


def make_handler(world, auth_log):
    def handle(route, request):
        url = request.url
        try:
            if url.startswith(APP + "/config.js"):
                # Die Tests beginnen mit der Einrichtung, deshalb ohne fest eingetragene Client-ID.
                return route.fulfill(status=200, headers={"Content-Type": "text/javascript"}, body="window.SWIPE_CONFIG = { clientId: '' };")
            if url.startswith(APP):
                return route.continue_()
            if url.startswith("https://accounts.spotify.com/authorize"):
                q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
                auth_log.append(q)
                world.scope = q.get("scope", "")
                return route.fulfill(status=302, headers={"Location": f"{q['redirect_uri']}?code=CODE123&state={q['state']}"})
            if url.startswith("https://accounts.spotify.com/api/token"):
                if request.method == "OPTIONS":
                    return route.fulfill(status=204, headers=CORS)
                status, data = world.token(request.post_data or "")
                return route.fulfill(status=status, headers={**CORS, "Content-Type": "application/json"}, body=json.dumps(data))
            if url.startswith("https://api.spotify.com/v1"):
                status, data, extra = world.spotify(request.method, url, request.headers, request.post_data)
                return route.fulfill(status=status, headers={**CORS, **extra, "Content-Type": "application/json"},
                                     body=json.dumps(data) if data is not None else "")
            if url == "https://sdk.scdn.co/spotify-player.js":
                world.sdk_ready = world.sdk_mode == "ok"
                return route.fulfill(status=200, headers={"Content-Type": "text/javascript"}, body=fake_sdk(world.sdk_mode))
            if url == "https://sdk.scdn.co/embedded/index.html":
                return route.fulfill(status=200, headers={"Content-Type": "text/html"}, body="<!doctype html><title>sdk</title>")
            if url.startswith("https://i.scdn.co/image/"):
                n = url.rsplit("/", 1)[1].split("-")[0]
                if n in world.no_cover:
                    return route.fulfill(status=404, body="")
                if n not in png_cache:
                    png_cache[n] = make_png(int(n))
                return route.fulfill(status=200, headers={"Content-Type": "image/png"}, body=png_cache[n])
            print("  !! unerwarteter Abruf:", request.method, url)
            return route.abort()
        except Exception as exc:  # Fehler im Nachbau sichtbar machen
            print("  !! Fehler im Nachbau:", repr(exc), request.method, url)
            return route.fulfill(status=599, body=str(exc))
    return handle


def new_page(browser, world, auth_log, console, viewport, touch):
    ctx = browser.new_context(viewport=viewport, has_touch=touch, is_mobile=touch, device_scale_factor=2, locale="de-DE")
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=APP)
    ctx.route("**/*", make_handler(world, auth_log))
    page = ctx.new_page()
    page.on("console", lambda m: console.append((m.type, m.text)))
    page.on("pageerror", lambda e: console.append(("pageerror", str(e))))
    return ctx, page


def view(page):
    return page.locator("section.view").get_attribute("class")


def wait_view(page, text):
    page.wait_for_function("t => document.querySelector('section.view') && document.body.innerText.includes(t)", arg=text, timeout=8000)


def title(page):
    return page.locator(".card--top .card__title").inner_text()


def counter(page):
    return page.locator(".topbar__sub").inner_text()


def swipe(page, direction):
    box = page.locator(".card--top").bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    before = counter(page)
    page.mouse.move(x, y)
    page.mouse.down()
    for step in range(1, 9):
        page.mouse.move(x + direction * step * 25, y + step * 2)
        time.sleep(0.01)
    page.mouse.up()
    page.wait_for_function("b => !document.querySelector('.topbar__sub') || document.querySelector('.topbar__sub').innerText !== b", arg=before, timeout=3000)


def press(page, label):
    before = counter(page)
    page.get_by_role("button", name=label, exact=True).click()
    page.wait_for_function("b => !document.querySelector('.topbar__sub') || document.querySelector('.topbar__sub').innerText !== b", arg=before, timeout=3000)


def login(page, world, auth_log):
    page.goto(APP + "/")
    wait_view(page, "Redirect URI")
    check("Einrichtung zeigt die Redirect URI", page.locator(".mono").first.inner_text() == APP + "/")
    page.fill("#client-id", "kurz")
    page.get_by_role("button", name="Speichern und mit Spotify verbinden").click()
    wait_view(page, "Redirect URI")
    check("Ungültige Client-ID wird abgelehnt", "sieht nicht nach einer Client-ID aus" in page.locator("#toast").inner_text())
    page.fill("#client-id", CLIENT_ID)
    page.get_by_role("button", name="Speichern und mit Spotify verbinden").click()
    wait_view(page, "Playlists")
    page.wait_for_selector("button.row")


def play_round(page, playlist, remove, size=None):
    """Spielt eine Runde per Tastatur durch: Titel aus `remove` entfernen, alle anderen behalten. Endet auf der Prüfliste."""
    page.get_by_role("button", name=playlist).click()
    if size:
        page.get_by_role("button", name=size, exact=True).click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    while page.locator(".card--top").count() > 0:
        t = title(page)
        page.keyboard.press("ArrowLeft" if t in remove else "ArrowRight")
        page.wait_for_function("t => !document.querySelector('.card--top') || document.querySelector('.card--top .card__title').innerText !== t", arg=t, timeout=3000)
    wait_view(page, "Änderungen prüfen")


def apply_now(page, n):
    page.get_by_role("button", name=f"{n} Titel entfernen").click()
    wait_view(page, f"{n} Titel entfernt")


def wait_toast(page, text):
    # Nur eine gerade sichtbare Meldung zählt, nicht der Text einer früheren.
    page.wait_for_function("t => { const el = document.querySelector('#toast.is-on'); return Boolean(el) && el.innerText.includes(t); }", arg=text, timeout=15000)


def undo_from_banner(page):
    wait_view(page, "Zuletzt entfernt")
    page.get_by_role("button", name="Rückgängig", exact=True).click()
    page.locator("dialog[open]").get_by_role("button", name="Rückgängig machen").click()


def gym(nums):
    return [f"spotify:track:t{n}" for n in nums]


def run_safety(browser):
    print("\n== Sicherheit beim Anwenden und Rückgängig ==")
    world, auth_log, console = World(), [], []
    ctx, page = new_page(browser, world, auth_log, console, {"width": 390, "height": 844}, True)
    page.emulate_media(reduced_motion="reduce")
    login(page, world, auth_log)
    orig = world.uris("pl3")
    arch = lambda: next(i for i, p in world.playlists.items() if p["name"] == "Gym Archiv")

    def reset_gym():
        world.playlists["pl3"]["entries"] = [entry(track_obj(n)) for n in range(101, 106)]
        world.bump("pl3")
        world.playlists[arch()]["entries"] = []
        world.bump(arch())
        page.evaluate("localStorage.removeItem('sw.lastApply'); localStorage.removeItem('sw.draft')")
        page.reload()
        page.wait_for_selector("button.row")

    # 1. Rückgängig übersteht das Neuladen und stellt exakt wieder her
    play_round(page, "Gym", {"Nachtbus 102", "Nachtbus 104"})
    apply_now(page, 2)
    check("Ergebnis nennt die spätere Rückgängig-Möglichkeit", "Rückgängig geht auch später noch" in page.inner_text("body"))
    page.reload()
    wait_view(page, "Zuletzt entfernt")
    check("Nach Neuladen: Hinweis auf das letzte Entfernen", "2 Titel aus „Gym“" in page.inner_text("body"), page.inner_text("body")[:300])
    page.screenshot(path=f"{SHOTS}/40-undo-banner.png")
    undo_from_banner(page)
    wait_toast(page, "alten Plätzen")
    check("Rückgängig nach Neuladen: Reihenfolge exakt wiederhergestellt", world.uris("pl3") == orig, str(world.uris("pl3")))
    check("Rückgängig nach Neuladen: Archiv leer, Hinweis verschwunden", world.uris(arch()) == [] and "Zuletzt entfernt" not in page.inner_text("body")
          and page.evaluate("localStorage.getItem('sw.lastApply')") is None)

    # 2. Playlist inzwischen anderswo geändert: Titel kommen ans Ende, und die App sagt das
    play_round(page, "Gym", {"Nachtbus 103"})
    apply_now(page, 1)
    world.playlists["pl3"]["entries"].append(entry(track_obj(777)))
    world.bump("pl3")
    page.get_by_role("button", name="Rückgängig machen").click()
    wait_toast(page, "am Ende statt an ihren alten Plätzen")
    check("Geänderte Playlist: Titel ans Ende gehängt, nichts doppelt", world.uris("pl3") == gym([101, 102, 104, 105, 777, 103]), str(world.uris("pl3")))
    reset_gym()

    # 3. Titel ist schon wieder da: nichts wird doppelt eingefügt
    play_round(page, "Gym", {"Nachtbus 105"})
    apply_now(page, 1)
    world.playlists["pl3"]["entries"].append(entry(track_obj(105)))
    world.bump("pl3")
    before = len(world.writes)
    page.get_by_role("button", name="Rückgängig machen").click()
    wait_toast(page, "schon wieder in der Playlist")
    check("Schon vorhandener Titel wird nicht noch einmal eingefügt", [w[0] for w in world.writes[before:]] == ["remove"] and world.uris("pl3").count("spotify:track:t105") == 1
          and world.uris(arch()) == [], str(world.writes[before:]))
    reset_gym()

    # 4. Unklarer Ausgang beim Rückgängig (Änderung kam an, Antwort ging verloren): der zweite Versuch fügt nichts doppelt ein
    play_round(page, "Gym", {"Nachtbus 101", "Nachtbus 104"})
    apply_now(page, 2)
    world.ghost_add = 1
    page.get_by_role("button", name="Rückgängig machen").click()
    wait_toast(page, "Spotify hat gerade ein Problem (504)")
    wait_view(page, "Zuletzt entfernt")
    check("Abbruch beim Rückgängig: Vorgang bleibt angeboten, Archiv unangetastet", sorted(world.uris(arch())) == gym([101, 104]), str(world.uris(arch())))
    undo_from_banner(page)
    wait_toast(page, "Rückgängig gemacht")
    u = world.uris("pl3")
    check("Zweiter Versuch: jeder Titel genau einmal, Archiv leer", sorted(u) == gym([101, 102, 103, 104, 105]) and world.uris(arch()) == [], str(u))
    check("Zweiter Versuch sagt ehrlich, dass Titel am Ende stehen", "am Ende statt an ihren alten Plätzen" in page.locator("#toast").inner_text(), page.locator("#toast").inner_text())
    reset_gym()

    # 5. Unterbrochenes Entfernen übersteht das Neuladen und bleibt gesperrt, bis es abgeschlossen ist
    play_round(page, "Gym", {"Nachtbus 102"})
    world.fail_delete = 1
    page.get_by_role("button", name="1 Titel entfernen").click()
    wait_view(page, "Das Entfernen wurde unterbrochen")
    check("Unterbrochen: Liste ist gesperrt", page.locator(".row__toggle").count() == 0)
    page.get_by_role("button", name="Später fortsetzen").click()
    wait_view(page, "Unterbrochenes Entfernen")
    page.reload()
    wait_view(page, "Unterbrochenes Entfernen")
    check("Unterbrochenes Entfernen wird nach Neuladen angeboten", "Gym: 1 Titel noch nicht vollständig entfernt" in page.inner_text("body"), page.inner_text("body")[:300])
    page.get_by_role("button", name="Fortsetzen").click()
    wait_view(page, "Das Entfernen wurde unterbrochen")
    check("Nach Neuladen weiter gesperrt, Wiederholen angeboten", page.locator(".row__toggle").count() == 0 and page.get_by_role("button", name="Erneut versuchen").is_visible())
    page.get_by_role("button", name="Erneut versuchen").click()
    wait_view(page, "1 Titel entfernt")
    check("Abschluss nach Neuladen: Titel genau einmal im Archiv, aus der Playlist entfernt", world.uris(arch()) == gym([102]) and world.uris("pl3") == gym([101, 103, 104, 105]),
          f"{world.uris(arch())} {world.uris('pl3')}")
    page.get_by_role("button", name="Rückgängig machen").click()
    wait_toast(page, "alten Plätzen")
    check("Rückgängig nach unterbrochenem Entfernen: exakt wiederhergestellt", world.uris("pl3") == orig and world.uris(arch()) == [])

    # 6. Unklarer Ausgang beim Archivieren: der zweite Versuch legt nichts doppelt ins Archiv
    play_round(page, "Gym", {"Nachtbus 103"})
    world.ghost_add = 1
    page.get_by_role("button", name="1 Titel entfernen").click()
    wait_view(page, "Das Entfernen wurde unterbrochen")
    check("Archiv schon befüllt, Playlist noch vollständig", world.uris(arch()) == gym([103]) and world.uris("pl3") == orig)
    page.get_by_role("button", name="Erneut versuchen").click()
    wait_view(page, "1 Titel entfernt")
    check("Zweiter Versuch: Titel nur einmal im Archiv", world.uris(arch()) == gym([103]) and world.uris("pl3") == gym([101, 102, 104, 105]), str(world.uris(arch())))
    page.get_by_role("button", name="Rückgängig machen").click()
    wait_toast(page, "alten Plätzen")

    # 7. Scheitert schon das Archivieren (nichts geschrieben? unklar), bleibt die Playlist unberührt
    play_round(page, "Gym", {"Nachtbus 101"})
    world.fail_add = 1
    page.get_by_role("button", name="1 Titel entfernen").click()
    wait_view(page, "Das Entfernen wurde unterbrochen")
    check("Fehler beim Archivieren: Playlist unverändert", world.uris("pl3") == orig and world.uris(arch()) == [])
    page.get_by_role("button", name="Erneut versuchen").click()
    wait_view(page, "1 Titel entfernt")
    page.get_by_role("button", name="Rückgängig machen").click()
    wait_toast(page, "alten Plätzen")

    # 8. Letzte Karte lässt sich aus der Prüfliste noch einmal ansehen
    play_round(page, "Gym", set())
    page.get_by_role("button", name="Letzte Karte noch einmal").last.click()
    page.wait_for_selector(".card--top")
    check("Letzte Karte noch einmal: zurück auf der fünften Karte", counter(page) == "5 von 5", counter(page))
    page.keyboard.press("ArrowRight")
    wait_view(page, "Änderungen prüfen")
    page.get_by_role("button", name="Runde ohne Änderungen beenden").click()
    page.wait_for_selector("button.row")

    # 9. Entscheidung geht nicht verloren, wenn während der Animation die Ansicht wechselt
    page.emulate_media(reduced_motion="no-preference")
    page.get_by_role("button", name="Gym").click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    page.evaluate("document.querySelector('.act__btn--remove').click(); document.querySelector('.pill').click();")
    wait_view(page, "Änderungen prüfen")
    time.sleep(0.5)
    check("Wischen und sofort „Fertig“: Entscheidung ist erfasst", "1 Titel entfernen" in page.inner_text("body") and "Änderungen prüfen" in page.inner_text("body"))
    page.get_by_role("button", name="Runde ohne Änderungen beenden").click()
    page.locator("dialog[open]").get_by_role("button", name="Beenden").click()
    page.wait_for_selector("button.row")
    page.emulate_media(reduced_motion="reduce")

    # 10. Mehr als 100 Titel: Pakete zu 100, Rückgängig exakt
    big = world.uris("pl6")
    play_round(page, "Groß", {f"Nachtbus {n}" for n in range(400, 520)}, "Alle")
    before = len(world.writes)
    apply_now(page, 120)
    w = world.writes[before:]
    check("120 Titel: anlegen, 100 + 20 archivieren, 100 + 20 entfernen", [(x[0], len(x[2]) if x[0] != "create" else 0) for x in w] == [("create", 0), ("add", 100), ("add", 20), ("remove", 100), ("remove", 20)],
          str([(x[0], len(x[2])) for x in w]))
    check("120 Titel entfernt, 110 übrig", len(world.uris("pl6")) == 110)
    before = len(world.writes)
    page.get_by_role("button", name="Rückgängig machen").click()
    wait_toast(page, "alten Plätzen")
    w = world.writes[before:]
    check("Rückgängig bei 120 benachbarten Titeln: zwei Abrufe, Reihenfolge exakt", world.uris("pl6") == big and [(x[0], x[3]) for x in w if x[0] == "add"] == [("add", 0), ("add", 100)], str([(x[0], x[3]) for x in w]))

    # 11. Mehr als 100 verstreute Lücken: gesammelt ans Ende, mit ehrlicher Meldung
    play_round(page, "Groß", {f"Nachtbus {n}" for n in range(400, 630, 2)}, "Alle")
    apply_now(page, 115)
    before = len(world.writes)
    page.get_by_role("button", name="Rückgängig machen").click()
    wait_toast(page, "am Ende statt an ihren alten Plätzen")
    w = [x for x in world.writes[before:] if x[0] == "add"]
    now = world.uris("pl6")
    check("115 verstreute Titel: zwei Sammelabrufe ans Ende, alle Titel genau einmal da", [len(x[2]) for x in w] == [100, 15] and all(x[3] is None for x in w)
          and sorted(now) == sorted(big) and now[:115] == big[1::2], str([(len(x[2]), x[3]) for x in w]))

    # 12. Sperre ohne lesbare Wartezeit: genau ein neuer Versuch nach kurzer Pause
    world.force_429 = {"no_header": True}
    calls, t0 = len(world.log), time.time()
    page.get_by_role("button", name="Playlists neu laden").click()
    page.wait_for_selector("button.row", timeout=10000)
    check("429 ohne Wartezeit: ein neuer Versuch nach etwa 2 Sekunden", time.time() - t0 >= 2.3 and len(world.log) == calls + 2, f"{time.time() - t0:.1f}s {len(world.log) - calls}")

    # 13. Liste älter als 20 Sekunden: vor dem Start der Runde wird sie neu geholt, die Runde nutzt den aktuellen Stand
    play_round(page, "Gym", set())
    page.get_by_role("button", name="Runde ohne Änderungen beenden").click()
    page.wait_for_selector("button.row")
    world.playlists["pl3"]["entries"].append(entry(track_obj(888)))
    world.bump("pl3")
    time.sleep(21)
    lists = len([1 for m, pth in world.log if pth == "/me/playlists"])
    page.get_by_role("button", name="Gym").click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    check("Veraltete Liste wird vor der Runde aufgefrischt, neuer Titel ist dabei", counter(page) == "1 von 6" and len([1 for m, pth in world.log if pth == "/me/playlists"]) == lists + 1, counter(page))

    # 14. Anderes Konto meldet sich an: Daten des vorigen Kontos verschwinden von diesem Gerät
    check("Vor dem Kontowechsel liegen Entwurf und Prüfverlauf vor", page.evaluate("Boolean(localStorage.getItem('sw.draft')) && Object.keys(localStorage).some((k) => k.startsWith('sw.seen.'))"))
    world.me = {"id": "anna", "display_name": "Anna", "type": "user"}
    page.evaluate("localStorage.removeItem('sw.auth'); localStorage.removeItem('sw.me')")
    page.reload()
    wait_view(page, "Mit Spotify verbinden")
    page.get_by_role("button", name="Mit Spotify verbinden").click()
    wait_view(page, "Keine eigene Playlist gefunden")
    keys = sorted(page.evaluate("Object.keys(localStorage)"))
    check("Kontowechsel: Entwurf, Prüfverlauf, Zwischenspeicher und Archiv-Zuordnung des alten Kontos sind weg",
          not any(k.startswith(("sw.seen.", "sw.cache.")) or k in ("sw.draft", "sw.archives", "sw.lastApply") for k in keys) and page.evaluate("JSON.parse(localStorage.getItem('sw.user'))") == "anna", str(keys))
    ctx.close()

    # 15. Zweites Gerät: Archiv wird über die Markierung in der Beschreibung gefunden, auch mit umschriebenem Doppelpunkt
    world2 = World()
    world2.add_playlist("arc", "Altes Zeug", "nico", [], description="Von Swipelist entfernte Titel. swipelist-archiv:pl3")
    world2.encode_desc = True
    world2.custom_images["pl5"] = [{"url": "https://bilder.example.com/x.png", "width": 300, "height": 300}]
    console2 = []
    ctx, page = new_page(browser, world2, [], console2, {"width": 390, "height": 844}, True)
    page.emulate_media(reduced_motion="reduce")
    login(page, world2, [])
    check("Zweites Gerät: markiertes Archiv ist ausgeblendet", "Altes Zeug" not in page.locator("button.row .row__title").all_inner_texts())
    row = page.locator("button.row", has_text="Sonderfälle")
    row.locator("div.row__img").wait_for(timeout=5000)
    check("Bild von fremdem Server wird nicht geladen, Platzhalter erscheint", row.locator("img").count() == 0)
    play_round(page, "Gym", {"Nachtbus 101"})
    check("Prüfliste nennt das vorhandene Archiv beim Namen", "die Archiv-Playlist „Altes Zeug“" in page.inner_text("body"), page.inner_text("body")[:300])
    apply_now(page, 1)
    check("Zweites Gerät: kein zweites Archiv angelegt, vorhandenes benutzt", [(x[0], x[1]) for x in world2.writes] == [("add", "arc"), ("remove", "pl3")], str(world2.writes))
    page.get_by_role("button", name="Zur Playlist-Auswahl").click()
    page.wait_for_selector("button.row")
    page.get_by_role("button", name="Einstellungen").click()
    page.get_by_role("button", name="Selbsttest öffnen").click()
    page.get_by_role("button", name="Test starten").click()
    page.wait_for_function("() => document.querySelector('.pre').innerText.includes('Fertig.')", timeout=30000)
    check("Selbsttest nennt fremde Bildserver", "Bilder auch von: bilder.example.com" in page.locator(".pre").inner_text(), page.locator(".pre").inner_text())
    ctx.close()


def run_mobile(browser):
    print("\n== Handy 390x844 ==")
    world, auth_log, console = World(), [], []
    ctx, page = new_page(browser, world, auth_log, console, {"width": 390, "height": 844}, True)
    original = world.uris("pl1")

    login(page, world, auth_log)
    a = auth_log[0]
    check("Anmeldung: PKCE-Parameter vollständig", a["response_type"] == "code" and a["code_challenge_method"] == "S256" and len(a["code_challenge"]) == 43
          and a["client_id"] == CLIENT_ID and a["redirect_uri"] == APP + "/", str(a))
    check("Anmeldung: genau die benötigten Rechte", sorted(a["scope"].split()) == sorted([
        "playlist-read-private", "playlist-read-collaborative", "playlist-modify-private", "playlist-modify-public",
        "user-top-read", "user-read-recently-played", "user-library-read", "user-read-playback-state",
        "user-modify-playback-state", "streaming", "user-read-private", "user-read-email"]), a["scope"])
    t = world.token_calls[0]
    check("Anmeldung: Code-Tausch ohne geheimen Schlüssel", t["grant_type"] == "authorization_code" and "client_secret" not in t and len(t["code_verifier"]) == 64)
    check("Adresszeile nach Anmeldung bereinigt", page.url == APP + "/", page.url)
    names = page.locator("button.row .row__title").all_inner_texts()
    check("Nur eigene Playlists sichtbar, gemeinsame Playlist anderer nicht", names == ["Roadtrip", "Gym", "Leer", "Sonderfälle", "Groß"], str(names))
    check("Hinweis auf ausgeblendete fremde Playlists", "2 fremde Playlists fehlen hier" in page.inner_text("body"))
    check("Titelzahl aus items.total", "64 Titel" in page.locator("button.row").first.inner_text())
    page.screenshot(path=f"{SHOTS}/01-playlists.png")

    # Runde starten
    page.get_by_role("button", name="Roadtrip").click()
    page.wait_for_selector("dialog[open]")
    page.screenshot(path=f"{SHOTS}/02-start.png")
    page.get_by_role("button", name="20", exact=True).click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    check("Runde: Zähler 1 von 20", counter(page) == "1 von 20", counter(page))
    check("Hinweis auf übersprungene Einträge", "3 Einträge übersprungen" in page.locator("#toast").inner_text(), page.locator("#toast").inner_text())
    gets = [p for m, p in world.log if p == "/playlists/pl1/items"]
    check("Titel in 2 Seiten geladen (64 Einträge)", len(gets) == 2, str(len(gets)))
    time.sleep(0.6)
    page.screenshot(path=f"{SHOTS}/03-swipe.png")

    deck_first = title(page)
    decided = []
    for label in ["Entfernen", "Entfernen", "Behalten", "Entfernen", "Behalten"]:
        decided.append((title(page), label))
        press(page, label)
    decided.append((title(page), "Entfernen")); swipe(page, -1)
    decided.append((title(page), "Behalten")); swipe(page, 1)
    check("Zähler nach 7 Entscheidungen", counter(page) == "8 von 20", counter(page))
    check("Fertig-Zähler zeigt 4 Entfernungen", page.locator(".pill__count").inner_text() == "4")

    # kurzes Ziehen ohne Entscheidung
    box = page.locator(".card--top").bounding_box()
    page.mouse.move(box["x"] + 100, box["y"] + 200); page.mouse.down(); page.mouse.move(box["x"] + 130, box["y"] + 200, steps=30); page.mouse.up()
    time.sleep(0.4)
    check("Kurzes Ziehen entscheidet nichts", counter(page) == "8 von 20")

    # Rückgängig
    current = title(page)
    page.get_by_role("button", name="Rückgängig", exact=True).click()
    check("Rückgängig holt die letzte Karte zurück", counter(page) == "7 von 20" and title(page) == decided[-1][0], f"{counter(page)} {title(page)}")
    press(page, "Behalten")
    check("Danach wieder dieselbe Folgekarte", title(page) == current)

    # Neuladen mitten in der Runde
    page.reload()
    wait_view(page, "Angefangene Runde")
    n_done = len(decided)
    check("Entwurf nach Neuladen angeboten", f"Roadtrip: {n_done} von 20 geprüft" in page.inner_text("body"), page.inner_text(".banner"))
    page.screenshot(path=f"{SHOTS}/05-draft.png")
    page.get_by_role("button", name="Fortsetzen").click()
    page.wait_for_selector(".card--top")
    check("Fortsetzen an derselben Stelle", counter(page) == f"{n_done + 1} von 20" and title(page) == current, f"{counter(page)} {title(page)}")
    check("Fortsetzen ohne erneutes Laden (Zwischenspeicher)", len([p for m, p in world.log if p == "/playlists/pl1/items"]) == 2)

    # Prüfliste
    page.get_by_role("button", name="Fertig").click()
    wait_view(page, "Änderungen prüfen")
    rows = page.locator(".list .row .row__title").all_inner_texts()
    expected_removed = [t for t, l in decided if l == "Entfernen"]
    check("Prüfliste zeigt die 4 markierten Titel", rows == expected_removed, f"{rows} vs {expected_removed}")
    check("Text nennt die Archiv-Playlist", "„Roadtrip Archiv“" in page.inner_text("body"))
    page.locator(".list .row").nth(1).get_by_role("button").click()
    check("Titel lässt sich in der Prüfliste zurückholen", "3 Titel entfernen" in page.inner_text("body"))
    page.screenshot(path=f"{SHOTS}/06-review.png", full_page=True)
    kept_back = expected_removed[1]
    final_removed = [t for t in expected_removed if t != kept_back]

    # Anwenden, erster Versuch scheitert beim Entfernen
    world.fail_delete = 1
    page.get_by_role("button", name="3 Titel entfernen").click()
    wait_view(page, "Das Entfernen wurde unterbrochen")
    check("Abbruch beim Entfernen: nichts verloren, Wiederholen angeboten", page.get_by_role("button", name="Erneut versuchen").is_visible())
    arch_id = next(i for i, p in world.playlists.items() if p["name"] == "Roadtrip Archiv")
    check("Archiv wurde vor dem Entfernen befüllt", len(world.playlists[arch_id]["entries"]) == 3 and len(world.playlists["pl1"]["entries"]) == 64)
    page.get_by_role("button", name="Erneut versuchen").click()
    wait_view(page, "3 Titel entfernt")
    page.screenshot(path=f"{SHOTS}/07-result.png")

    arch = world.playlists[arch_id]
    name_of = lambda uri: f"Nachtbus {int(uri[-3:])}"
    check("Archiv ist privat und richtig benannt", arch["public"] is False and "swipelist-archiv:pl1" in arch["description"])
    check("Archiv enthält genau die entfernten Titel, nicht doppelt", sorted(name_of(u) for u in world.uris(arch_id)) == sorted(final_removed), str(world.uris(arch_id)))
    left = [u for u in world.uris("pl1") if u]
    check("Entfernte Titel sind aus der Playlist", not any(name_of(u) in final_removed for u in left if u.startswith("spotify:track")))
    check("Zurückgeholter Titel blieb in der Playlist", any(name_of(u) == kept_back for u in left if u.startswith("spotify:track")))
    kinds = [w[0] for w in world.writes]
    check("Reihenfolge: anlegen, archivieren, entfernen", kinds == ["create", "add", "remove"], str(kinds))

    # Rückgängig machen
    page.get_by_role("button", name="Rückgängig machen").click()
    wait_view(page, "Playlists")
    page.wait_for_selector("button.row")
    check("Rückgängig: ursprüngliche Reihenfolge exakt wiederhergestellt", world.uris("pl1") == original,
          str([i for i, (x, y) in enumerate(zip(world.uris('pl1'), original)) if x != y][:5]))
    check("Rückgängig: Archiv wieder leer", world.uris(arch_id) == [])
    check("Archiv-Playlist ist in der Auswahl ausgeblendet", "Roadtrip Archiv" not in page.locator("button.row .row__title").all_inner_texts())
    check("Titelzahl wieder 64", "64 Titel" in page.locator("button.row").first.inner_text(), page.locator("button.row").first.inner_text())

    # Je Lücke ein Abruf. Der doppelt vorhandene Titel 3 belegt zwei Plätze, benachbarte Plätze teilen sich einen Abruf.
    slots = sum(2 if t == "Nachtbus 3" else 1 for t in final_removed)
    kinds = [w[0] for w in world.writes]
    readds = kinds[3:-1]
    check("Rückgängig: Titel einzeln an ihre Plätze, dann Archiv bereinigt",
          kinds[:3] == ["create", "add", "remove"] and kinds[-1] == "remove" and set(readds) == {"add"} and 1 <= len(readds) <= slots, str(kinds))
    writes_after_undo = len(world.writes)

    # Zweite Runde: bereits geprüfte Titel kommen nicht sofort wieder
    page.get_by_role("button", name="Roadtrip").click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    seen_titles = {t for t, _ in decided} | {current}
    second = []
    for _ in range(20):
        second.append(title(page))
        if len(second) < 20:
            press(page, "Behalten")
    check("Zweite Runde zeigt 20 andere Titel", len(set(second)) == 20 and not (set(second) & {t for t, l in decided if l == "Behalten"}), str(set(second) & seen_titles))
    page.get_by_role("button", name="Behalten", exact=True).click()
    wait_view(page, "Änderungen prüfen")
    check("Ende der Runde führt zur Prüfliste", "Kein Titel ist zum Entfernen markiert" in page.inner_text("body"))
    check("Ohne Markierung ist Anwenden gesperrt", page.get_by_role("button", name="Nichts zu entfernen").is_disabled())
    page.get_by_role("button", name="Runde ohne Änderungen beenden").click()
    wait_view(page, "Playlists")
    check("Keine Schreibzugriffe ohne Änderungen", len(world.writes) == writes_after_undo, str([w[0] for w in world.writes]))

    # Vorhandenes Archiv: schon archivierter Titel wird nicht doppelt abgelegt
    world.playlists[arch_id]["entries"].append({"added_at": None, "is_local": False, "item": {"id": "t001", "uri": "spotify:track:t001", "type": "track", "name": "Nachtbus 1", "artists": [], "album": {}}})
    world.bump(arch_id)
    page.get_by_role("button", name="Playlists neu laden").click()
    page.wait_for_selector("button.row")
    page.get_by_role("button", name="Roadtrip").click()
    page.get_by_role("button", name="Alle", exact=True).click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    check("Runde „Alle“ umfasst 60 verschiedene Titel", counter(page) == "1 von 60", counter(page))
    removed_now = 0
    for _ in range(60):
        t = title(page)
        if t in ("Nachtbus 1", "Nachtbus 3", "Nachtbus 9"):
            page.keyboard.press("ArrowLeft"); removed_now += 1
        else:
            page.keyboard.press("ArrowRight")
        page.wait_for_function("t => !document.querySelector('.card--top') || document.querySelector('.card--top .card__title').innerText !== t || document.body.innerText.includes('Änderungen prüfen')", arg=t, timeout=3000)
    wait_view(page, "Änderungen prüfen")
    writes_before = len(world.writes)
    page.get_by_role("button", name="3 Titel entfernen").click()
    wait_view(page, "3 Titel entfernt")
    new_writes = world.writes[writes_before:]
    check("Vorhandenes Archiv wird wiederverwendet", [w[0] for w in new_writes] == ["add", "remove"] and new_writes[0][1] == arch_id, str(new_writes))
    check("Schon archivierter Titel nicht doppelt", sorted(new_writes[0][2]) == ["spotify:track:t003", "spotify:track:t009"], str(new_writes[0][2]))
    check("Dublette (Titel 3) an beiden Stellen entfernt", world.uris("pl1").count("spotify:track:t003") == 0 and len(world.playlists["pl1"]["entries"]) == 60)
    page.get_by_role("button", name="Rückgängig machen").click()
    wait_view(page, "Playlists")
    page.wait_for_selector("button.row")
    check("Rückgängig stellt auch die Dublette wieder her", world.uris("pl1") == original)
    check("Vorher archivierter Titel bleibt im Archiv", world.uris(arch_id) == ["spotify:track:t001"], str(world.uris(arch_id)))

    # Abgelaufenes Token wird still erneuert
    world.force_401_once = True
    page.get_by_role("button", name="Playlists neu laden").click()
    page.wait_for_selector("button.row")
    check("Abgelaufenes Token wird erneuert", world.token_calls[-1]["grant_type"] == "refresh_token" and "client_secret" not in world.token_calls[-1])

    # Kurze Sperre wird abgewartet, erschöpftes Kontingent wird gemeldet
    world.force_429 = {"retry_after": 1}
    t0 = time.time()
    page.get_by_role("button", name="Playlists neu laden").click()
    page.wait_for_selector("button.row", timeout=8000)
    check("Kurze Sperre (429) wird abgewartet", time.time() - t0 >= 1.4, f"{time.time() - t0:.1f}s")
    world.force_429 = {"retry_after": 61887, "reason": "QUOTA_EXCEEDED"}
    calls = len(world.log)
    page.get_by_role("button", name="Playlists neu laden").click()
    wait_view(page, "Das hat nicht geklappt")
    check("Erschöpftes Kontingent: klare Meldung mit Wartezeit", "Kontingent bei Spotify ist erschöpft. Erneut möglich in ca. 17 Stunden." in page.inner_text("body"), page.inner_text("body"))
    time.sleep(1.5)
    check("Erschöpftes Kontingent: kein automatischer neuer Versuch", len(world.log) == calls + 1, str(len(world.log) - calls))
    page.screenshot(path=f"{SHOTS}/08-quota.png")
    page.get_by_role("button", name="Erneut versuchen").click()
    page.wait_for_selector("button.row")

    # Leere Playlist und Sonderfälle
    page.get_by_role("button", name="Leer").click()
    page.get_by_role("button", name="Runde starten").click()
    wait_view(page, "Playlists")
    check("Leere Playlist wird abgefangen", "keine Titel, die sich prüfen lassen" in page.locator("#toast").inner_text())
    page.get_by_role("button", name="Sonderfälle").click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    time.sleep(0.5)
    page.screenshot(path=f"{SHOTS}/09-long-title.png")
    overflow = page.evaluate("(() => { const c = document.querySelector('.card--top'); const t = c.querySelector('.card__title'); return t.getBoundingClientRect().right <= c.getBoundingClientRect().right && document.documentElement.scrollWidth <= window.innerWidth; })()")
    check("Langer Titel sprengt die Karte nicht", overflow)
    if "Nachtbus 302" not in title(page):
        press(page, "Behalten")
    page.wait_for_selector(".card--top .card__nocover")
    check("Fehlendes Cover zeigt Platzhalter", True)
    page.locator(".topbar .iconbtn").first.click()
    wait_view(page, "Playlists")

    # Einstellungen, Selbsttest, Abmelden
    page.get_by_role("button", name="Einstellungen").click()
    wait_view(page, "Angemeldet als Nico")
    page.screenshot(path=f"{SHOTS}/10-settings.png", full_page=True)
    page.get_by_role("button", name="Selbsttest öffnen").click()
    writes_before_diag = len(world.writes)
    page.get_by_role("button", name="Test starten").click()
    page.wait_for_function("() => document.querySelector('.pre').innerText.includes('Fertig.')", timeout=30000)
    out = page.locator(".pre").inner_text()
    print("\n".join("      " + l for l in out.splitlines()))
    expected = ["[OK]     Konto: erreichbar", "[OK]     Playlists: 6 eigene, 2 fremde, Titelzahl bei 8 von 8, Bilder von Spotifys Servern",
                "[OK]     Top-Künstler: 1 Einträge, Genres vorhanden", "[OK]     Top-Titel: 2 Einträge, Titelkennung (ISRC) vorhanden",
                "[OK]     Zuletzt gehört: 1 Einträge", "[OK]     Gespeicherte Titel: 412 insgesamt",
                "[OK]     Suche nach Titeln eines Künstlers: 2 Treffer", "[OK]     Alben eines Künstlers: 2 Einträge",
                "[OK]     Titel eines Albums: 1 Einträge, Gastkünstler vorhanden", "[OK]     Abspielgeräte: 2: Computer (aktiv), Smartphone"]
    missing = [e for e in expected if e not in out]
    check("Selbsttest: alle zehn Spotify-Abfragen mit Ergebnis", not missing, str(missing))
    check("Selbsttest: Suchanfrage ohne Anführungszeichen im Namen", world.searches[-1] == 'artist:"Kollektiv A"', str(world.searches))
    check("Selbsttest: keine Künstler-, Titel- oder Gerätenamen im Ergebnis", not any(w in out for w in ["Nicos", "Kollektiv", "Nachtbus", "Album 1"]))
    check("Selbsttest ändert nichts", len(world.writes) == writes_before_diag, str(world.writes[writes_before_diag:]))
    page.get_by_role("button", name="Ergebnis kopieren").click()
    check("Ergebnis lässt sich kopieren", page.evaluate("navigator.clipboard.readText()").startswith("Swipelist 0.2.1"))
    page.screenshot(path=f"{SHOTS}/11-diagnose.png", full_page=True)
    page.get_by_role("button", name="Zurück").click()
    page.get_by_role("button", name="Abmelden").click()
    page.locator("dialog[open]").get_by_role("button", name="Abmelden").click()
    wait_view(page, "Mit Spotify verbinden")
    keys = page.evaluate("Object.keys(localStorage)")
    check("Abmelden löscht Anmeldung und Daten, behält die Client-ID", keys == ["sw.clientId"] or sorted(keys) == ["sw.clientId", "sw.roundSize"], str(keys))
    page.screenshot(path=f"{SHOTS}/12-login.png")

    bad = [c for c in console if c[0] in ("error", "pageerror") and "429" not in c[1] and "401" not in c[1] and "500" not in c[1] and "404" not in c[1] and "ApiError" not in c[1]]
    check("Keine Skriptfehler und keine Verstöße gegen die Schutzregel (CSP)", not bad, str(bad[:4]))
    csp = [c for c in console if "Content Security Policy" in c[1] or "Refused to" in c[1]]
    check("Keine von der CSP blockierten Abrufe", not csp, str(csp[:3]))
    ctx.close()


def run_small(browser):
    print("\n== Handy im Browser 390x664 und 375x553 ==")
    world, auth_log, console = World(), [], []
    ctx, page = new_page(browser, world, auth_log, console, {"width": 390, "height": 664}, True)
    login(page, world, auth_log)
    page.get_by_role("button", name="Gym").click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    check("Kleine Playlist startet ohne Größenwahl mit allen 5 Titeln", counter(page) == "1 von 5", counter(page))
    time.sleep(0.6)
    fits = page.evaluate("(() => { const a = document.querySelector('.actions').getBoundingClientRect(); const s = document.querySelector('.stack').getBoundingClientRect(); return a.bottom <= window.innerHeight && s.bottom <= a.top && document.documentElement.scrollHeight <= window.innerHeight; })()")
    width = page.evaluate("document.querySelector('.card--top').getBoundingClientRect().width")
    check("390x664: alles sichtbar ohne Scrollen, Karte in voller Breite", fits and width == 358, f"{fits} {width}")
    check("Abspielknopf liegt auf dem Cover, kein eigenes Tonelement", page.evaluate("(() => { const b = document.querySelector('.card--top .playbtn').getBoundingClientRect(); const c = document.querySelector('.card--top .card__cover').getBoundingClientRect(); return b.right <= c.right && b.bottom <= c.bottom && document.querySelector('audio') === null; })()"))
    page.screenshot(path=f"{SHOTS}/20-small-664.png")
    page.set_viewport_size({"width": 375, "height": 553})
    time.sleep(0.4)
    fits = page.evaluate("(() => { const a = document.querySelector('.actions').getBoundingClientRect(); const s = document.querySelector('.stack').getBoundingClientRect(); return a.bottom <= window.innerHeight && s.bottom <= a.top; })()")
    check("375x553: alles sichtbar ohne Scrollen", fits)
    page.screenshot(path=f"{SHOTS}/21-small-553.png")
    ctx.close()

    # Selbsttest mit Lücken: keine Top-Listen, Geräteabfrage verweigert
    world2 = World()
    world2.no_top = True
    world2.devices_forbidden = True
    ctx, page = new_page(browser, world2, [], [], {"width": 390, "height": 844}, True)
    login(page, world2, [])
    page.get_by_role("button", name="Einstellungen").click()
    page.get_by_role("button", name="Selbsttest öffnen").click()
    page.get_by_role("button", name="Test starten").click()
    page.wait_for_function("() => document.querySelector('.pre').innerText.includes('Fertig.')", timeout=30000)
    out = page.locator(".pre").inner_text()
    expected = ["[FEHLER] Top-Künstler: 0 Einträge, Genres fehlen", "[FEHLER] Top-Titel: 0 Einträge, Titelkennung (ISRC) fehlt",
                "[--]     Suche nach Titeln eines Künstlers: übersprungen", "[--]     Alben eines Künstlers: übersprungen",
                "[--]     Titel eines Albums: übersprungen", "[FEHLER] Abspielgeräte: HTTP 403 Insufficient client scope"]
    missing = [e for e in expected if e not in out]
    check("Selbsttest meldet Lücken einzeln und läuft trotzdem durch", not missing, out)
    world2.devices_forbidden = False
    world2.devices = []
    page.get_by_role("button", name="Test starten").click()
    page.wait_for_function("() => document.querySelector('.pre').innerText.includes('Fertig.')", timeout=30000)
    check("Selbsttest: kein geöffnetes Spotify-Gerät ist kein Fehler", "[--]     Abspielgeräte: keines gefunden" in page.locator(".pre").inner_text())
    world2.force_429 = {"retry_after": 3600, "reason": "QUOTA_EXCEEDED"}
    calls = len(world2.log)
    page.get_by_role("button", name="Test starten").click()
    page.wait_for_function("() => document.querySelector('.pre').innerText.includes('Abgebrochen')", timeout=30000)
    check("Selbsttest bricht bei erschöpftem Kontingent sofort ab", len(world2.log) == calls + 1, str(len(world2.log) - calls))
    ctx.close()


def run_desktop(browser):
    print("\n== PC 1280x800, Tastatur ==")
    world, auth_log, console = World(), [], []
    ctx, page = new_page(browser, world, auth_log, console, {"width": 1280, "height": 800}, False)
    login(page, world, auth_log)
    page.get_by_role("button", name="Gym").click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    time.sleep(0.6)
    page.screenshot(path=f"{SHOTS}/30-desktop.png")
    check("PC: Tastaturhinweis sichtbar", page.locator(".keys").is_visible())
    first = title(page)
    page.keyboard.press("ArrowLeft")
    page.wait_for_function("t => document.querySelector('.card--top .card__title').innerText !== t", arg=first)
    check("Pfeil links entfernt", page.locator(".pill__count").inner_text() == "1")
    page.keyboard.press("z")
    check("Z nimmt zurück", title(page) == first and counter(page) == "1 von 5")
    # Gedrückt gehaltene Pfeiltaste: nur eine Karte
    page.keyboard.down("ArrowRight"); page.keyboard.down("ArrowRight"); page.keyboard.down("ArrowRight"); page.keyboard.up("ArrowRight")
    time.sleep(1.0)
    check("Gehaltene Pfeiltaste entscheidet nur eine Karte", counter(page) == "2 von 5", counter(page))
    page.keyboard.press("z")
    time.sleep(0.2)
    # Mausklick auf „Entfernen“, danach Leertaste: darf nicht noch einmal entfernen
    page.get_by_role("button", name="Entfernen", exact=True).click()
    page.wait_for_function("t => document.querySelector('.card--top .card__title').innerText !== t", arg=first)
    page.keyboard.press("Space")
    time.sleep(0.5)
    check("Leertaste nach Mausklick löst kein zweites Entfernen aus", counter(page) == "2 von 5" and page.locator(".pill__count").inner_text() == "1", counter(page))
    page.keyboard.press("ArrowRight"); time.sleep(0.4)
    page.keyboard.press("ArrowRight"); time.sleep(0.4)
    page.keyboard.press("ArrowRight"); time.sleep(0.4)
    page.keyboard.press("ArrowRight")
    wait_view(page, "Änderungen prüfen")
    page.screenshot(path=f"{SHOTS}/31-desktop-review.png")
    page.keyboard.press("ArrowLeft"); time.sleep(0.3)
    check("Pfeiltasten wirken nur auf dem Swipe-Screen", "Änderungen prüfen" in page.inner_text("body") and len(world.writes) == 0)
    # Voller oder gesperrter Browser-Speicher wird gemeldet statt verschwiegen
    page.get_by_role("button", name="Letzte Karte noch einmal").last.click()
    page.wait_for_selector(".card--top")
    page.evaluate("() => { Storage.prototype.setItem = function () { throw new Error('voll'); }; }")
    page.keyboard.press("ArrowRight")
    wait_toast(page, "Browser-Speicher ist voll oder gesperrt")
    check("Voller Browser-Speicher wird gemeldet", True)
    ctx.close()


def run_auth_errors(browser):
    print("\n== Anmeldefehler ==")
    world, auth_log, console = World(), [], []
    ctx, page = new_page(browser, world, auth_log, console, {"width": 390, "height": 844}, True)
    page.goto(APP + "/")
    page.evaluate(f"localStorage.setItem('sw.clientId', JSON.stringify('{CLIENT_ID}'))")
    page.goto(APP + "/?code=CODE123&state=falsch")
    wait_view(page, "Mit Spotify verbinden")
    check("Rückleitung mit falschem state wird abgelehnt", "ließ sich nicht zuordnen" in page.locator("#toast").inner_text() and len(world.token_calls) == 0)
    page.goto(APP + "/?error=access_denied&state=x")
    wait_view(page, "Mit Spotify verbinden")
    check("Abgelehnte Freigabe wird gemeldet", "Anmeldung abgebrochen" in page.locator("#toast").inner_text())
    check("Adresszeile wird auch im Fehlerfall bereinigt", page.url == APP + "/")
    ctx.close()


def play_count_settles(page, world, n, timeout=4.0):
    # Nicht time.sleep: Die nachgebaute Schnittstelle antwortet nur, während Playwright arbeitet.
    end = time.time() + timeout
    while time.time() < end and len(world.plays) < n:
        page.wait_for_timeout(50)
    return len(world.plays) >= n


def current_uri(page):
    name = title(page)
    num = int(name.split()[-1])
    return f"spotify:track:t{num:03d}"


def start_pos(n):
    d = 200000 + n
    return max(0, min(round(d * 0.35), d - 25000))


def run_playback(browser):
    print("\n== Anspielen: Handy steuert die Spotify-App ==")
    world, auth_log, console = World(), [], []
    ctx, page = new_page(browser, world, auth_log, console, {"width": 390, "height": 844}, True)
    login(page, world, auth_log)
    page.get_by_role("button", name="Roadtrip").click()
    page.get_by_role("button", name="20", exact=True).click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    check("Handy: erster Titel wird automatisch angespielt", play_count_settles(page, world, 1), str(world.plays))
    n = int(title(page).split()[-1])
    check("Handy: auf dem Handy (Smartphone vor aktivem Computer)", world.plays and world.plays[0][0] == "d2", str(world.plays))
    check("Handy: richtiger Titel ab ca. 35 %", world.plays and world.plays[0][1:] == (current_uri(page), start_pos(n)), f"{world.plays} {start_pos(n)}")
    check("Handy: kein Browser-Player geladen", page.evaluate("document.querySelector('iframe, script[src*=\"sdk.scdn.co\"]') === null"))
    page.wait_for_function("() => document.querySelector('.card--top .playbtn').getAttribute('aria-label') === 'Pause'")
    page.wait_for_timeout(1200)
    shown = page.locator(".card--top .times span").first.inner_text()
    check("Handy: Zeitanzeige läuft ab der Startstelle", shown in ("1:10", "1:11", "1:12"), shown)
    check("Handy: Karte zeigt, wo gespielt wird", page.locator(".card--top .times__where").inner_text() == "auf Nicos Handy", page.locator(".card--top .times__where").inner_text())
    page.screenshot(path=f"{SHOTS}/40-play-mobile.png")

    # Pause und weiter
    page.locator(".card--top .playbtn").click()
    page.wait_for_timeout(400)
    check("Pause wird an Spotify geschickt", world.player_calls and world.player_calls[-1][:2] == ("pause", "d2"), str(world.player_calls))
    check("Knopf zeigt danach „Weiter abspielen“", page.locator(".card--top .playbtn").get_attribute("aria-label") == "Weiter abspielen")
    before = len(world.plays)
    page.locator(".card--top .playbtn").click()
    play_count_settles(page, world, before + 1)
    resumed = world.plays[-1][2] if len(world.plays) > before else -1
    check("Weiter abspielen setzt an der gemerkten Stelle fort", start_pos(n) + 1000 <= resumed <= start_pos(n) + 3000, str(resumed))

    # Springen über die Leiste
    box = page.locator(".card--top .seek").bounding_box()
    page.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] / 2)
    page.wait_for_timeout(400)
    # Läuft der Titel schon, kommt ein Sprungbefehl; startet er gerade noch, ein neuer Abspielbefehl an der Stelle.
    jumps = [c[2] for c in world.player_calls if c[0] == "seek"] + [p[2] for p in world.plays[-1:]]
    check("Tippen auf die Leiste springt zur Stelle", any(abs(j - (200000 + n) / 2) < 3000 for j in jumps), str(jumps))
    check("Tippen auf die Leiste entscheidet nichts", counter(page) == "1 von 20")

    # Wischen: nächster Titel startet automatisch
    before = len(world.plays)
    press(page, "Behalten")
    play_count_settles(page, world, before + 1)
    check("Nach dem Wischen startet der nächste Titel", len(world.plays) == before + 1 and world.plays[-1][1] == current_uri(page), str(world.plays[before:]))

    # Schnelles Wischen startet nicht jeden Titel einzeln
    before = len(world.plays)
    page.keyboard.press("ArrowRight"); page.wait_for_timeout(270)
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(1200)
    check("Schnelles Wischen: nur der zuletzt gezeigte Titel startet", len(world.plays) == before + 1 and world.plays[-1][1] == current_uri(page), str(world.plays[before:]))

    # Prüfliste hält an
    calls = len(world.player_calls)
    page.get_by_role("button", name="Fertig").click()
    wait_view(page, "Änderungen prüfen")
    page.wait_for_timeout(400)
    check("Prüfliste hält die Wiedergabe an", world.player_calls[calls:] == [("pause", "d2", None)], str(world.player_calls[calls:]))

    # Kein Gerät erreichbar
    saved = world.devices
    world.devices = []
    page.get_by_role("button", name="Weiter swipen").last.click()
    page.wait_for_selector(".card--top")
    wait_toast(page, "Spotify auf diesem Handy ist gerade nicht erreichbar")
    check("Ohne Gerät: verständlicher Hinweis", True)
    check("Ohne Gerät: Knopf zeigt den Fehler", page.locator(".card--top .playbtn").get_attribute("aria-label") == "Erneut anspielen")
    log_before = len(world.log)
    press(page, "Behalten")
    page.wait_for_timeout(800)
    check("Ohne Gerät: kein weiterer Versuch bei jeder Karte", len(world.log) == log_before, str(world.log[log_before:]))
    world.devices = saved

    # Gerät wählen
    page.get_by_role("button", name="Anspielen einstellen und Gerät wählen").click()
    page.wait_for_selector("dialog[open] .option")
    page.wait_for_function("() => document.querySelectorAll('dialog[open] .option').length === 4")
    page.screenshot(path=f"{SHOTS}/41-play-sheet.png")
    opts = page.locator("dialog[open] .option .row__title").all_inner_texts()
    check("Auswahl: Automatisch, Browser und beide Spotify-Geräte", opts == ["Automatisch", "Dieser Browser", "Nicos Rechner", "Nicos Handy"], str(opts))
    before = len(world.plays)
    page.locator("dialog[open] .option", has_text="Nicos Rechner").click()
    play_count_settles(page, world, before + 1)
    check("Gewähltes Gerät spielt sofort", world.plays[-1][0] == "d1" and world.plays[-1][1] == current_uri(page), str(world.plays[-1:]))

    # Ausdrücklich gewähltes Gerät verschwindet: kein stilles Ausweichen auf ein anderes Gerät
    world.devices = [d for d in saved if d["id"] != "d1"]
    before = len(world.plays)
    press(page, "Behalten")
    wait_toast(page, "„Nicos Rechner“ ist gerade nicht erreichbar")
    check("Gewähltes Gerät weg: Hinweis statt Ausweichen auf ein anderes Gerät", len(world.plays) == before, str(world.plays[before:]))
    check("Gewähltes Gerät bleibt gespeichert", page.evaluate("JSON.parse(localStorage.getItem('sw.play')).deviceId") == "d1")
    world.devices = saved
    page.locator(".card--top .playbtn").click()
    play_count_settles(page, world, before + 1)
    check("Gerät wieder da: Abspielknopf spielt dort", world.plays[-1][0] == "d1", str(world.plays[before:]))

    # Automatik aus
    page.get_by_role("button", name="Anspielen einstellen und Gerät wählen").click()
    page.wait_for_selector("dialog[open] .switch")
    page.locator("dialog[open] .switch").click()
    check("Schalter zeigt „aus“", page.locator("dialog[open] .switch").get_attribute("aria-checked") == "false")
    page.get_by_role("button", name="Schließen").click()
    before = len(world.plays)
    page.keyboard.press("ArrowLeft")
    page.wait_for_timeout(1000)
    check("Automatik aus: kein Anspielen beim Wischen", len(world.plays) == before, str(world.plays[before:]))
    check("Automatik aus bleibt nach Neuladen gespeichert", page.evaluate("JSON.parse(localStorage.getItem('sw.play')).auto === false"))
    page.locator(".card--top .playbtn").click()
    play_count_settles(page, world, before + 1)
    check("Automatik aus: Abspielknopf spielt trotzdem", len(world.plays) == before + 1)
    ctx.close()

    print("\n== Anspielen: PC im Browser ==")
    world, auth_log, console = World(), [], []
    ctx, page = new_page(browser, world, auth_log, console, {"width": 1280, "height": 800}, False)
    login(page, world, auth_log)
    page.get_by_role("button", name="Gym").click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    check("PC: Titel spielt im Browser-Player", play_count_settles(page, world, 1) and world.plays[0][0] == "sdk-dev", str(world.plays))
    check("PC: Browser-Player bekommt das Zugangs-Token", page.evaluate("window.__sdkToken") == "AT1")
    check("PC: Rahmen des Browser-Players erlaubt (Schutzregel)", page.evaluate("document.querySelector('iframe[src^=\"https://sdk.scdn.co/\"]') !== null"))
    page.keyboard.press("Space")
    page.wait_for_timeout(300)
    check("PC: Leertaste pausiert im Browser", "pause" in page.evaluate("window.__sdkCalls"), str(page.evaluate("window.__sdkCalls")))
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(200)
    check("PC: Tastendruck schaltet den Ton frei (activateElement)", "activateElement" in page.evaluate("window.__sdkCalls"))
    page.screenshot(path=f"{SHOTS}/42-play-desktop.png")
    csp = [m for m in console if "Content Security Policy" in m[1] or "Refused to" in m[1]]
    check("PC: keine Verstöße gegen die Schutzregel", not csp, str(csp))
    ctx.close()

    print("\n== Anspielen: Browser kann nicht selbst abspielen ==")
    world, auth_log, console = World(), [], []
    world.sdk_mode = "unsupported"
    ctx, page = new_page(browser, world, auth_log, console, {"width": 1280, "height": 800}, False)
    login(page, world, auth_log)
    page.get_by_role("button", name="Gym").click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    page.wait_for_timeout(400)
    page.locator(".card--top .playbtn").click()
    play_count_settles(page, world, 1)
    check("Ohne Browser-Player: Spotify-App am PC übernimmt", world.plays and world.plays[-1][0] == "d1", str(world.plays))
    ctx.close()

    print("\n== Anspielen: Premium fehlt ==")
    world, auth_log, console = World(), [], []
    world.play_fail = {"status": 403, "reason": "PREMIUM_REQUIRED", "message": "Player command failed: Premium required"}
    ctx, page = new_page(browser, world, auth_log, console, {"width": 390, "height": 844}, True)
    login(page, world, auth_log)
    page.get_by_role("button", name="Gym").click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    wait_toast(page, "nur mit Spotify Premium")
    check("Ohne Premium: klare Meldung", True)
    ctx.close()

    print("\n== Anspielen: alter Zugang ohne Abspielrechte ==")
    world, auth_log, console = World(), [], []
    world.scope_override = "playlist-read-private playlist-modify-private user-read-playback-state"
    ctx, page = new_page(browser, world, auth_log, console, {"width": 390, "height": 844}, True)
    login(page, world, auth_log)
    page.get_by_role("button", name="Gym").click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    wait_toast(page, "zusätzliche Rechte")
    page.wait_for_timeout(600)
    check("Alter Zugang: kein Abspielversuch", world.plays == [], str(world.plays))
    press(page, "Entfernen")
    page.locator(".card--top .playbtn").click()
    page.wait_for_selector("dialog[open]")
    check("Alter Zugang: Abspielknopf erklärt und bietet „Neu verbinden“", page.get_by_role("button", name="Neu verbinden").is_visible())
    world.scope_override = None
    page.get_by_role("button", name="Neu verbinden").click()
    wait_view(page, "Playlists")
    page.wait_for_selector("button.row")
    check("Neu verbinden fragt die Abspielrechte an", "streaming" in auth_log[-1]["scope"].split())
    check("Angefangene Runde bleibt nach dem Neuverbinden erhalten", "Angefangene Runde" in page.inner_text("body"), page.inner_text("body")[:300])
    ctx.close()


def run_phone_only(browser):
    print("\n== Anspielen: Handy spielt nur auf sich selbst ==")
    world, auth_log, console = World(), [], []
    phone = world.devices[1]
    world.devices = [world.devices[0], {"id": "tv", "name": "Fernseher", "type": "TV", "is_active": False}]
    ctx, page = new_page(browser, world, auth_log, console, {"width": 390, "height": 844}, True)
    login(page, world, auth_log)
    # Stand aus Version 0.2.0: automatisch gemerkter PC
    page.evaluate("localStorage.setItem('sw.play', JSON.stringify({ auto: true, target: null, deviceId: 'd1', deviceName: 'Nicos Rechner' }))")
    page.get_by_role("button", name="Roadtrip").click()
    page.get_by_role("button", name="20", exact=True).click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    wait_toast(page, "Spotify auf diesem Handy ist gerade nicht erreichbar")
    check("Handy ohne Spotify: kein Abspielen auf PC oder Fernseher", world.plays == [], str(world.plays))
    world.devices = world.devices + [phone]
    page.locator(".card--top .playbtn").click()
    play_count_settles(page, world, 1)
    check("Spotify auf dem Handy wieder da: spielt dort, nicht auf dem gemerkten PC", world.plays and world.plays[-1][0] == "d2", str(world.plays))
    ctx.close()

    print("\n== Neue Version ==")
    world, auth_log, console = World(), [], []
    ctx, page = new_page(browser, world, auth_log, console, {"width": 390, "height": 844}, True)
    login(page, world, auth_log)
    page.wait_for_timeout(500)
    check("Gleiche Version: kein Hinweis", page.locator(".update").count() == 0)
    ctx.route("**/version.json*", lambda route, request: route.fulfill(status=200, headers={"Content-Type": "application/json"}, body='{"version": "9.9.9"}'))
    page.reload()
    page.wait_for_selector(".update", timeout=5000)
    check("Neue Version: Hinweis mit „Neu laden“", "9.9.9" in page.locator(".update").inner_text() and page.get_by_role("button", name="Neu laden", exact=True).is_visible())
    ctx.close()


def run_races(browser):
    print("\n== Anspielen: Wettläufe ==")
    # Verlassen, während die Geräteliste noch unterwegs ist: danach darf kein Abspielbefehl mehr rausgehen.
    world, auth_log, console = World(), [], []
    ctx, page = new_page(browser, world, auth_log, console, {"width": 390, "height": 844}, True)
    base = make_handler(world, auth_log)
    held = []

    def handler(route, request):
        if request.url.startswith("https://api.spotify.com/v1/me/player/devices") and request.method == "GET" and not held:
            held.append(route)
            return
        return base(route, request)

    ctx.unroute("**/*")
    ctx.route("**/*", handler)
    login(page, world, auth_log)
    page.get_by_role("button", name="Roadtrip").click()
    page.get_by_role("button", name="20", exact=True).click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    end = time.time() + 4
    while not held and time.time() < end:
        page.wait_for_timeout(50)
    page.get_by_role("button", name="Zur Playlist-Auswahl").click()
    page.wait_for_timeout(300)
    route = held.pop()
    base(route, route.request)
    page.wait_for_timeout(800)
    check("Verlassen während der Gerätesuche: kein verspäteter Abspielbefehl", world.plays == [], str(world.plays))
    ctx.close()

    # Wechsel scheitert, alter Titel lief: Beim Verlassen wird er trotzdem angehalten.
    world, auth_log, console = World(), [], []
    ctx, page = new_page(browser, world, auth_log, console, {"width": 390, "height": 844}, True)
    login(page, world, auth_log)
    page.get_by_role("button", name="Roadtrip").click()
    page.get_by_role("button", name="20", exact=True).click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    play_count_settles(page, world, 1)
    page.wait_for_timeout(300)
    world.play_fail = {"status": 502, "message": "Bad gateway"}
    press(page, "Behalten")
    page.wait_for_timeout(1200)
    check("Gescheiterter Wechsel: alter Titel wird angehalten", world.player_calls and world.player_calls[-1][:2] == ("pause", "d2"), str(world.player_calls))
    check("Gescheiterter Wechsel: Karte zeigt den Fehler", page.locator(".card--top .playbtn").get_attribute("aria-label") == "Erneut anspielen")
    ctx.close()

    # Leiste per Tastatur
    world, auth_log, console = World(), [], []
    ctx, page = new_page(browser, world, auth_log, console, {"width": 1280, "height": 800}, False)
    login(page, world, auth_log)
    page.get_by_role("button", name="Gym").click()
    page.get_by_role("button", name="Runde starten").click()
    page.wait_for_selector(".card--top")
    play_count_settles(page, world, 1)
    page.wait_for_timeout(300)
    page.locator(".card--top .seek").focus()
    before_counter = counter(page)
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(500)
    calls = page.evaluate("window.__sdkCalls")
    check("Leiste per Tastatur erreichbar und Pfeil springt 10 s", page.evaluate("document.querySelector('.card--top .seek').tabIndex") == 0 and any(c.startswith("seek:") for c in calls), str(calls))
    check("Pfeil auf der Leiste wischt nicht", counter(page) == before_counter)
    # Abmelden trennt den Browser-Player
    page.get_by_role("button", name="Zur Playlist-Auswahl").click()
    page.get_by_role("button", name="Einstellungen").click()
    page.get_by_role("button", name="Abmelden").click()
    page.locator("dialog[open]").get_by_role("button", name="Abmelden").click()
    wait_view(page, "Mit Spotify verbinden")
    check("Abmelden trennt den Browser-Player", "disconnect" in page.evaluate("window.__sdkCalls"))
    ctx.close()


def main():
    server = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "--bind", "127.0.0.1", "--directory", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    try:
        with sync_playwright() as pw:
            chrome = "/usr/bin/google-chrome"
            browser = pw.chromium.launch(executable_path=chrome, headless=True) if os.path.exists(chrome) else pw.chromium.launch(headless=True)
            for run in (run_mobile, run_small, run_desktop, run_auth_errors, run_safety, run_playback, run_races, run_phone_only):
                try:
                    run(browser)
                except Exception as exc:
                    check(f"{run.__name__} lief durch", False, repr(exc)[:600])
            browser.close()
    finally:
        server.terminate()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)} von {len(results)} Prüfungen bestanden")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
