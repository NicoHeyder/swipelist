"""Setzt die Versionsnummer überall, wo sie gebraucht wird.

Aufruf: python3 tools/set_version.py 0.2.1

Die Nummer hängt als ?v=... an allen Skripten und am Stil. So lädt der Browser nach einem Update
garantiert die neuen Dateien und mischt nie alte und neue. version.json meldet der laufenden App,
dass es eine neue Version gibt.
"""
import json
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parent.parent
v = sys.argv[1]
assert re.fullmatch(r"\d+\.\d+\.\d+", v), "Format: 1.2.3"

for name in ["app.js", "player.js", "spotify.js", "logic.js", "store.js"]:
    p = root / name
    s = p.read_text(encoding="utf-8")
    s = re.sub(r"from '(\./[a-z]+\.js)(\?v=[0-9.]+)?'", lambda m: f"from '{m.group(1)}?v={v}'", s)
    if name == "app.js":
        s = re.sub(r"const VERSION = '[0-9.]+';", f"const VERSION = '{v}';", s)
    p.write_text(s, encoding="utf-8")

p = root / "index.html"
s = p.read_text(encoding="utf-8")
s = re.sub(r'(href|src)="(styles\.css|config\.js|app\.js)(\?v=[0-9.]+)?"', lambda m: f'{m.group(1)}="{m.group(2)}?v={v}"', s)
p.write_text(s, encoding="utf-8")

(root / "version.json").write_text(json.dumps({"version": v}) + "\n", encoding="utf-8")
print("Version", v)
