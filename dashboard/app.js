const cfg = window.DASHBOARD_CONFIG || {};
const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const ARM_ORDER = ["CONTROL", "T1", "T2", "T3", "T4", "T5", "T6", "T7"];

let state = { signals: [], arms: [], events: [] };
let charts = { fill: null, outcome: null, roi: null };

function $(id) { return document.getElementById(id); }

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("opacity-0");
  el.classList.add("opacity-100");
  setTimeout(() => {
    el.classList.add("opacity-0");
    el.classList.remove("opacity-100");
  }, 2200);
}

function fmtPrice(n) {
  if (n == null || n === "") return "—";
  const x = Number(n);
  if (x === 0) return "0";
  if (x < 0.0001) return x.toExponential(2);
  if (x < 1) return x.toPrecision(4);
  return x.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return "—";
  return (Number(n) * 100).toFixed(1) + "%";
}

function fmtUsd(n) {
  if (n == null || isNaN(n)) return "—";
  const x = Number(n);
  const sign = x >= 0 ? "+" : "";
  return sign + "$" + x.toFixed(2);
}

function shortTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function statusPill(status) {
  const map = {
    open: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    closed: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  };
  const cls = map[status] || map.closed;
  return `<span class="pill inline-block px-2 py-0.5 rounded-full border \( {cls}"> \){status || "—"}</span>`;
}

function boolMark(v) {
  if (v === true) return `<span class="text-accent">✓</span>`;
  if (v === false) return `<span class="text-slate-600">·</span>`;
  return "—";
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("tab-active"));
    btn.classList.add("tab-active");
    const tab = btn.dataset.tab;
    document.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
    $("panel-" + tab).classList.remove("hidden");
  });
});

async function loadAll() {
  const [sigRes, armRes] = await Promise.all([
    sb.from("signals").select("*").order("called_at", { ascending: false }).limit(500),
    sb.from("treatment_arms").select("*").limit(5000),
  ]);
  if (sigRes.error) { toast("Signals: " + sigRes.error.message); console.error(sigRes.error); }
  if (armRes.error) { toast("Arms: " + armRes.error.message); console.error(armRes.error); }
  state.signals = sigRes.data || [];
  state.arms = armRes.data || [];
  $("last-refresh").textContent = new Date().toLocaleTimeString();
  renderOverview();
  renderTreatments();
  renderSignals();
  fillSpecimenSelect();
}

function chartOpts(ySuffix) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: "#64748b", font: { size: 10 } }, grid: { color: "rgba(26,30,42,0.8)" } },
      y: {
        ticks: { color: "#64748b", font: { size: 10 }, callback: (v) => v + (ySuffix || "") },
        grid: { color: "rgba(26,30,42,0.8)" },
      },
    },
  };
}

