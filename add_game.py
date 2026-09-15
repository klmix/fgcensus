"""Add games to games.json from Steam links.

Accepts store links, SteamDB/SteamCharts links or plain app ids, separated by
spaces, commas or new lines:

    python add_game.py https://store.steampowered.com/app/1364780/Street_Fighter_6/

Used by the "Add game" GitHub workflow, which passes the links in the LINKS
environment variable. Prints a Markdown summary.
"""
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
DETAILS_API = "https://store.steampowered.com/api/appdetails?appids={}&filters=basic"


def app_ids(text):
    ids = []
    for token in re.split(r"[\s,;]+", text.strip()):
        m = re.search(r"(?:/app/|/apps?/|appid=)(\d+)", token) or re.fullmatch(r"(\d+)", token)
        if m:
            ids.append(int(m.group(1)))
        elif token:
            print(f"- ⚠️ Not a Steam link or app id: `{token}`")
    return list(dict.fromkeys(ids))


def steam_name(appid):
    req = urllib.request.Request(DETAILS_API.format(appid), headers={"User-Agent": "Mozilla/5.0 (fgcensus)"})
    with urllib.request.urlopen(req, timeout=20) as r:
        entry = json.loads(r.read()).get(str(appid), {})
    if not entry.get("success"):
        return None, None
    return entry["data"]["name"], entry["data"].get("type")


def main():
    games_path = Path(os.environ.get("GAMES_FILE", ROOT / "games.json"))
    text = os.environ.get("LINKS") or " ".join(sys.argv[1:])
    games = json.loads(games_path.read_text(encoding="utf-8"))
    known = {g["id"]: g["name"] for g in games}

    ids = app_ids(text)
    if not ids:
        print("- ❌ No Steam app ids found in the input.")
        sys.exit(1)

    added = 0
    for appid in ids:
        if appid in known:
            print(f"- Already tracked: **{known[appid]}** ({appid})")
            continue
        name, kind = steam_name(appid)
        if not name:
            print(f"- ❌ Steam has no store page for app {appid}")
            continue
        if kind != "game":
            print(f"- ❌ **{name}** ({appid}) is a {kind}, not a game")
            continue
        games.append({"id": appid, "name": name})
        known[appid] = name
        added += 1
        print(f"- ✅ Added **{name}** ({appid})")

    if added:
        games_path.write_text("[\n" + ",\n".join("  " + json.dumps(g, ensure_ascii=False) for g in games) + "\n]\n",
                              encoding="utf-8")


if __name__ == "__main__":
    main()
