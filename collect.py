"""FGCensus collector.

Checks Steam's public player-count API for every game in games.json, adds the
result to a rolling week of history, and writes the static site:

    site/index.html        the page
    site/api/state.json    what the page shows

Runs hourly in GitHub Actions (see .github/workflows/update.yml), which keeps
history.json on the `data` branch. Locally:

    python collect.py
    python -m http.server 8765 -d site
"""
import argparse
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import render

ROOT = Path(__file__).parent
POLL_EVERY = 60 * 60
WEEK = 7 * 24 * 3600
KEEP = 8 * 24 * 3600
UA = {"User-Agent": "Mozilla/5.0 (fgcensus)"}
PLAYERS_API = "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid={}"
HISTORY_API = "https://steamcharts.com/app/{}/chart-data.json"
DETAILS_API = "https://store.steampowered.com/api/appdetails?appids={}&filters=basic"
CAPSULE_FALLBACK = "https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/{}/capsule_231x87.jpg"
HEADER_FALLBACK = "https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/{}/header.jpg"

OUTAGE_WINDOW = 3      # hours either side used as the "normal" reference
OUTAGE_RATIO = 0.25    # a reading below 25% of the neighbouring hours is a dip…
OUTAGE_FLOOR = 8       # …but only when those hours had enough players to tell


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def fetch(url, timeout=20):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return json.loads(r.read())


# ---------------------------------------------------------------- collection

def poll(games, history):
    def one(g):
        try:
            res = fetch(PLAYERS_API.format(g["id"]))["response"]
            return (g["id"], res["player_count"]) if res.get("result") == 1 else None
        except Exception:
            return None

    ts = int(time.time())
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = [r for r in pool.map(one, games) if r]
    for appid, players in results:
        history["samples"].setdefault(str(appid), []).append([ts, players])
    log(f"polled {len(results)}/{len(games)} games")
    return ts, len(results)


