"""Render the FGCensus static site from collected stats.

Every page ships fully rendered (names, numbers, charts) so search engines and
link previews see the content without running JavaScript. web/app.js only adds
sorting, search, local times and periodic refreshes on top.
"""
import hashlib
import html
import json
import math
import re
import shutil
import time
import unicodedata
from pathlib import Path

ROOT = Path(__file__).parent
SITE_URL = "https://fgcensus.info/"
FONTS = "https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Chivo+Mono:wght@400;600&family=Saira+Condensed:wght@800&display=swap"
ICON_FILES = ["favicon.svg", "favicon.png", "favicon.ico", "apple-touch-icon.png"]
FOOTER_NOTE = "Live counts from Steam's public player-count API, updated every hour."

esc = html.escape


def asset(name):
    """File name plus a short content hash, e.g. style.css?v=1a2b3c4d, so browsers refetch after a change."""
    digest = hashlib.sha1((ROOT / "web" / name).read_bytes()).hexdigest()[:8]
    return f"{name}?v={digest}"


def fmt(n):
    return f"{n:,}"


def slugify(name):
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-") or "game"


def assign_slugs(games):
    seen = {}
    for g in games:
        slug = slugify(g["name"])
        if slug in seen:
            slug = f"{slug}-{g['id']}"
        seen[slug] = g
        g["slug"] = slug


def utc(ts, pattern="%Y-%m-%d %H:%M UTC"):
    return time.strftime(pattern, time.gmtime(ts)) if ts else "—"


# ---------------------------------------------------------------- pieces

def head(title, description, canonical, prefix, image=None, extra=""):
    og_image = f'<meta property="og:image" content="{esc(image)}">\n' if image else ""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="{esc(canonical)}">
<meta property="og:site_name" content="FGCensus">
<meta property="og:type" content="website">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:url" content="{esc(canonical)}">
{og_image}<meta name="twitter:card" content="{'summary_large_image' if image else 'summary'}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.png" type="image/png" sizes="96x96">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{FONTS}">
<link rel="stylesheet" href="{prefix}{asset('style.css')}">
<script>window.goatcounter = {{path: function (p) {{ return location.host + p; }}}};</script>
<script data-goatcounter="https://rwall.goatcounter.com/count" async src="https://gc.zgo.at/count.js"></script>
{extra}</head>
<body>
"""


def live_status(state):
    return (f'<div class="live" id="live" data-swap data-polled="{state["polledAt"] or ""}" data-every="{state["pollEvery"]}" aria-live="polite">'
            f'<span class="pulse" aria-hidden="true"></span><span id="updated">updated {utc(state["polledAt"], "%H:%M UTC")}</span></div>')


def notice(state):
    days = (state["serverTime"] - state["historyFrom"]) / 86400 if state["historyFrom"] else 0
    msgs = []
    if state["games"] and days < 6.5:
        msgs.append(f"Only {max(days, 0):.1f} days of history so far — weekly numbers cover what's been collected.")
    if state["error"]:
        msgs.append(f"Last Steam check had a problem: {state['error']}.")
    text = " ".join(msgs)
    return f'<p class="notice" id="notice" data-swap{"" if text else " hidden"}>{esc(text)}</p>'


def footer(prefix, scripts=("app.js",)):
    tags = "".join(f'<script src="{prefix}{asset(name)}" defer></script>' for name in scripts)
    return f"""  <footer>
    <p>{FOOTER_NOTE}</p>
    <div class="legend">
      <span><i class="lg-dot"></i>now</span>
      <span><i class="lg-mean"></i>avg</span>
      <span><i class="lg-span"></i>low–high</span>
      <span><i class="lg-ath"></i>peak</span>
      <span>log scale</span>
    </div>
  </footer>
