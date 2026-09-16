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
  // Laid out for social feeds: the image is usually shown at ~50% size,
  // so nothing is smaller than 16px here and each card carries only the key numbers.

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
    const raw = max / 3, mag = 10 ** Math.floor(Math.log10(raw));
    const step = Math.max(1, Math.round([1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= raw)));
    return { top: Math.ceil(max / step) * step, step };
  }

  const short = v => (v >= 1000 ? `${v / 1000 >= 10 ? Math.round(v / 1000) : +(v / 1000).toFixed(1)}k` : String(v));

  // the headline sentence as styled pieces: the key number is bold white, the rest muted
  function takeaway(picked) {
    const [a, b] = picked.slice().sort((x, y) => y.mean - x.mean);
    const plain = t => ({ text: t, bold: false });
    const strong = t => ({ text: t, bold: true });
    if (picked.length === 2) {
      if (b.mean <= 0) return [plain(`${a.name} averaged `), strong(fmt(a.mean)), plain(` players while ${b.name} was nearly empty`)];
      const ratio = a.mean / b.mean;
      if (ratio < 1.1) return [plain(`${a.name} and ${b.name} are `), strong("neck and neck"), plain(` (${fmt(a.mean)} vs ${fmt(b.mean)} avg)`)];
      const r = ratio >= 10 ? String(Math.round(ratio)) : ratio.toFixed(1);
      return [plain(`${a.name} averaged `), strong(`${r}×`), plain(` the players of ${b.name}`)];
    }
    return [plain(`${a.name} leads with `), strong(fmt(a.mean)), plain(" players on average")];
  }

  function drawRich(ctx, pieces, x, y, maxWidth) {
    let size = 26;
    const font = (bold, s) => `${bold ? 700 : 400} ${s}px ${SANS}`;
    const width = s => pieces.reduce((sum, p) => { ctx.font = font(p.bold, s); return sum + ctx.measureText(p.text).width; }, 0);
    while (size > 20 && width(size) > maxWidth) size -= 1;
    let cx = x;
    for (const p of pieces) {
      ctx.font = font(p.bold, size);
      ctx.fillStyle = p.bold ? INK : MUTED;
      const text = fitText(ctx, p.text, x + maxWidth - cx);
      ctx.fillText(text, cx, y);
      cx += ctx.measureText(text).width;
      if (cx >= x + maxWidth) break;
    }
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
    ctx.textAlign = "left";
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    const PAD = 48, inner = W - 2 * PAD;

    // title: the matchup, shrunk to fit; with many long names say how many instead
    let title = picked.map(g => g.name).join("  vs  ");
    let size = 50;
    ctx.font = `700 ${size}px ${SANS}`;
    while (size > 34 && ctx.measureText(title).width > inner) { size -= 2; ctx.font = `700 ${size}px ${SANS}`; }
    if (ctx.measureText(title).width > inner) {
      title = `${picked.length} fighting games compared`;
      ctx.font = `700 50px ${SANS}`;
    }
    ctx.fillStyle = INK;
    ctx.fillText(fitText(ctx, title, inner), PAD, 94);

    const pieces = takeaway(picked);
    drawRich(ctx, pieces, PAD, 140, inner);

    drawChart(ctx, picked, { x: PAD, y: 172, w: 690, h: 424 });
    drawCards(ctx, picked, { x: PAD + 722, y: 172, w: W - PAD - (PAD + 722), h: 424 });

    // footer: what the data is on the left, the watermark on the right
    const day = meta.polledAt
      ? new Date(meta.polledAt * 1000).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
      : "";
    ctx.font = `600 26px ${SANS}`;
    const mark = "fgcensus.info";
    const mw = ctx.measureText(mark).width;
    ctx.fillStyle = INK;
    ctx.fillText(mark, W - PAD - mw, 647);
    drawMark(ctx, W - PAD - mw - 42, 620, 32);

    ctx.font = `400 19px ${SANS}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(fitText(ctx, `Steam concurrent players · past 7 days · ${day}`, inner - mw - 70), PAD, 645);

    canvas.setAttribute("aria-label", `${title}. ${pieces.map(p => p.text).join("")}. ` +
      picked.map(g => `${g.name}: ${fmt(g.now)} playing now, average ${fmt(g.mean)}, peak ${fmt(g.peak)}.`).join(" "));
  }

  function drawChart(ctx, picked, box) {
    ctx.fillStyle = PANEL;
    roundRect(ctx, box.x, box.y, box.w, box.h, 16);
    ctx.fill();

    const x0 = box.x + 76, x1 = box.x + box.w - 28, y0 = box.y + 52, y1 = box.y + box.h - 52;
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

    ctx.font = `400 19px ${SANS}`;
    ctx.fillStyle = MUTED;
    ctx.fillText("Players per hour", box.x + 24, box.y + 34);
    if (useLog) {
      const t = "log scale";
      ctx.fillStyle = FAINT;
      ctx.fillText(t, box.x + box.w - 28 - ctx.measureText(t).width, box.y + 34);
    }

    // grid + y labels
    ctx.lineWidth = 1;
    ctx.strokeStyle = LINE;
    ctx.font = `400 19px ${MONO}`;
    ctx.fillStyle = FAINT;
    ctx.textAlign = "right";
    for (const v of ticks) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillText(short(v), x0 - 12, y + 6);
    }
    // day boundaries (UTC midnight) + weekday labels
    ctx.textAlign = "center";
    ctx.font = `400 19px ${SANS}`;
    for (let i = 0; i < meta.hours; i++) {
      if ((meta.start + i) % 24 !== 0) continue;
      const x = Math.round(xOf(i)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      const dayName = new Date((meta.start + i) * 3600 * 1000).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
      ctx.fillText(dayName, x, y1 + 32);
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
      ctx.lineWidth = 3;
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
        ctx.arc(xOf(last), yOf(values[last]), 6.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = PANEL;
        ctx.stroke();
      }
    }
  }

  function drawCards(ctx, picked, box) {
    // share of everyone playing these games right now
    const total = picked.reduce((s, g) => s + g.now, 0);
    ctx.font = `400 19px ${SANS}`;
    ctx.fillStyle = MUTED;
    ctx.fillText("Share of players right now", box.x, box.y + 18);
    const barY = box.y + 32, barH = 16;
    if (total > 0) {
      const online = picked.filter(g => g.now > 0);
      const gap = 3, usable = box.w - gap * (online.length - 1);
      // tiny shares still get a visible sliver; everything is scaled back to fit the bar
      const raw = online.map(g => Math.max(5, g.now / total * usable));
      const fit = usable / raw.reduce((s, w) => s + w, 0);
      let x = box.x;
      online.forEach((g, i) => {
        const w = raw[i] * fit;
        ctx.fillStyle = COLORS[slotOf.get(g.id)];
        roundRect(ctx, x, barY, w, barH, 5);
        ctx.fill();
        x += w + gap;
      });
    } else {
      ctx.fillStyle = TRACK;
      roundRect(ctx, box.x, barY, box.w, barH, 5);
      ctx.fill();
    }

    // one card per game; the name always gets its own full-width line so it isn't cut off
    const top = barY + barH + 34;
    const rowH = Math.min(172, (box.y + box.h - top) / picked.length);
    const tier = rowH >= 150 ? "big" : rowH >= 86 ? "mid" : "small";

    const drawPair = ([label, value], x, baseline, size) => {
      ctx.font = `400 ${size}px ${SANS}`;
      ctx.fillStyle = MUTED;
      ctx.fillText(label + " ", x, baseline);
      x += ctx.measureText(label + " ").width;
      ctx.font = `700 ${size}px ${SANS}`;
      ctx.fillStyle = INK;
      ctx.fillText(value, x, baseline);
      return x + ctx.measureText(value).width;
    };

    picked.forEach((g, i) => {
      const y = top + i * rowH;
      const color = COLORS[slotOf.get(g.id)];
      const avg = ["avg", fmt(g.mean)], peak = ["peak", fmt(g.peak)];
      if (i > 0) {
        ctx.fillStyle = LINE;
        ctx.fillRect(box.x, Math.round(y - 16), box.w, 1);
      }
      const nameLine = (size, baseline, reserve = 0) => {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(box.x + 7, baseline - size * 0.36, 7, 0, Math.PI * 2); ctx.fill();
        ctx.font = `600 ${size}px ${SANS}`;
        ctx.fillStyle = INK;
        ctx.fillText(fitText(ctx, g.name, box.w - 24 - reserve), box.x + 24, baseline);
      };
      const nowLine = (size, baseline) => {
        ctx.font = `600 ${size}px ${MONO}`;
        ctx.fillStyle = INK;
        const t = fmt(g.now);
        ctx.fillText(t, box.x + 24, baseline);
        const w = ctx.measureText(t).width;
        ctx.font = `400 ${Math.max(16, Math.round(size * 0.42))}px ${SANS}`;
        ctx.fillStyle = MUTED;
        ctx.fillText("playing now", box.x + 24 + w + 12, baseline);
      };

      if (tier === "big") {
        nameLine(26, y + 26);
        nowLine(46, y + 80);
        drawPair(avg, box.x + 24, y + 116, 21);
        drawPair(peak, box.x + 24, y + 146, 21);
      } else if (tier === "mid") {
        nameLine(23, y + 22);
        nowLine(32, y + 60);
        const x = drawPair(avg, box.x + 24, y + 88, 18);
        drawPair(peak, x + 18, y + 88, 18);
      } else {
        // five games: name and count share a line, stats underneath
        ctx.font = `600 26px ${MONO}`;
        const t = fmt(g.now), w = ctx.measureText(t).width;
        ctx.fillStyle = INK;
        ctx.fillText(t, box.x + box.w - w, y + 22);
        nameLine(21, y + 22, w + 14);
        const x = drawPair(avg, box.x + 24, y + 48, 17);
        drawPair(peak, x + 16, y + 48, 17);
      }
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
        await Promise.all([`700 50px ${SANS}`, `600 26px ${SANS}`, `400 19px ${SANS}`, `400 19px ${MONO}`, `600 46px ${MONO}`].map(f => document.fonts.load(f)));
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
