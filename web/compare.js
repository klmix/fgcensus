// FGCensus compare: pick 2–5 games, draw a shareable comparison image on a
// canvas (what you see is exactly what downloads), link to it via ?compare=.
(() => {
  const dlg = document.getElementById("compare");
  if (!dlg) return;

  const MAX = 5;
  // categorical slots, validated for the dark image surface (color-blind separation + contrast)
  const COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"];
  const INK = "#e9ebf3", MUTED = "#8a8fa5", FAINT = "#5a5f75", LINE = "#262a3a", BG = "#0c0e15", PANEL = "#151823", TRACK = "#1c2030";
  const SANS = '"Barlow", "Segoe UI", system-ui, sans-serif';
  const MONO = '"Chivo Mono", ui-monospace, Consolas, monospace';
  const W = 1200, H = 675, SCALE = 2;
  const MAX_GAP_HOURS = 6;

  const $ = id => document.getElementById(id);
  const fmt = n => Math.round(n).toLocaleString("en-US");
  const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let games = null, byId = null, bySlug = null, series = null, meta = null;
  const slotOf = new Map();   // game id -> color slot; a game keeps its color while selected
  let selected = [];          // game ids, in the order they were picked

  async function load() {
    if (games) return;
    const [state, hist] = await Promise.all([
      fetch("api/state.json", { cache: "no-store" }).then(r => r.json()),
      fetch("api/history.json", { cache: "no-store" }).then(r => r.json()),
    ]);
    games = state.games.slice().sort((a, b) => b.now - a.now || b.mean - a.mean);
    byId = new Map(games.map(g => [g.id, g]));
    bySlug = new Map(games.map(g => [g.slug, g]));
    series = hist.series;
    meta = { polledAt: state.polledAt, start: hist.start, hours: hist.hours };
  }

  // ------------------------------------------------------------ picker

  function renderList() {
    const q = $("cmp-q").value.trim().toLowerCase();
    const full = selected.length >= MAX;
    $("cmp-list").innerHTML = games
      .filter(g => !q || g.name.toLowerCase().includes(q))
      .map(g => {
        const on = selected.includes(g.id);
        return `<li><label><input type="checkbox" data-id="${g.id}"${on ? " checked" : ""}${full && !on ? " disabled" : ""}>` +
          `<span class="n">${esc(g.name)}</span><span class="c">${fmt(g.now)}</span></label></li>`;
      }).join("") || `<li class="cmp-hint">No games match.</li>`;
  }

  function toggle(id, on) {
    if (on && !selected.includes(id) && selected.length < MAX) {
      const used = new Set(selected.map(s => slotOf.get(s)));
      slotOf.set(id, COLORS.findIndex((_, i) => !used.has(i)));
      selected.push(id);
    } else if (!on) {
      selected = selected.filter(s => s !== id);
      slotOf.delete(id);
    }
    update();
  }

  function update() {
    const picked = selected.map(id => byId.get(id));
    $("cmp-chips").innerHTML = picked.map(g =>
      `<span class="cmp-chip"><i style="background:${COLORS[slotOf.get(g.id)]}"></i>${esc(g.name)}` +
      `<button type="button" data-remove="${g.id}" aria-label="Remove ${esc(g.name)}">×</button></span>`).join("");
    $("cmp-hint").textContent = selected.length >= MAX ? `That's the maximum of ${MAX} games.` : "Pick 2 to 5 games.";
    renderList();

    const ready = picked.length >= 2;
    $("cmp-canvas").hidden = !ready;
    $("cmp-empty").hidden = ready;
    $("cmp-download").disabled = !ready;
    $("cmp-link").disabled = !ready;
    $("cmp-status").textContent = "";

    const url = new URL(location.href);
    if (picked.length) url.searchParams.set("compare", picked.map(g => g.slug).join(","));
    else url.searchParams.delete("compare");
    history.replaceState(null, "", url);

    if (ready) draw(picked);
  }

  // ------------------------------------------------------------ drawing

  const peakLabel = g => (g.peakAllTime ? "all-time peak" : "tracked peak");

  function busiestHour(g) {
    // UTC hour of day with the highest average player count over the week
    const sums = new Array(24).fill(0), counts = new Array(24).fill(0);
    (series[g.id] || []).forEach((v, i) => {
      if (v == null) return;
      const hour = (meta.start + i) % 24;
      sums[hour] += v;
      counts[hour]++;
    });
    let best = null, bestAvg = 0;
    for (let h = 0; h < 24; h++) {
      if (counts[h] && sums[h] / counts[h] > bestAvg) { bestAvg = sums[h] / counts[h]; best = h; }
    }
    return best;
  }

  function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
    return t.trimEnd() + "…";
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), Math.max(0, Math.min(r, h / 2, w / 2)));
  }

  function niceLinear(max) {
    if (max <= 0) return { top: 1, step: 1 };
    const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw));
    const step = Math.max(1, Math.round([1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= raw)));
    return { top: Math.ceil(max / step) * step, step };
  }

  function takeaway(picked) {
    const byAvg = picked.slice().sort((a, b) => b.mean - a.mean);
    const [a, b] = byAvg;
    if (picked.length === 2) {
      if (b.mean <= 0) return `${a.name} averaged ${fmt(a.mean)} players this week; ${b.name} had almost nobody online.`;
      const ratio = a.mean / b.mean;
      if (ratio < 1.1) return `${a.name} and ${b.name} were neck and neck this week (${fmt(a.mean)} vs ${fmt(b.mean)} on average).`;
      return `${a.name} averaged ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× the players of ${b.name} this week.`;
    }
    return `${a.name} leads with ${fmt(a.mean)} players on average this week.`;
  }

  function drawMark(ctx, x, y, s) {
    // the FGCensus joystick icon, s = size in px
    const u = s / 32;
    ctx.fillStyle = PANEL; roundRect(ctx, x, y, s, s, 7 * u); ctx.fill();
    ctx.fillStyle = INK; roundRect(ctx, x + 14 * u, y + 11 * u, 4 * u, 13 * u, u); ctx.fill();
    ctx.fillStyle = "#7b8cff"; ctx.beginPath(); ctx.arc(x + 16 * u, y + 10 * u, 6 * u, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#f3b53a"; roundRect(ctx, x + 6 * u, y + 23 * u, 20 * u, 4 * u, 2 * u); ctx.fill();
  }

  function draw(picked) {
    const canvas = $("cmp-canvas");
    const ctx = canvas.getContext("2d");
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    const PAD = 44;
    const updated = meta.polledAt ? new Date(meta.polledAt * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";

    // header
    ctx.fillStyle = MUTED;
    ctx.font = `400 13px ${MONO}`;
    ctx.letterSpacing = "1.5px";
    ctx.fillText("STEAM PLAYER COMPARISON · PAST 7 DAYS", PAD, 58);
    ctx.letterSpacing = "0px";

    let title = picked.map(g => g.name).join("  vs  ");
    let size = 38;
    ctx.font = `600 ${size}px ${SANS}`;
    while (size > 26 && ctx.measureText(title).width > W - 2 * PAD) { size -= 2; ctx.font = `600 ${size}px ${SANS}`; }
    if (ctx.measureText(title).width > W - 2 * PAD) {
      // names are on the cards anyway; don't cut them off mid-word in the headline
      title = `${picked.length} fighting games compared`;
      size = 38;
      ctx.font = `600 ${size}px ${SANS}`;
    }
    ctx.fillStyle = INK;
    ctx.fillText(fitText(ctx, title, W - 2 * PAD), PAD, 102);

    ctx.font = `400 18px ${SANS}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(fitText(ctx, takeaway(picked), W - 2 * PAD), PAD, 134);

    drawChart(ctx, picked, { x: PAD, y: 160, w: 700, h: 410 });
    drawCards(ctx, picked, { x: PAD + 728, y: 160, w: W - PAD - (PAD + 728), h: 410 });

    // footer: source on the left, watermark on the right
    ctx.font = `400 12px ${MONO}`;
    ctx.fillStyle = FAINT;
    ctx.fillText(`Data: Steam Web API · hourly averages · as of ${updated}`, PAD, 628);
    ctx.font = `600 17px ${SANS}`;
    ctx.fillStyle = MUTED;
    const mark = "fgcensus.info";
    const mw = ctx.measureText(mark).width;
    ctx.fillText(mark, W - PAD - mw, 629);
    drawMark(ctx, W - PAD - mw - 30, 610, 22);

    canvas.setAttribute("aria-label", `${title}. ${takeaway(picked)} ` +
      picked.map(g => `${g.name}: ${fmt(g.now)} now, weekly average ${fmt(g.mean)}, weekly low ${fmt(g.min)}, ${peakLabel(g)} ${fmt(g.peak)}.`).join(" "));
  }

  function drawChart(ctx, picked, box) {
    ctx.fillStyle = PANEL;
    roundRect(ctx, box.x, box.y, box.w, box.h, 14);
    ctx.fill();

    const x0 = box.x + 70, x1 = box.x + box.w - 24, y0 = box.y + 40, y1 = box.y + box.h - 40;
    const lists = picked.map(g => series[g.id] || []);
    const present = lists.flat().filter(v => v != null);
    const maxV = Math.max(1, ...present);
    const avgs = picked.map(g => Math.max(1, g.mean));
    const useLog = Math.max(...avgs) / Math.min(...avgs) > 20;

    let yOf, ticks;
    if (useLog) {
      const topExp = Math.max(1, Math.ceil(Math.log10(maxV + 1)));
      const top = Math.log10(10 ** topExp + 1);
      yOf = v => y1 - Math.log10(v + 1) / top * (y1 - y0);
      ticks = Array.from({ length: topExp + 1 }, (_, i) => (i === 0 ? 0 : 10 ** i));
    } else {
      const { top, step } = niceLinear(maxV);
      yOf = v => y1 - v / top * (y1 - y0);
      ticks = [];
      for (let v = 0; v <= top; v += step) ticks.push(v);
    }
    const n = Math.max(1, meta.hours - 1);
    const xOf = i => x0 + i / n * (x1 - x0);

    ctx.font = `400 12px ${MONO}`;
    ctx.fillStyle = MUTED;
    ctx.fillText("Players per hour", box.x + 20, box.y + 26);
    if (useLog) {
      const t = "log scale";
      ctx.fillStyle = FAINT;
      ctx.fillText(t, box.x + box.w - 24 - ctx.measureText(t).width, box.y + 26);
    }

    // grid + y labels
    ctx.lineWidth = 1;
    ctx.strokeStyle = LINE;
    ctx.textAlign = "right";
    ctx.fillStyle = FAINT;
    for (const v of ticks) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      const label = v >= 1000 ? `${v / 1000 >= 10 ? Math.round(v / 1000) : +(v / 1000).toFixed(1)}k` : String(v);
      ctx.fillText(label, x0 - 10, y + 4);
    }
    // day boundaries (UTC midnight) + weekday labels
    ctx.textAlign = "center";
    for (let i = 0; i < meta.hours; i++) {
      if ((meta.start + i) % 24 !== 0) continue;
      const x = Math.round(xOf(i)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      const day = new Date((meta.start + i) * 3600 * 1000).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
      ctx.fillText(day, x, y1 + 22);
    }
    ctx.textAlign = "left";

    // lines: biggest game first so smaller ones stay visible on top
    const order = picked.map((g, i) => i).sort((a, b) => picked[b].mean - picked[a].mean);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const i of order) {
      const values = lists[i];
      const color = COLORS[slotOf.get(picked[i].id)];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let last = null;
      values.forEach((v, h) => {
        if (v == null) return;
        if (last === null || h - last > MAX_GAP_HOURS) ctx.moveTo(xOf(h), yOf(v));
        else ctx.lineTo(xOf(h), yOf(v));
        last = h;
      });
      ctx.stroke();
      if (last !== null) {
        ctx.beginPath();
        ctx.arc(xOf(last), yOf(values[last]), 4.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = PANEL;
        ctx.stroke();
      }
    }
  }

  function drawCards(ctx, picked, box) {
    // share of everyone playing these games right now
    const total = picked.reduce((s, g) => s + g.now, 0);
    ctx.font = `400 12px ${MONO}`;
    ctx.fillStyle = MUTED;
    ctx.fillText("Share of players right now", box.x, box.y + 12);
    const barY = box.y + 24, barH = 12;
    if (total > 0) {
      const online = picked.filter(g => g.now > 0);
      const gap = 2, usable = box.w - gap * (online.length - 1);
      // tiny shares still get a visible 3px sliver; everything is scaled back to fit the bar
      const raw = online.map(g => Math.max(3, g.now / total * usable));
      const fit = usable / raw.reduce((s, w) => s + w, 0);
      let x = box.x;
      online.forEach((g, i) => {
        const w = raw[i] * fit;
        ctx.fillStyle = COLORS[slotOf.get(g.id)];
        roundRect(ctx, x, barY, w, barH, 4);
        ctx.fill();
        x += w + gap;
      });
    } else {
      ctx.fillStyle = TRACK;
      roundRect(ctx, box.x, barY, box.w, barH, 4);
      ctx.fill();
    }

    // one card per game
    const top = barY + barH + 22;
    const rowH = Math.min(104, (box.y + box.h - top) / picked.length);
    const roomy = rowH >= 92;
    const maxAvg = Math.max(1, ...picked.map(g => g.mean));
    picked.forEach((g, i) => {
      const y = top + i * rowH;
      const color = COLORS[slotOf.get(g.id)];
      if (i > 0) {
        ctx.fillStyle = LINE;
        ctx.fillRect(box.x, Math.round(y - 8), box.w, 1);
      }
      ctx.font = `600 22px ${MONO}`;
      const nowText = fmt(g.now);
      const nowW = ctx.measureText(nowText).width;
      ctx.fillStyle = INK;
      ctx.fillText(nowText, box.x + box.w - nowW, y + 18);

      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(box.x + 5, y + 12, 5, 0, Math.PI * 2); ctx.fill();
      ctx.font = `600 17px ${SANS}`;
      ctx.fillStyle = INK;
      ctx.fillText(fitText(ctx, g.name, box.w - nowW - 34), box.x + 18, y + 18);

      ctx.font = `400 12px ${MONO}`;
      ctx.fillStyle = MUTED;
      const pct = total > 0 ? ` · ${Math.round(g.now / total * 100)}% now` : "";
      const busy = busiestHour(g);
      if (roomy) {
        ctx.fillText(fitText(ctx, `weekly avg ${fmt(g.mean)} · weekly low ${fmt(g.min)}${pct}`, box.w - 18), box.x + 18, y + 38);
        ctx.fillStyle = FAINT;
        const when = busy !== null ? ` · busiest ~${String(busy).padStart(2, "0")}:00 UTC` : "";
        ctx.fillText(fitText(ctx, `${peakLabel(g)} ${fmt(g.peak)}${when}`, box.w - 18), box.x + 18, y + 57);
      } else {
        ctx.fillText(fitText(ctx, `weekly avg ${fmt(g.mean)} · ${peakLabel(g)} ${fmt(g.peak)}`, box.w - 18), box.x + 18, y + 38);
      }

      const trackY = y + (roomy ? 68 : 48);
      ctx.fillStyle = TRACK;
      roundRect(ctx, box.x + 18, trackY, box.w - 18, 4, 2); ctx.fill();
      ctx.fillStyle = color;
      roundRect(ctx, box.x + 18, trackY, Math.max(4, g.mean / maxAvg * (box.w - 18)), 4, 2); ctx.fill();
    });
  }

  // ------------------------------------------------------------ actions

  function fileName() {
    return `fgcensus-${selected.map(id => byId.get(id).slug).join("-vs-")}.png`.slice(0, 180);
  }

  $("cmp-download").addEventListener("click", () => {
    $("cmp-canvas").toBlob(blob => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName();
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      $("cmp-status").textContent = "Image saved.";
    }, "image/png");
  });

  $("cmp-link").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $("cmp-status").textContent = "Link copied.";
    } catch {
      $("cmp-status").textContent = "Couldn't copy — use the address bar link.";
    }
  });

  $("cmp-list").addEventListener("change", e => {
    const box = e.target.closest("input[data-id]");
    if (box) toggle(Number(box.dataset.id), box.checked);
  });
  $("cmp-chips").addEventListener("click", e => {
    const b = e.target.closest("button[data-remove]");
    if (b) toggle(Number(b.dataset.remove), false);
  });
  $("cmp-q").addEventListener("input", renderList);

  async function open(preselect = []) {
    if (!dlg.open) dlg.showModal();
    if (!games) {
      $("cmp-list").innerHTML = `<li class="cmp-hint">Loading…</li>`;
      try {
        await load();
        await Promise.all([`600 38px ${SANS}`, `400 18px ${SANS}`, `400 12px ${MONO}`, `600 22px ${MONO}`].map(f => document.fonts.load(f)));
      } catch {
        $("cmp-list").innerHTML = `<li class="cmp-hint">Couldn't load the game data. Try again in a moment.</li>`;
        return;
      }
    }
    for (const slug of preselect) {
      const g = bySlug.get(slug);
      if (g) toggle(g.id, true);
    }
    update();
    $("cmp-q").focus();
  }

  $("compare-open").addEventListener("click", () => open());
  $("compare-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener("close", () => {
    const url = new URL(location.href);
    url.searchParams.delete("compare");
    history.replaceState(null, "", url);
  });

  const initial = new URLSearchParams(location.search).get("compare");
  if (initial) open(initial.split(",").filter(Boolean));
})();
