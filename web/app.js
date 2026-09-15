// FGCensus page behaviour. The pages arrive fully rendered; this script only
// shows the update time in the viewer's timezone, sorts/filters the ladder,
// and swaps in freshly published numbers every few minutes.
(() => {
  const REFRESH_MS = 5 * 60_000;
  const $ = id => document.getElementById(id);
  const ui = { sort: "now", q: "" };
  let offline = false;

  function ago(sec) {
    if (sec < 60) return "just now";
    const m = Math.round(sec / 60);
    return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  }

  function renderStatus() {
    const box = $("live");
    if (!box) return;
    if (offline) {
      box.className = "live live-down";
      $("updated").textContent = "Couldn't refresh — showing the last numbers";
      return;
    }
    const polled = Number(box.dataset.polled), every = Number(box.dataset.every);
    if (!polled) return;
    const age = Date.now() / 1000 - polled;
    const stale = age > every * 2.5;
    box.className = "live" + (stale ? " live-stale" : "");
    const at = new Date(polled * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $("updated").textContent = `${stale ? "Delayed · " : ""}updated ${at} (${ago(age)})`;
  }

  function applyControls() {
    const ladder = $("ladder");
    if (!ladder || !$("q")) return;
    const rows = [...ladder.querySelectorAll(".row")];
    const q = ui.q.trim().toLowerCase();
    let shown = 0;
    for (const row of rows) {
      row.hidden = !!q && !row.dataset.name.includes(q);
      if (!row.hidden) shown++;
    }
    rows.sort(ui.sort === "name"
      ? (a, b) => a.dataset.name.localeCompare(b.dataset.name)
      : (a, b) => b.dataset[ui.sort] - a.dataset[ui.sort] || b.dataset.now - a.dataset.now);
    ladder.append(...rows);
    $("count").textContent = `${shown} ${shown === 1 ? "game" : "games"}`;
    $("no-match").hidden = shown > 0;
    $("no-match").textContent = `No games match “${ui.q.trim()}”.`;
  }

  async function refresh() {
    try {
      const res = await fetch(location.pathname, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const fresh = doc.getElementById("live");
      if (fresh && fresh.dataset.polled !== $("live").dataset.polled) {
        for (const el of doc.querySelectorAll("[data-swap]")) $(el.id)?.replaceWith(document.adoptNode(el));
        applyControls();
      }
      offline = false;
    } catch {
      offline = true;
    }
    renderStatus();
  }

  $("q")?.addEventListener("input", e => { ui.q = e.target.value; applyControls(); });
  $("sort")?.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    ui.sort = b.dataset.k;
    $("sort").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b));
    applyControls();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) renderStatus(); });
  setInterval(renderStatus, 15_000);
  setInterval(refresh, REFRESH_MS);
  renderStatus();
})();