</div>
{tags}
</body>
</html>
"""


# shared log scale: 0 … 100k, same as the ladder header
SCALE_MAX = math.log10(100001)
TICKS = [(0, "0"), (10, "10"), (100, "100"), (1000, "1k"), (10000, "10k"), (100000, "100k")]


def pos(n):
    return f"{math.log10(n + 1) / SCALE_MAX * 100:.2f}%"


def gauge(g):
    ticks = "".join(f'<i class="grid-tick" style="left:{pos(v)}"></i>' for v, _ in TICKS[1:-1])
    return (f'<div class="gauge"><div class="track" role="img" aria-label="{fmt(g["now"])} now, low {fmt(g["min"])}, '
            f'average {fmt(g["mean"])}, peak {fmt(g["peak"])}">{ticks}'
            f'<i class="ath" style="left:{pos(g["peak"])}"></i>'
            f'<i class="span" style="left:{pos(g["min"])};width:calc({pos(g["max"])} - {pos(g["min"])})"></i>'
            f'<i class="mean" style="left:{pos(g["mean"])}"></i><i class="dot" style="left:{pos(g["now"])}"></i></div>'
            f'<div class="nums"><span>low <b>{fmt(g["min"])}</b></span><span class="avg">avg <b>{fmt(g["mean"])}</b></span>'
            f'<span>peak <b>{fmt(g["peak"])}</b></span></div></div>')


def thumb_img(g, key="img"):
    words = re.sub(r"[^A-Za-z0-9 ]", "", g["name"]).split()
    initials = "".join(w[0] for w in words[:2]).upper()
    src = g.get(key) or ""
    return (f'<img src="{esc(src)}" alt="" loading="lazy" '
            f'onerror="this.outerHTML=\'&lt;span class=&quot;ph&quot;&gt;{initials}&lt;/span&gt;\'">')


def row(g, prefix):
    href = f"{prefix}{g['slug']}/"
    classes = "row" + (" empty" if g["now"] == 0 else "") + (" top" if g["rank"] <= 10 else "")
    return f"""<li class="{classes}" data-name="{esc(g['name'].lower())}" data-now="{g['now']}" data-mean="{g['mean']}" data-max="{g['max']}" data-peak="{g['peak']}">
  <span class="rank" title="Rank by players now">{g['rank']}</span>
  <a class="thumb" href="{href}" tabindex="-1" aria-hidden="true">{thumb_img(g)}</a>
  <div class="who">
    <a class="name" href="{href}">{esc(g['name'])}</a>
    <span class="meta"><a href="https://store.steampowered.com/app/{g['id']}">Steam</a><a href="https://steamcharts.com/app/{g['id']}">SteamCharts</a></span>
  </div>
  <span class="now" aria-label="{fmt(g['now'])} players now">{fmt(g['now'])}</span>
  {gauge(g)}
