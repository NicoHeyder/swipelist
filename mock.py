"""Nachbau der benötigten Spotify-Schnittstellen für die Browser-Tests.

Spotify-Formen nach dem Web API Changelog Februar 2026 (Development Mode):
/playlists/{id}/items statt /tracks, Feld "item" statt "track", "items.total" statt "tracks.total".
"""
import io
import json
from urllib.parse import urlparse, parse_qs, unquote

from PIL import Image, ImageDraw

APP = "http://127.0.0.1:8765"
CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Expose-Headers": "Retry-After",
}


def make_png(seed):
    palette = [(35, 57, 91), (242, 165, 65), (233, 228, 212), (120, 60, 130), (40, 120, 100), (190, 70, 60), (60, 60, 70)]
    bg = palette[seed % len(palette)]
    fg = palette[(seed * 3 + 1) % len(palette)]
    img = Image.new("RGB", (300, 300), bg)
    d = ImageDraw.Draw(img)
    r = 60 + (seed * 13) % 70
    d.ellipse([150 - r + (seed % 5) * 8, 130 - r, 150 + r + (seed % 5) * 8, 130 + r], fill=fg)
    d.rectangle([0, 230, 300, 250], fill=palette[(seed + 2) % len(palette)])
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def track_obj(n, name=None, artist=None):
    tid = f"t{n:03d}"
    return {
        "id": tid,
        "uri": f"spotify:track:{tid}",
        "type": "track",
        "name": name or f"Nachtbus {n}",
        "artists": [{"name": artist or f"Kollektiv {chr(65 + n % 26)}"}],
        "album": {"name": f"Album {n}", "images": [
            {"url": f"https://i.scdn.co/image/{n}-640", "width": 640, "height": 640},
            {"url": f"https://i.scdn.co/image/{n}-300", "width": 300, "height": 300},
            {"url": f"https://i.scdn.co/image/{n}-64", "width": 64, "height": 64},
        ]},
        "duration_ms": 200000 + n,
        "external_ids": {"isrc": f"DEXX{n:08d}"},
    }


def entry(item, is_local=False):
    return {"added_at": "2026-03-01T10:00:00Z", "added_by": {"id": "nico"}, "is_local": is_local, "item": item, "track": item}