function renderOverview() {
  const sigs = state.signals;
  const arms = state.arms;
  $("stat-signals").textContent = sigs.length;
  $("stat-open").textContent = sigs.filter((s) => s.status === "open").length;
  $("stat-fills").textContent = arms.filter((a) => a.filled).length;
  $("stat-nofill").textContent = arms.filter((a) => a.no_fill).length;
  $("stat-stops").textContent = arms.filter((a) => a.stop_hit || a.closure_reason === "stop").length;
  $("stat-fulltp").textContent = arms.filter((a) => a.closure_reason === "full_tp").length;

  $("recent-signals").innerHTML = sigs.slice(0, 12).map((s) => `
    <tr class="data-row border-b border-ink-700/80">
      <td class="py-2.5 pr-3 text-accent">${esc(s.specimen_id)}</td>
      <td class="py-2.5 pr-3 text-white">\[ {esc(s.token_symbol || "—")}</td>
      <td class="py-2.5 pr-3">${s.experiment_day ?? "—"}</td>
      <td class="py-2.5 pr-3">${fmtPrice(s.signal_price_usd)}</td>
      <td class="py-2.5 pr-3">${statusPill(s.status)}</td>
      <td class="py-2.5 text-slate-500">${shortTime(s.called_at)}</td>
    </tr>
  `).join("") || `<tr><td colspan="6" class="py-6 text-center text-slate-500">No signals yet</td></tr>`;

  const fillRates = ARM_ORDER.map((code) => {
    const subset = arms.filter((a) => a.arm_code === code);
    if (!subset.length) return 0;
    return (subset.filter((a) => a.filled).length / subset.length) * 100;
  });

  if (charts.fill) charts.fill.destroy();
  charts.fill = new Chart($("chart-fill").getContext("2d"), {
    type: "bar",
    data: {
      labels: ARM_ORDER,
      datasets: [{
        data: fillRates,
        backgroundColor: "rgba(110, 231, 183, 0.35)",
        borderColor: "rgba(110, 231, 183, 0.9)",
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: chartOpts("%"),
  });

  const outcomes = {
    "Full TP": arms.filter((a) => a.closure_reason === "full_tp").length,
    Stop: arms.filter((a) => a.closure_reason === "stop").length,
    "No fill": arms.filter((a) => a.no_fill || a.closure_reason === "no_fill").length,
    Open: arms.filter((a) => !a.closure_reason).length,
  };
  if (charts.outcome) charts.outcome.destroy();
  charts.outcome = new Chart($("chart-outcome").getContext("2d"), {
    type: "doughnut",
    data: {
      labels: Object.keys(outcomes),
      datasets: [{
        data: Object.values(outcomes),
        backgroundColor: [
          "rgba(110, 231, 183, 0.7)",
          "rgba(248, 113, 113, 0.7)",
          "rgba(251, 191, 36, 0.7)",
          "rgba(125, 211, 252, 0.5)",
        ],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { color: "#94a3b8", boxWidth: 10, font: { size: 11 } } },
      },
    },
  });
}

function renderTreatments() {
  const arms = state.arms;
  const rows = ARM_ORDER.map((code) => {
    const subset = arms.filter((a) => a.arm_code === code);
    const n = subset.length;
    const fills = subset.filter((a) => a.filled).length;
    const closed = subset.filter((a) => a.closure_reason && a.closure_reason !== "no_fill");
    const avgRoi = closed.length
      ? closed.reduce((s, a) => s + (Number(a.realized_roi) || 0), 0) / closed.length
      : null;
    return {
      code,
      disc: subset[0]?.discount_pct ?? "—",
      n,
      fills,
      fillPct: n ? fills / n : null,
      tp1: subset.filter((a) => a.tp1_hit).length,
      tp2: subset.filter((a) => a.tp2_hit).length,
      tp3: subset.filter((a) => a.tp3_hit).length,
      stops: subset.filter((a) => a.stop_hit || a.closure_reason === "stop").length,
      nofill: subset.filter((a) => a.no_fill || a.closure_reason === "no_fill").length,
      pnlSum: subset.reduce((s, a) => s + (Number(a.realized_pnl_usd) || 0), 0),
      avgRoi,
    };
  });

  $("treatment-table").innerHTML = rows.map((r) => `
    <tr class="data-row">
      <td class="px-4 py-3 text-white font-medium">${r.code}</td>
      <td class="px-3 py-3 text-slate-400">${r.disc}%</td>
      <td class="px-3 py-3">${r.n}</td>
      <td class="px-3 py-3 text-accent">${r.fills}</td>
      <td class="px-3 py-3">${r.fillPct == null ? "—" : (r.fillPct * 100).toFixed(0) + "%"}</td>
      <td class="px-3 py-3">${r.tp1}</td>
      <td class="px-3 py-3">${r.tp2}</td>
      <td class="px-3 py-3">${r.tp3}</td>
      <td class="px-3 py-3 text-danger">${r.stops}</td>
      <td class="px-3 py-3 text-warn">${r.nofill}</td>
      <td class="px-3 py-3 \( {r.pnlSum >= 0 ? "text-accent" : "text-danger"}"> \){fmtUsd(r.pnlSum)}</td>
      <td class="px-3 py-3">${r.avgRoi == null ? "—" : fmtPct(r.avgRoi)}</td>
    </tr>
  `).join("");

  if (charts.roi) charts.roi.destroy();
  charts.roi = new Chart($("chart-roi").getContext("2d"), {
    type: "bar",
    data: {
      labels: ARM_ORDER,
      datasets: [{
        data: rows.map((r) => (r.avgRoi == null ? 0 : r.avgRoi * 100)),
        backgroundColor: rows.map((r) =>
          (r.avgRoi || 0) >= 0 ? "rgba(110, 231, 183, 0.35)" : "rgba(248, 113, 113, 0.35)"
        ),
        borderColor: rows.map((r) =>
          (r.avgRoi || 0) >= 0 ? "rgba(110, 231, 183, 0.9)" : "rgba(248, 113, 113, 0.9)"
        ),
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: chartOpts("%"),
  });
}

function renderSignals() {
  const q = ($("filter-search").value || "").toLowerCase();
  const st = $("filter-status").value;
  let list = state.signals;
  if (st) list = list.filter((s) => s.status === st);
  if (q) {
    list = list.filter((s) =>
      [s.specimen_id, s.token_symbol, s.contract_address, s.network]
        .some((x) => (x || "").toLowerCase().includes(q))
    );
  }

  $("signals-table").innerHTML = list.map((s) => `
    <tr class="data-row">
      <td class="px-4 py-3 text-accent">${esc(s.specimen_id)}</td>
      <td class="px-3 py-3 text-white"> \]{esc(s.token_symbol || "—")}</td>
      <td class="px-3 py-3 text-slate-400">${esc(s.network || "—")}</td>
      <td class="px-3 py-3">${fmtPrice(s.signal_price_usd)}</td>
      <td class="px-3 py-3 text-slate-400">${fmtPrice(s.lowest_price_usd)} / ${fmtPrice(s.highest_price_usd)}</td>
      <td class="px-3 py-3">${s.experiment_day ?? "—"}</td>
      <td class="px-3 py-3">${statusPill(s.status)}</td>
      <td class="px-3 py-3">
        <button data-open-specimen="${esc(s.id)}" class="text-accent hover:underline text-[11px]">View</button>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="8" class="px-4 py-8 text-center text-slate-500">No signals</td></tr>`;

  document.querySelectorAll("[data-open-specimen]").forEach((btn) => {
    btn.addEventListener("click", () => {
      $("specimen-select").value = btn.dataset.openSpecimen;
      document.querySelector('[data-tab="specimen"]').click();
      loadSpecimen(btn.dataset.openSpecimen);
    });
  });
}

$("filter-search").addEventListener("input", renderSignals);
$("filter-status").addEventListener("change", renderSignals);

function fillSpecimenSelect() {
  const sel = $("specimen-select");
  const cur = sel.value;
  sel.innerHTML =
    `<option value="">Select specimen…</option>` +
    state.signals
      .map((s) => `<option value="\( {esc(s.id)}"> \){esc(s.specimen_id)} · $${esc(s.token_symbol || "?")}</option>`)
      .join("");
  if (cur) sel.value = cur;
}

$("specimen-select").addEventListener("change", (e) => {
  if (e.target.value) loadSpecimen(e.target.value);
  else {
    $("specimen-empty").classList.remove("hidden");
    $("specimen-detail").classList.add("hidden");
  }
});

async function loadSpecimen(id) {
  const sig = state.signals.find((s) => s.id === id);
  if (!sig) return;

  $("specimen-empty").classList.add("hidden");
  $("specimen-detail").classList.remove("hidden");
  $("sp-id").textContent = sig.specimen_id;
  \( ("sp-token").textContent = " \)" + (sig.token_symbol || "UNKNOWN");
  \( ("sp-meta").textContent = ` \){sig.network || "?"} · Day ${sig.experiment_day ?? "—"} · ${shortTime(sig.called_at)}`;
  $("sp-price").textContent = fmtPrice(sig.signal_price_usd);

  const arms = state.arms
    .filter((a) => a.signal_id === id)
    .sort((a, b) => ARM_ORDER.indexOf(a.arm_code) - ARM_ORDER.indexOf(b.arm_code));

  $("sp-arms").innerHTML = arms.map((a) => `
    <tr class="data-row">
      <td class="px-4 py-3 text-white">${a.arm_code}</td>
      <td class="px-3 py-3">${fmtPrice(a.entry_target_usd)}</td>
      <td class="px-3 py-3">${a.filled ? fmtPrice(a.fill_price_usd) : "—"}</td>
      <td class="px-3 py-3">${boolMark(a.tp1_hit)}</td>
      <td class="px-3 py-3">${boolMark(a.tp2_hit)}</td>
      <td class="px-3 py-3">${boolMark(a.tp3_hit)}</td>
      <td class="px-3 py-3">${boolMark(a.stop_hit)}</td>
      <td class="px-3 py-3">${a.remaining_pct != null ? (Number(a.remaining_pct) * 100).toFixed(0) + "%" : "—"}</td>
      <td class="px-3 py-3 \( {Number(a.realized_pnl_usd) >= 0 ? "text-accent" : "text-danger"}"> \){fmtUsd(a.realized_pnl_usd)}</td>
      <td class="px-3 py-3 text-slate-400">${a.closure_reason || "open"}</td>
    </tr>
  `).join("") || `<tr><td colspan="10" class="px-4 py-6 text-center text-slate-500">No arms</td></tr>`;

  const { data: events, error } = await sb
    .from("arm_events")
    .select("*, treatment_arms(arm_code)")
    .eq("signal_id", id)
    .order("event_at", { ascending: true });

  if (error) {
    \( ("sp-events").innerHTML = `<p class="text-danger"> \){esc(error.message)}</p>`;
    return;
  }
  if (!events || !events.length) {
    $("sp-events").innerHTML = `<p class="text-slate-500">No events yet</p>`;
    return;
  }

  const color = {
    ENTRY: "text-info", TP1: "text-accent", TP2: "text-accent",
    TP3: "text-accent", STOP: "text-danger", NO_FILL: "text-warn",
  };

  $("sp-events").innerHTML = events.map((e) => {
    const arm = e.treatment_arms?.arm_code || "?";
    return `
      <div class="flex flex-wrap gap-x-3 gap-y-1 py-1.5 border-b border-ink-700/60">
        <span class="text-slate-500 w-28 shrink-0">${shortTime(e.event_at)}</span>
        <span class="text-white w-16">${arm}</span>
        <span class="\( {color[e.event_type] || "text-slate-300"} w-16"> \){e.event_type}</span>
        <span class="text-slate-400">${e.event_type === "NO_FILL" ? "—" : fmtPrice(e.event_price_usd)}</span>
        <span class="text-slate-600">rem ${(Number(e.remaining_pct_after || 0) * 100).toFixed(0)}%</span>
      </div>
    `;
  }).join("");
}

$("btn-refresh").addEventListener("click", () => {
  loadAll().then(() => toast("Refreshed"));
});

loadAll();
setInterval(loadAll, 60_000);