</li>"""


def ladder_head():
    axis = "".join(f'<span style="left:{pos(v)}">{label}</span>' for v, label in TICKS)
    return (f'<div class="ladder-head" aria-hidden="true"><span class="r">#</span><span></span><span>Game</span>'
            f'<span class="r">Now</span><div class="axis">{axis}</div></div>')


MAX_GAP_HOURS = 6


def nice_ceiling(v):
    if v <= 0:
        return 1, 1
    raw = v / 4
    mag = 10 ** math.floor(math.log10(raw))
    step = next(s * mag for s in (1, 2, 2.5, 5, 10) if s * mag >= raw)
    step = max(1, round(step))
    return math.ceil(v / step) * step, step


def chart(g, hourly, hour0, hour_end):
    values = [hourly.get(h) for h in range(hour0, hour_end + 1)]
    present = [v for v in values if v is not None]
    if len(present) < 2:
        return '<p class="chart-note">Not enough history yet to draw the past week.</p>'
    top, step = nice_ceiling(max(present))
    n = len(values) - 1
    x = lambda i: i / n * 1000
    y = lambda v: 220 - v / top * 220

    # bridge short gaps (a few skipped hourly checks); only long outages break the line
    segments, cur = [], []
    for i, v in enumerate(values):
        if v is None:
            continue
        if cur and i - cur[-1] > MAX_GAP_HOURS:
            segments.append(cur)
            cur = []
        cur.append(i)
    if cur:
        segments.append(cur)
    line = "".join("M" + "L".join(f"{x(i):.1f},{y(values[i]):.1f}" for i in s) for s in segments)
    area = "".join(f"M{x(s[0]):.1f},220" + "".join(f"L{x(i):.1f},{y(values[i]):.1f}" for i in s) + f"L{x(s[-1]):.1f},220Z"
                   for s in segments if len(s) > 1)

    grid, labels = [], []
    for v in range(0, top + 1, step):
        grid.append(f'<line class="chart-grid" x1="0" x2="1000" y1="{y(v):.1f}" y2="{y(v):.1f}"/>')
        labels.append(f'<span class="ylab" style="top:{y(v) / 220 * 100:.2f}%">{fmt(v)}</span>')
    for i, h in enumerate(range(hour0, hour_end + 1)):
        if h % 24 == 0:
            t = time.gmtime(h * 3600)
            labels.append(f'<span class="xlab" style="left:{x(i) / 10:.2f}%">{time.strftime("%a", t)}<span class="xday"> {t.tm_mday}</span></span>')
            grid.append(f'<line class="chart-grid" x1="{x(i):.1f}" x2="{x(i):.1f}" y1="0" y2="220"/>')

    last = max(i for i, v in enumerate(values) if v is not None)
    dot = f'<i class="dot" style="left:{x(last) / 10:.2f}%;top:{y(values[last]) / 220 * 100:.2f}%"></i>'
    return (f'<div class="chart"><svg viewBox="0 0 1000 220" preserveAspectRatio="none" role="img" '
            f'aria-label="{esc(g["name"])} players per hour over the last 7 days, peaking at {fmt(round(max(present)))}">'
            f'{"".join(grid)}<path class="chart-area" d="{area}"/><path class="chart-line" d="{line}"/></svg>'
            f'{"".join(labels)}{dot}</div>'
            f'<p class="chart-note">Hourly average of concurrent players, UTC days. Brief outage drops are left out.</p>')


# ---------------------------------------------------------------- pages

def home_page(state, ranked):
    total = sum(g["now"] for g in ranked)
    online = sum(1 for g in ranked if g["now"] > 0)
    top_names = ", ".join(g["name"] for g in ranked[:3])
    title = "FGCensus – Fighting Game Player Counts on Steam"
    description = (f"Live Steam player counts for {len(ranked)} fighting games — {top_names} and more. "
                   f"Current players, low, average and peak, updated every hour.")
    jsonld = json.dumps([
        {"@context": "https://schema.org", "@type": "WebSite", "name": "FGCensus", "url": SITE_URL},
        {"@context": "https://schema.org", "@type": "Dataset", "name": "Steam player counts for fighting games",
         "description": description, "url": SITE_URL, "isAccessibleForFree": True,
         "dateModified": utc(state["polledAt"], "%Y-%m-%dT%H:%M:%SZ"),
         "variableMeasured": ["Concurrent players", "Weekly low", "Weekly average", "Weekly high", "All-time peak"],
         "distribution": [{"@type": "DataDownload", "encodingFormat": "application/json",
                           "contentUrl": SITE_URL + "api/state.json"}]},
    ], ensure_ascii=False).replace("</", "<\\/")
    extra = f'<script type="application/ld+json">{jsonld}</script>\n'

    rows = "\n".join(row(g, "") for g in ranked)
    return head(title, description, SITE_URL, "", extra=extra) + f"""<div class="wrap">
  <header class="bar">
    <p class="tally" id="tally" data-swap><span><strong>{fmt(total)}</strong> playing right now</span><span><strong>{len(ranked)}</strong> games tracked</span><span><strong>{online}</strong> with someone playing</span></p>
    {live_status(state)}
  </header>
  {notice(state)}

  <main>
    <div class="controls">
      <input class="search" id="q" type="search" placeholder="Find a game…" aria-label="Find a game">
      <button type="button" class="compare-btn" id="compare-open" aria-haspopup="dialog">
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 12l3.5-4 3 2.5L14 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 8.5l3.5 1.5 3-4L14 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity=".5"/></svg>
        Compare
      </button>
      <div class="seg" role="group" aria-label="Sort by" id="sort">
        <button type="button" data-k="now" aria-pressed="true">Now</button>
        <button type="button" data-k="mean" aria-pressed="false">Avg</button>
        <button type="button" data-k="peak" aria-pressed="false">Peak</button>
        <button type="button" data-k="name" aria-pressed="false">A–Z</button>
      </div>
      <span class="count" id="count">{len(ranked)} games</span>
    </div>
    {ladder_head()}
    <ol class="ladder" id="ladder" data-swap>
{rows}
    </ol>
    <p class="none" id="no-match" hidden></p>
  </main>

  <dialog class="compare" id="compare" aria-labelledby="compare-title">
    <div class="cmp-head">
      <h2 id="compare-title">Compare games</h2>
      <button type="button" class="cmp-close" id="compare-close" aria-label="Close">×</button>
    </div>
    <div class="cmp-body">
      <div class="cmp-pick">
        <input class="search" id="cmp-q" type="search" placeholder="Add a game…" aria-label="Search games to compare">
        <p class="cmp-hint" id="cmp-hint">Pick 2 to 5 games.</p>
        <ul class="cmp-list" id="cmp-list"></ul>
      </div>
      <div class="cmp-view">
        <div class="cmp-chips" id="cmp-chips"></div>
        <div class="cmp-stage">
          <canvas id="cmp-canvas" width="2400" height="1350" role="img" aria-label="" hidden></canvas>
          <p class="cmp-empty" id="cmp-empty">Pick at least two games to see the comparison.</p>
        </div>
        <div class="cmp-actions">
          <button type="button" class="cmp-primary" id="cmp-download" disabled>Download image</button>
          <button type="button" class="cmp-secondary" id="cmp-link" disabled>Copy link</button>
          <span class="cmp-status" id="cmp-status" aria-live="polite"></span>
        </div>
      </div>
    </div>
  </dialog>