def seed(games, history):
    """Backfill a week from SteamCharts for games added since the last run (best effort)."""
    now = int(time.time())
    cutoff = now - WEEK
    todo = [g for g in games if g["id"] not in history["seeded"]]
    for g in todo:
        try:
            points = [[ms // 1000, int(p)] for ms, p in fetch(HISTORY_API.format(g["id"])) if ms // 1000 >= cutoff]
            # SteamCharts skips hours where nobody played, but also hours it simply missed.
            # Only a mostly-empty week means the gaps are real zeros; otherwise leave them unknown.
            have = {ts // 3600 for ts, _ in points}
            if len(have) < WEEK // 3600 / 2:
                points += [[h * 3600, 0] for h in range(cutoff // 3600 + 1, now // 3600) if h not in have]
            history["samples"].setdefault(str(g["id"]), []).extend(points)
            log(f"seeded {g['name']} with {len(points)} readings")
        except Exception as e:
            log(f"no SteamCharts history for {g['name']}: {e}")
        history["seeded"].append(g["id"])
        time.sleep(0.5)


def find_art(games, history):
    """Steam capsule (list thumbnail) and header (game page) image URLs, looked up once per game."""
    for g in games:
        key = str(g["id"])
        if isinstance(history["art"].get(key), dict):
            continue
        art = {"capsule": CAPSULE_FALLBACK.format(g["id"]), "header": HEADER_FALLBACK.format(g["id"])}
        try:
            d = fetch(DETAILS_API.format(g["id"])).get(key, {}).get("data") or {}
            art = {"capsule": d.get("capsule_image") or art["capsule"], "header": d.get("header_image") or art["header"]}
        except Exception:
            pass
        history["art"][key] = art
        time.sleep(0.3)


def prune(history, now):
    for key, rows in list(history["samples"].items()):
        rows = sorted(r for r in rows if r[0] >= now - KEEP)
        if rows:
            history["samples"][key] = rows
        else:
            del history["samples"][key]  # e.g. a game removed from games.json over a week ago


# ---------------------------------------------------------------- stats

def week_stats(samples):
    """Weekly low/avg/peak, ignoring maintenance dips.

    Steam maintenance or a game's server downtime shows up as a sudden crash
    to (near) zero for a short while. Any reading far below the median of the
    surrounding hours is treated as such an outage and left out. Small games
    whose neighbours are already near zero are never touched, so a real
    0-player hour still counts.
    """
    by_hour = {}
    for ts, p in samples:
        by_hour.setdefault(ts // 3600, []).append(p)
    hourly = {h: sum(v) / len(v) for h, v in by_hour.items()}

    kept = {}
    dips = 0
    for h, values in by_hour.items():
        near = sorted(hourly[n] for n in range(h - OUTAGE_WINDOW, h + OUTAGE_WINDOW + 1)
                      if n != h and n in hourly)
        ref = near[len(near) // 2] if len(near) >= 2 else None
        good = [p for p in values if ref is None or ref < OUTAGE_FLOOR or p >= ref * OUTAGE_RATIO]
        dips += len(values) - len(good)
        if good:
            kept[h] = good

    values = [p for v in kept.values() for p in v]
    if not values:
        return None
    means = {h: sum(v) / len(v) for h, v in kept.items()}
    return {
        "min": min(values),
        "max": max(values),
        # mean of hourly means, so denser stretches of data don't outweigh the rest
        "mean": round(sum(means.values()) / len(means)),
        "dips": dips,
        "hourly": means,
    }


def build_state(games, history, polled_at, error):
    """Returns (state for api/state.json, hourly averages per game for the charts)."""
    now = int(time.time())
    since = now - WEEK
    out = []
    hourly = {}
    oldest = None
    for g in games:
        rows = history["samples"].get(str(g["id"]))
        if not rows:
            continue
        ts, p = rows[-1]
        week = [r for r in rows if r[0] >= since]
        if week:
            oldest = min(oldest or week[0][0], week[0][0])
        stats = week_stats(week) or {"min": p, "max": p, "mean": p, "dips": 0, "hourly": {}}
        hourly[g["id"]] = stats.pop("hourly")
        art = history["art"].get(str(g["id"])) or {}
        out.append({**g, "img": art.get("capsule"), "header": art.get("header"), "now": p, "seenAt": ts, **stats})
    return {
        "games": out,
        "polledAt": polled_at,
        "pollEvery": POLL_EVERY,
        "historyFrom": oldest,
        "seeding": False,
        "error": error,
        "serverTime": now,
    }, hourly


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", default="history.json")
    ap.add_argument("--site", default="site")
    args = ap.parse_args()
    sys.stdout.reconfigure(errors="replace")  # game names vs. Windows console code pages

    games = json.loads((ROOT / "games.json").read_text(encoding="utf-8"))
    hist_path = Path(args.history)
    history = json.loads(hist_path.read_text(encoding="utf-8")) if hist_path.exists() else {}
    history.setdefault("samples", {})
    history.setdefault("seeded", [])
    history.setdefault("art", {})
    last = history.get("polledAt")

    seed(games, history)
    find_art(games, history)
    ts, ok = poll(games, history)
    error = None
    if ok:
        history["polledAt"] = last = ts
    else:
        error = "Steam didn't answer this hour"
    prune(history, int(time.time()))

    hist_path.write_text(json.dumps(history, separators=(",", ":")), encoding="utf-8")

    site = Path(args.site)
    state, hourly = build_state(games, history, last, error)
    pages = render.build(state, hourly, site)
    (site / "api").mkdir(parents=True, exist_ok=True)
    public = {**state, "games": [{k: v for k, v in g.items() if k != "rank"} for g in state["games"]]}
    (site / "api" / "state.json").write_text(json.dumps(public, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"wrote {site}: {pages} pages, {len(state['games'])} games")


if __name__ == "__main__":
    main()