class World:
    def __init__(self):
        self.me = {"id": "nico", "display_name": "Nico", "type": "user", "uri": "spotify:user:nico"}
        self.playlists = {}
        self.order = []
        self.snap = 0
        self.log = []          # (methode, pfad) aller Spotify-Abrufe
        self.writes = []       # (aktion, playlist, uris, position)
        self.tokens = {"AT1"}
        self.token_calls = []
        self.force_401_once = False
        self.force_429 = None  # {"retry_after": 2, "reason": ""} für den nächsten Abruf
        self.fail_delete = 0   # so viele DELETE-Abrufe scheitern mit 500, ohne etwas zu ändern
        self.fail_add = 0      # so viele POST-Abrufe (Titel hinzufügen) scheitern mit 500, ohne etwas zu ändern
        self.ghost_add = 0     # so viele POST-Abrufe werden ausgeführt, melden aber 504 (unklarer Ausgang)
        self.encode_desc = False  # Beschreibung mit umschriebenem Doppelpunkt liefern
        self.custom_images = {}   # Playlist-Kennung -> eigene Bildliste (zum Beispiel von einem fremden Server)
        self.no_cover = set()
        self.searches = []
        self.genres = True
        self.no_top = False
        self.devices_forbidden = False
        self.devices = [
            {"id": "d1", "name": "Nicos Rechner", "type": "Computer", "is_active": True},
            {"id": "d2", "name": "Nicos Handy", "type": "Smartphone", "is_active": False},
        ]

        roadtrip = []
        for n in range(1, 61):
            roadtrip.append(entry(track_obj(n)))
        # Sonderfälle: lokale Datei, Podcast-Folge, gelöschter Titel, Dublette
        roadtrip.insert(5, entry({"id": None, "uri": "spotify:local:x", "type": "track", "name": "Lokal", "is_local": True}, True))
        roadtrip.insert(12, entry({"id": "ep1", "uri": "spotify:episode:ep1", "type": "episode", "name": "Folge"}))
        roadtrip.insert(20, {"added_at": None, "is_local": False, "item": None, "track": None})
        roadtrip.insert(40, entry(track_obj(3)))  # Titel 3 ein zweites Mal
        self.add_playlist("pl1", "Roadtrip", "nico", roadtrip)
        self.add_playlist("pl2", "Fremde Liste", "jemand", [entry(track_obj(900))])
        self.add_playlist("pl3", "Gym", "nico", [entry(track_obj(n)) for n in range(101, 106)])
        self.add_playlist("pl4", "Leer", "nico", [])
        long_name = track_obj(301, "Ein außergewöhnlich langer Titelname, der nicht in eine Zeile passt (Remastered 2011)", "Łukasz Żółć & The Very Long Band Name Orchestra")
        self.add_playlist("pl5", "Sonderfälle", "nico", [entry(long_name), entry(track_obj(302))])
        self.no_cover.add("302")
        self.add_playlist("pl6", "Groß", "nico", [entry(track_obj(n)) for n in range(400, 630)])
        self.add_playlist("pl7", "Gemeinsam", "jemand", [entry(track_obj(901))], collaborative=True)

    def add_playlist(self, pid, name, owner, entries, description=None, public=False, collaborative=False):
        self.snap += 1
        self.playlists[pid] = {"id": pid, "name": name, "owner": owner, "entries": entries, "description": description,
                               "public": public, "snapshot": f"snap{self.snap}", "collaborative": collaborative}
        self.order.append(pid)

    def bump(self, pid):
        self.snap += 1
        self.playlists[pid]["snapshot"] = f"snap{self.snap}"
        return self.playlists[pid]["snapshot"]

    def uris(self, pid):
        return [e["item"]["uri"] if e.get("item") else None for e in self.playlists[pid]["entries"]]

    def simple(self, pid):
        p = self.playlists[pid]
        total = len(p["entries"])
        first = next((e["item"] for e in p["entries"] if e.get("item") and e["item"].get("album")), None)
        description = p["description"]
        if description and self.encode_desc:
            description = description.replace(":", "&#x3A;")
        return {
            "id": p["id"], "name": p["name"], "description": description, "public": p["public"],
            "collaborative": p["collaborative"], "snapshot_id": p["snapshot"], "type": "playlist",
            "owner": {"id": p["owner"], "display_name": p["owner"]},
            "images": self.custom_images.get(pid, first["album"]["images"] if first else None),
            "items": {"href": f"https://api.spotify.com/v1/playlists/{pid}/items", "total": total},
            "tracks": {"href": f"https://api.spotify.com/v1/playlists/{pid}/tracks", "total": total},
        }

    # ---------- Spotify ----------

    def spotify(self, method, url, headers, body):
        u = urlparse(url)
        path = u.path[len("/v1"):]
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if method == "OPTIONS":
            return 204, None, {}
        self.log.append((method, path))
        token = (headers.get("authorization") or "").replace("Bearer ", "")
        if self.force_401_once:
            self.force_401_once = False
            self.tokens.discard(token)
            return 401, {"error": {"status": 401, "message": "The access token expired"}}, {}
        if token not in self.tokens:
            return 401, {"error": {"status": 401, "message": "Invalid access token"}}, {}
        if self.force_429:
            f = self.force_429
            self.force_429 = None
            payload = {"error": {"status": 429, "message": "API rate limit exceeded"}}
            if f.get("reason"):
                payload["reason"] = f["reason"]
            return 429, payload, ({} if f.get("no_header") else {"Retry-After": str(f.get("retry_after", 0))})

        data = json.loads(body) if body else {}
        parts = [p for p in path.split("/") if p]

        if method == "GET" and path == "/me":
            return 200, self.me, {}
        if method == "GET" and path == "/me/playlists":
            limit, offset = int(q.get("limit", 20)), int(q.get("offset", 0))
            assert limit <= 50
            # nur eigene und abonnierte Playlists
            ids = self.order
            page = ids[offset:offset + limit]
            nxt = f"https://api.spotify.com/v1/me/playlists?offset={offset + limit}&limit={limit}" if offset + limit < len(ids) else None
            return 200, {"items": [self.simple(i) for i in page], "total": len(ids), "limit": limit, "offset": offset, "next": nxt}, {}
        if method == "POST" and path == "/me/playlists":
            pid = f"new{len(self.playlists) + 1}"
            self.add_playlist(pid, data["name"], self.me["id"], [], data.get("description"), data.get("public", True))
            self.writes.append(("create", pid, data["name"], data.get("public", True)))
            return 201, self.simple(pid), {}
        if len(parts) == 3 and parts[0] == "playlists" and parts[2] == "items":
            pid = unquote(parts[1])
            if pid not in self.playlists:
                return 404, {"error": {"status": 404, "message": "Not found"}}, {}
            p = self.playlists[pid]
            if p["owner"] != self.me["id"]:
                return 403, {"error": {"status": 403, "message": "Forbidden"}}, {}
            if method == "GET":
                limit, offset = int(q.get("limit", 20)), int(q.get("offset", 0))
                assert limit <= 50
                page = p["entries"][offset:offset + limit]
                nxt = "x" if offset + limit < len(p["entries"]) else None
                return 200, {"items": page, "total": len(p["entries"]), "limit": limit, "offset": offset, "next": nxt}, {}
            if method == "POST":
                uris = data["uris"]
                assert 1 <= len(uris) <= 100
                if self.fail_add > 0:
                    self.fail_add -= 1
                    return 500, {"error": {"status": 500, "message": "Server error"}}, {}
                pos = data.get("position")
                if pos is not None and pos > len(p["entries"]):
                    return 400, {"error": {"status": 400, "message": "Index out of bounds"}}, {}
                new = [entry(track_obj(int(u.split(":t")[-1]))) for u in uris]
                if pos is None:
                    p["entries"].extend(new)
                else:
                    p["entries"][pos:pos] = new
                self.writes.append(("add", pid, list(uris), pos))
                self.bump(pid)
                if self.ghost_add > 0:
                    self.ghost_add -= 1
                    return 504, {"error": {"status": 504, "message": "Gateway timeout"}}, {}
                return 201, {"snapshot_id": p["snapshot"]}, {}
            if method == "DELETE":
                if self.fail_delete > 0:
                    self.fail_delete -= 1
                    return 500, {"error": {"status": 500, "message": "Server error"}}, {}
                assert "tracks" not in data, "alter Parametername"
                uris = [i["uri"] for i in data["items"]]
                assert 1 <= len(uris) <= 100
                p["entries"] = [e for e in p["entries"] if not (e.get("item") and e["item"]["uri"] in uris)]
                self.writes.append(("remove", pid, list(uris), None))
                return 200, {"snapshot_id": self.bump(pid)}, {}
        if method == "GET" and path == "/search":
            assert int(q.get("limit", 5)) <= 10
            self.searches.append(q.get("q"))
            return 200, {"tracks": {"items": [track_obj(1), track_obj(2)], "total": 2}}, {}
        if method == "GET" and path == "/me/top/artists":
            if self.no_top:
                return 200, {"items": [], "total": 0}, {}
            return 200, {"items": [{"id": "a1", "name": 'Kollektiv "A"', "genres": ["indie"] if self.genres else []}]}, {}
        if method == "GET" and path == "/me/top/tracks":
            if self.no_top:
                return 200, {"items": [], "total": 0}, {}
            t = track_obj(1)
            t["artists"] = [{"id": "a9", "name": "Kollektiv B"}]
            return 200, {"items": [t, track_obj(2)]}, {}
        if method == "GET" and path == "/me/player/recently-played":
            return 200, {"items": [{"track": track_obj(1), "played_at": "2026-11-10T20:00:00Z"}]}, {}
        if method == "GET" and path == "/me/tracks":
            return 200, {"items": [{"added_at": "2026-01-01T00:00:00Z", "track": track_obj(7)}], "total": 412}, {}
        if method == "GET" and len(parts) == 3 and parts[0] == "artists" and parts[2] == "albums":
            return 200, {"items": [{"id": "al1", "name": "Album 1"}, {"id": "al2", "name": "Album 2"}], "total": 2}, {}
        if method == "GET" and len(parts) == 3 and parts[0] == "albums" and parts[2] == "tracks":
            return 200, {"items": [{"id": "t001", "name": "Nachtbus 1", "artists": [{"id": "a1", "name": "A"}, {"id": "a2", "name": "B"}]}], "total": 1}, {}
        if method == "GET" and path == "/me/player/devices":
            if self.devices_forbidden:
                return 403, {"error": {"status": 403, "message": "Insufficient client scope"}}, {}
            return 200, {"devices": self.devices}, {}
        return 404, {"error": {"status": 404, "message": f"Nicht nachgebaut: {method} {path}"}}, {}

    def token(self, body):
        f = {k: v[0] for k, v in parse_qs(body).items()}
        self.token_calls.append(f)
        if f.get("grant_type") == "authorization_code":
            ok = f.get("code") == "CODE123" and f.get("redirect_uri") == APP + "/" and f.get("client_id") and len(f.get("code_verifier", "")) >= 43
            if not ok:
                return 400, {"error": "invalid_grant", "error_description": "Invalid authorization code"}
            self.tokens = {"AT1"}
            return 200, {"access_token": "AT1", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "RT1", "scope": "x"}
        if f.get("grant_type") == "refresh_token":
            if f.get("refresh_token") not in ("RT1", "RT2") or not f.get("client_id"):
                return 400, {"error": "invalid_grant", "error_description": "Invalid refresh token"}
            new = f"AT{len(self.token_calls) + 1}"
            self.tokens = {new}
            return 200, {"access_token": new, "token_type": "Bearer", "expires_in": 3600, "refresh_token": "RT2"}
        return 400, {"error": "unsupported_grant_type"}