""" + footer("", ("app.js", "compare.js"))


def game_page(state, g, ranked, hourly):
    canonical = f"{SITE_URL}{g['slug']}/"
    title = f"{g['name']} Player Count on Steam – FGCensus"
    description = (f"{g['name']} has {fmt(g['now'])} players on Steam right now. Over the past week: "
                   f"low {fmt(g['min'])}, average {fmt(g['mean'])}. Peak: {fmt(g['peak'])}. Updated every hour.")
    since = state["serverTime"] - 7 * 24 * 3600
    hero = g.get("header") or g.get("img") or ""

    return head(title, description, canonical, "../", image=hero) + f"""<div class="wrap">
  <header class="bar">
    <a class="back" href="../">← All fighting games</a>
    {live_status(state)}
  </header>
  {notice(state)}

  <main id="game" data-swap>
    <section class="game-head">
      <div class="game-art">{thumb_img(g, "header" if g.get("header") else "img")}</div>
      <div>
        <h1 class="game-title">{esc(g['name'])} player count<small>#{g['rank']} of {len(ranked)} fighting games on Steam right now</small></h1>
        <dl class="stats">
          <div class="big"><dt>Playing now</dt><dd>{fmt(g['now'])}</dd></div>
          <div><dt>Low</dt><dd>{fmt(g['min'])}</dd></div>
          <div class="avg"><dt>Avg</dt><dd>{fmt(g['mean'])}</dd></div>
          <div><dt>Peak</dt><dd>{fmt(g['peak'])}</dd></div>
        </dl>
      </div>
    </section>

    <section class="panel">
      <h2>Past 7 days</h2>
      {chart(g, hourly, since // 3600 + 1, state["serverTime"] // 3600)}
    </section>

    <div class="about">
      <p>{esc(g['name'])} has {fmt(g['now'])} concurrent players on Steam as of {utc(state['polledAt'])}. Over the last seven days it averaged {fmt(g['mean'])} players, with a low of {fmt(g['min'])}. Its peak is {fmt(g['peak'])} concurrent players.</p>
      <p><a href="https://store.steampowered.com/app/{g['id']}">Steam store page</a> · <a href="https://steamcharts.com/app/{g['id']}">SteamCharts</a> · <a href="https://steamdb.info/app/{g['id']}/charts/">SteamDB</a></p>
    </div>
  </main>

""" + footer("../")


def not_found_page(state):
    return head("Page not found – FGCensus", "This page doesn't exist.", SITE_URL, "/") + f"""<div class="wrap">
  <header class="bar"><a class="back" href="/">← All fighting games</a>{live_status(state)}</header>
  <main><p class="none">This page doesn't exist — the game may have been renamed or removed.</p></main>

""" + footer("/")


# ---------------------------------------------------------------- build

def build(state, hourly_by_id, site):
    site = Path(site)
    games = state["games"]
    assign_slugs(games)
    ranked = sorted(games, key=lambda g: (-g["now"], -g["mean"]))
    for rank, g in enumerate(ranked, 1):
        g["rank"] = rank

    # start clean so pages of removed games disappear
    for child in site.iterdir() if site.exists() else []:
        if child.is_dir() and child.name != "api":
            shutil.rmtree(child)
    site.mkdir(parents=True, exist_ok=True)

    shutil.copy(ROOT / "web" / "style.css", site / "style.css")
    for name in ("app.js", "compare.js"):
        shutil.copy(ROOT / "web" / name, site / name)
    for name in ICON_FILES:
        shutil.copy(ROOT / "web" / name, site / name)
    (site / "index.html").write_text(home_page(state, ranked), encoding="utf-8")
    (site / "404.html").write_text(not_found_page(state), encoding="utf-8")
    for g in ranked:
        (site / g["slug"]).mkdir(exist_ok=True)
        (site / g["slug"] / "index.html").write_text(game_page(state, g, ranked, hourly_by_id.get(g["id"], {})), encoding="utf-8")

    lastmod = utc(state["polledAt"], "%Y-%m-%dT%H:%M:%SZ")
    urls = [SITE_URL] + [f"{SITE_URL}{g['slug']}/" for g in ranked]
    (site / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(f"  <url><loc>{u}</loc><lastmod>{lastmod}</lastmod></url>\n" for u in urls)
        + "</urlset>\n", encoding="utf-8")
    (site / "robots.txt").write_text(f"User-agent: *\nAllow: /\n\nSitemap: {SITE_URL}sitemap.xml\n", encoding="utf-8")
    return len(urls)
