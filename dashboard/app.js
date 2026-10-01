(function () {
  "use strict";

  const ARM_ORDER = ["CONTROL", "T1", "T2", "T3", "T4", "T5", "T6", "T7"];

  function $(id) {
    return document.getElementById(id);
  }

  function toast(msg) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.style.opacity = "1";
    setTimeout(function () {
      el.style.opacity = "0";
    }, 2500);
  }

  function showTab(tab) {
    document.querySelectorAll(".tab").forEach(function (b) {
      b.classList.toggle("tab-active", b.getAttribute("data-tab") === tab);
    });
    document.querySelectorAll(".panel").forEach(function (p) {
      var on = p.id === "panel-" + tab;
      p.classList.toggle("hidden", !on);
      p.style.display = on ? "block" : "none";
    });
  }

  function bindTabs() {
    document.querySelectorAll(".tab").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var tab = this.getAttribute("data-tab");
        if (tab) showTab(tab);
      });
      btn.addEventListener(
        "touchend",
        function (e) {
          e.preventDefault();
          var tab = this.getAttribute("data-tab");
          if (tab) showTab(tab);
        },
        { passive: false }
      );
    });
    showTab("overview");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindTabs);
  } else {
    bindTabs();
  }

  var cfg = window.DASHBOARD_CONFIG || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    toast("Missing dashboard config");
    return;
  }
  if (typeof supabase === "undefined") {
    toast("Supabase SDK failed to load");
    return;
  }

  var sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  var state = { signals: [], arms: [] };
  var charts = { fill: null, outcome: null, roi: null, specimenPrice: null };

  function fmtPrice(n) {
    if (n == null || n === "") return "—";
    var x = Number(n);
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
    var x = Number(n);
    return (x >= 0 ? "+" : "") + "$" + x.toFixed(2);
  }

  function shortTime(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function statusPill(status) {
    var map = {
      open: "bg-sky-500/15 text-sky-300 border-sky-500/30",
      closed: "bg-slate-500/15 text-slate-400 border-slate-500/30",
    };
    var cls = map[status] || map.closed;
    return (
      '<span class="pill inline-block px-2 py-0.5 rounded-full border ' +
      cls +
      '">' +
      (status || "—") +
      "</span>"
    );
  }

  function boolMark(v) {
    if (v === true) return '<span class="text-accent">✓</span>';
    if (v === false) return '<span class="text-slate-600">·</span>';
    return "—";
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function chartOpts(ySuffix) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: "#64748b", font: { size: 10 } },
          grid: { color: "rgba(26,30,42,0.8)" },
        },
        y: {
          ticks: {
            color: "#64748b",
            font: { size: 10 },
            callback: function (v) {
              return v + (ySuffix || "");
            },
          },
          grid: { color: "rgba(26,30,42,0.8)" },
        },
      },
    };
  }

  async function loadAll() {
    try {
      var results = await Promise.all([
        sb.from("signals").select("*").order("called_at", { ascending: false }).limit(500),
        sb.from("treatment_arms").select("*").limit(5000),
      ]);
      var sigRes = results[0];
      var armRes = results[1];
      if (sigRes.error) toast("Signals: " + sigRes.error.message);
      if (armRes.error) toast("Arms: " + armRes.error.message);
      state.signals = sigRes.data || [];
      state.arms = armRes.data || [];
      var lr = $("last-refresh");
      if (lr) lr.textContent = new Date().toLocaleTimeString();
      var hr = $("health-refresh");
      if (hr) hr.textContent = new Date().toLocaleTimeString();
      var day = sigRes.data && sigRes.data.length
        ? Math.max.apply(null, sigRes.data.map(function (s) {
            return Number(s.experiment_day) || 0;
          }))
        : 0;
      var hd = $("health-day");
      if (hd) hd.textContent = day ? String(day) : "—";
      fetch("/health")
        .then(function (r) {
          var api = $("health-api");
          if (!api) return;
          api.textContent = r.ok ? "online" : "error";
          api.className = r.ok
            ? "text-accent"
            : "text-danger";
        })
        .catch(function () {
          var api = $("health-api");
          if (api) {
            api.textContent = "offline";
            api.className = "text-danger";
          }
        });
      renderOverview();
      renderTreatments();
      renderSignals();
      fillSpecimenSelect();
    } catch (err) {
      console.error(err);
      toast("Load failed: " + (err && err.message ? err.message : String(err)));
    }
  }

  function renderOverview() {
    var sigs = state.signals;
    var arms = state.arms;
    function set(id, v) {
      var el = $(id);
      if (el) el.textContent = v;
    }
    set("stat-signals", sigs.length);
    set(
      "stat-valid",
      sigs.filter(function (s) {
        return s.fetch_status === "success" && s.signal_price_usd != null;
      }).length
    );
    set(
      "stat-failed",
      sigs.filter(function (s) {
        return s.fetch_status === "failed" || s.signal_price_usd == null;
      }).length
    );
    set(
      "stat-open",
      sigs.filter(function (s) {
        return s.status === "open";
      }).length
    );
    set(
      "stat-fills",
      arms.filter(function (a) {
        return a.filled;
      }).length
    );
    set(
      "stat-nofill",
      arms.filter(function (a) {
        return a.no_fill;
      }).length
    );
    set(
      "stat-stops",
      arms.filter(function (a) {
        return a.stop_hit || a.closure_reason === "stop";
      }).length
    );
    set(
      "stat-fulltp",
      arms.filter(function (a) {
        return a.closure_reason === "full_tp";
      }).length
    );

    var tbody = $("recent-signals");
    if (tbody) {
      tbody.innerHTML =
        sigs
          .slice(0, 12)
          .map(function (s) {
            return (
              '<tr class="data-row border-b border-ink-700/80">' +
              '<td class="py-2.5 pr-3 text-accent">' +
              esc(s.specimen_id) +
              "</td>" +
              '<td class="py-2.5 pr-3 text-white">$' +
              esc(s.token_symbol || "—") +
              "</td>" +
              '<td class="py-2.5 pr-3">' +
              (s.experiment_day != null ? s.experiment_day : "—") +
              "</td>" +
              '<td class="py-2.5 pr-3">' +
              fmtPrice(s.signal_price_usd) +
              "</td>" +
              '<td class="py-2.5 pr-3">' +
              fmtPrice(s.highest_price_usd) +
              "</td>" +
              '<td class="py-2.5 pr-3">' +
              statusPill(s.status) +
              "</td>" +
              '<td class="py-2.5 text-slate-500">' +
              shortTime(s.called_at) +
              "</td></tr>"
            );
          })
          .join("") ||
        '<tr><td colspan="7" class="py-6 text-center text-slate-500">No specimens yet</td></tr>';
    }

    if (typeof Chart === "undefined") return;

    var fillRates = ARM_ORDER.map(function (code) {
      var subset = arms.filter(function (a) {
        return a.arm_code === code;
      });
      if (!subset.length) return 0;
      return (
        (subset.filter(function (a) {
          return a.filled;
        }).length /
          subset.length) *
        100
      );
    });

    var fillEl = $("chart-fill");
    if (fillEl) {
      if (charts.fill) charts.fill.destroy();
      charts.fill = new Chart(fillEl.getContext("2d"), {
        type: "bar",
        data: {
          labels: ARM_ORDER,
          datasets: [
            {
              data: fillRates,
              backgroundColor: "rgba(110, 231, 183, 0.35)",
              borderColor: "rgba(110, 231, 183, 0.9)",
              borderWidth: 1,
              borderRadius: 4,
            },
          ],
        },
        options: chartOpts("%"),
      });
    }

    var outcomes = {
      "Full TP": arms.filter(function (a) {
        return a.closure_reason === "full_tp";
      }).length,
      Stop: arms.filter(function (a) {
        return a.closure_reason === "stop";
      }).length,
      "No fill": arms.filter(function (a) {
        return a.no_fill || a.closure_reason === "no_fill";
      }).length,
      Open: arms.filter(function (a) {
        return !a.closure_reason;
      }).length,
    };
    var outEl = $("chart-outcome");
    if (outEl) {
      if (charts.outcome) charts.outcome.destroy();
      charts.outcome = new Chart(outEl.getContext("2d"), {
        type: "doughnut",
        data: {
          labels: Object.keys(outcomes),
          datasets: [
            {
              data: Object.values(outcomes),
              backgroundColor: [
                "rgba(110, 231, 183, 0.7)",
                "rgba(248, 113, 113, 0.7)",
                "rgba(251, 191, 36, 0.7)",
                "rgba(125, 211, 252, 0.5)",
              ],
              borderWidth: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: "bottom",
              labels: { color: "#94a3b8", boxWidth: 10, font: { size: 11 } },
            },
          },
        },
      });
    }
  }


  function renderTreatments() {
    var arms = state.arms;
    var rows = ARM_ORDER.map(function (code) {
      var subset = arms.filter(function (a) {
        return a.arm_code === code;
      });
      var n = subset.length;
      var fills = subset.filter(function (a) {
        return a.filled;
      }).length;
      var closed = subset.filter(function (a) {
        return a.closure_reason && a.closure_reason !== "no_fill";
      });
      var avgRoi = closed.length
        ? closed.reduce(function (s, a) {
            return s + (Number(a.realized_roi) || 0);
          }, 0) / closed.length
        : null;
      return {
        code: code,
        disc: subset[0] ? subset[0].discount_pct : "—",
        n: n,
        fills: fills,
        fillPct: n ? fills / n : null,
        tp1: subset.filter(function (a) {
          return a.tp1_hit;
        }).length,
        tp2: subset.filter(function (a) {
          return a.tp2_hit;
        }).length,
        tp3: subset.filter(function (a) {
          return a.tp3_hit;
        }).length,
        stops: subset.filter(function (a) {
          return a.stop_hit || a.closure_reason === "stop";
        }).length,
        nofill: subset.filter(function (a) {
          return a.no_fill || a.closure_reason === "no_fill";
        }).length,
        pnlSum: subset.reduce(function (s, a) {
          return s + (Number(a.realized_pnl_usd) || 0);
        }, 0),
        avgRoi: avgRoi,
      };
    });

    var tt = $("treatment-table");
    if (tt) {
      tt.innerHTML = rows
        .map(function (r) {
          return (
            '<tr class="data-row">' +
            '<td class="px-4 py-3 text-white font-medium">' +
            r.code +
            "</td>" +
            '<td class="px-3 py-3 text-slate-400">' +
            r.disc +
            "%</td>" +
            '<td class="px-3 py-3">' +
            r.n +
            "</td>" +
            '<td class="px-3 py-3 text-accent">' +
            r.fills +
            "</td>" +
            '<td class="px-3 py-3">' +
            (r.fillPct == null ? "—" : (r.fillPct * 100).toFixed(0) + "%") +
            "</td>" +
            '<td class="px-3 py-3">' +
            r.tp1 +
            "</td>" +
            '<td class="px-3 py-3">' +
            r.tp2 +
            "</td>" +
            '<td class="px-3 py-3">' +
            r.tp3 +
            "</td>" +
            '<td class="px-3 py-3 text-danger">' +
            r.stops +
            "</td>" +
            '<td class="px-3 py-3 text-warn">' +
            r.nofill +
            "</td>" +
            '<td class="px-3 py-3 ' +
            (r.pnlSum >= 0 ? "text-accent" : "text-danger") +
            '">' +
            fmtUsd(r.pnlSum) +
            "</td>" +
            '<td class="px-3 py-3">' +
            (r.avgRoi == null ? "—" : fmtPct(r.avgRoi)) +
            "</td></tr>"
          );
        })
        .join("");
    }

    if (typeof Chart === "undefined") return;
    var roiEl = $("chart-roi");
    if (roiEl) {
      if (charts.roi) charts.roi.destroy();
      charts.roi = new Chart(roiEl.getContext("2d"), {
        type: "bar",
        data: {
          labels: ARM_ORDER,
          datasets: [
            {
              data: rows.map(function (r) {
                return r.avgRoi == null ? 0 : r.avgRoi * 100;
              }),
              backgroundColor: rows.map(function (r) {
                return (r.avgRoi || 0) >= 0
                  ? "rgba(110, 231, 183, 0.35)"
                  : "rgba(248, 113, 113, 0.35)";
              }),
              borderColor: rows.map(function (r) {
                return (r.avgRoi || 0) >= 0
                  ? "rgba(110, 231, 183, 0.9)"
                  : "rgba(248, 113, 113, 0.9)";
              }),
              borderWidth: 1,
              borderRadius: 4,
            },
          ],
        },
        options: chartOpts("%"),
      });
    }
  }

  function renderSignals() {
    var searchEl = $("filter-search");
    var statusEl = $("filter-status");
    var q = ((searchEl && searchEl.value) || "").toLowerCase();
    var st = (statusEl && statusEl.value) || "";
    var list = state.signals;
    if (st) {
      list = list.filter(function (s) {
        return s.status === st;
      });
    }
    if (q) {
      list = list.filter(function (s) {
        return [s.specimen_id, s.token_symbol, s.contract_address, s.network].some(
          function (x) {
            return (x || "").toLowerCase().indexOf(q) !== -1;
          }
        );
      });
    }

    var table = $("signals-table");
    if (!table) return;
    table.innerHTML =
      list
        .map(function (s) {
          return (
            '<tr class="data-row">' +
            '<td class="px-4 py-3 text-accent">' +
            esc(s.specimen_id) +
            "</td>" +
            '<td class="px-3 py-3 text-white">$' +
            esc(s.token_symbol || "—") +
            "</td>" +
            '<td class="px-3 py-3 text-slate-400">' +
            esc(s.network || "—") +
            "</td>" +
            '<td class="px-3 py-3">' +
            fmtPrice(s.signal_price_usd) +
            "</td>" +
            '<td class="px-3 py-3 text-info">' +
            fmtPrice(s.highest_price_usd) +
            "</td>" +
            '<td class="px-3 py-3 text-slate-400">' +
            fmtPrice(s.lowest_price_usd) +
            " / " +
            fmtPrice(s.highest_price_usd) +
            "</td>" +
            '<td class="px-3 py-3">' +
            (s.experiment_day != null ? s.experiment_day : "—") +
            "</td>" +
            '<td class="px-3 py-3">' +
            statusPill(s.status) +
            "</td>" +
            '<td class="px-3 py-3"><button type="button" data-open-specimen="' +
            esc(s.id) +
            '" class="text-accent hover:underline text-[11px]">View</button></td></tr>'
          );
        })
        .join("") ||
      '<tr><td colspan="8" class="px-4 py-8 text-center text-slate-500">No signals</td></tr>';

    table.querySelectorAll("[data-open-specimen]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-open-specimen");
        var sel = $("specimen-select");
        if (sel) sel.value = id;
        showTab("specimen");
        loadSpecimen(id);
      });
    });
  }

  function fillSpecimenSelect() {
    var sel = $("specimen-select");
    if (!sel) return;
    var cur = sel.value;
    sel.innerHTML =
      '<option value="">Select specimen…</option>' +
      state.signals
        .map(function (s) {
          return (
            '<option value="' +
            esc(s.id) +
            '">' +
            esc(s.specimen_id) +
            " · $" +
            esc(s.token_symbol || "?") +
            "</option>"
          );
        })
        .join("");
    if (cur) sel.value = cur;
  }

  async function loadSpecimen(id) {
    var sig = state.signals.find(function (s) {
      return s.id === id;
    });
    if (!sig) return;

    $("specimen-empty").classList.add("hidden");
    $("specimen-empty").style.display = "none";
    $("specimen-detail").classList.remove("hidden");
    $("specimen-detail").style.display = "block";

    $("sp-id").textContent = sig.specimen_id;
    $("sp-token").textContent = sig.token_symbol || "UNKNOWN";
    $("sp-meta").textContent =
      (sig.network || "?") +
      " · Day " +
      (sig.experiment_day != null ? sig.experiment_day : "—") +
      " · " +
      shortTime(sig.called_at);
    $("sp-price").textContent = fmtPrice(sig.signal_price_usd);
    $("sp-latest").textContent = fmtPrice(sig.highest_price_usd);
    $("sp-source").textContent =
      "Fetch: " +
      (sig.fetch_status || "—") +
      " · Source: " +
      (sig.fetch_source || "—") +
      " · Channel: " +
      (sig.channel_name || "—");

    var arms = state.arms
      .filter(function (a) {
        return a.signal_id === id;
      })
      .sort(function (a, b) {
        return ARM_ORDER.indexOf(a.arm_code) - ARM_ORDER.indexOf(b.arm_code);
      });

    $("sp-arms").innerHTML =
      arms
        .map(function (a) {
          return (
            '<tr class="data-row">' +
            '<td class="px-4 py-3 text-white">' +
            a.arm_code +
            "</td>" +
            '<td class="px-3 py-3">' +
            fmtPrice(a.entry_target_usd) +
            "</td>" +
            '<td class="px-3 py-3">' +
            (a.filled ? fmtPrice(a.fill_price_usd) : "—") +
            "</td>" +
            '<td class="px-3 py-3">' +
            boolMark(a.tp1_hit) +
            "</td>" +
            '<td class="px-3 py-3">' +
            boolMark(a.tp2_hit) +
            "</td>" +
            '<td class="px-3 py-3">' +
            boolMark(a.tp3_hit) +
            "</td>" +
            '<td class="px-3 py-3">' +
            boolMark(a.stop_hit) +
            "</td>" +
            '<td class="px-3 py-3">' +
            (a.remaining_pct != null
              ? (Number(a.remaining_pct) * 100).toFixed(0) + "%"
              : "—") +
            "</td>" +
            '<td class="px-3 py-3 ' +
            (Number(a.realized_pnl_usd) >= 0 ? "text-accent" : "text-danger") +
            '">' +
            fmtUsd(a.realized_pnl_usd) +
            "</td>" +
            '<td class="px-3 py-3 text-slate-400">' +
            (a.closure_reason || "open") +
            "</td></tr>"
          );
        })
        .join("") ||
      '<tr><td colspan="10" class="px-4 py-6 text-center text-slate-500">No arms</td></tr>';

    var tickRes = await sb
      .from("price_ticks")
      .select("*")
      .eq("signal_id", id)
      .order("observed_at", { ascending: true });

    if (!tickRes.error && tickRes.data && tickRes.data.length) {
      var ticks = tickRes.data;
      $("sp-latest").textContent = fmtPrice(
        ticks[ticks.length - 1].price_usd
      );

      var chartEl = $("chart-specimen-price");
      if (chartEl && typeof Chart !== "undefined") {
        if (charts.specimenPrice) charts.specimenPrice.destroy();

        var labels = ticks.map(function (t) {
          return shortTime(t.observed_at);
        });
        var values = ticks.map(function (t) {
          return Number(t.price_usd);
        });

        charts.specimenPrice = new Chart(chartEl.getContext("2d"), {
          type: "line",
          data: {
            labels: labels,
            datasets: [{
              label: "Observed price",
              data: values,
              borderColor: "rgba(125, 211, 252, 0.9)",
              backgroundColor: "rgba(125, 211, 252, 0.08)",
              borderWidth: 1.5,
              pointRadius: 0,
              tension: 0.15,
              fill: true
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false }
            },
            scales: {
              x: {
                ticks: {
                  color: "#64748b",
                  font: { size: 9 },
                  maxTicksLimit: 7
                },
                grid: { color: "rgba(26,30,42,0.8)" }
              },
              y: {
                type: "logarithmic",
                ticks: {
                  color: "#64748b",
                  font: { size: 9 },
                  callback: function (v) {
                    return fmtPrice(v);
                  }
                },
                grid: { color: "rgba(26,30,42,0.8)" }
              }
            }
          }
        });
      }
    }

    var evRes = await sb
      .from("arm_events")
      .select("*, treatment_arms(arm_code)")
      .eq("signal_id", id)
      .order("event_at", { ascending: true });

    if (evRes.error) {
      $("sp-events").innerHTML =
        '<p class="text-danger">' + esc(evRes.error.message) + "</p>";
      return;
    }
    var events = evRes.data;
    if (!events || !events.length) {
      $("sp-events").innerHTML = '<p class="text-slate-500">No events yet</p>';
      return;
    }

    var color = {
      ENTRY: "text-info",
      TP1: "text-accent",
      TP2: "text-accent",
      TP3: "text-accent",
      STOP: "text-danger",
      NO_FILL: "text-warn",
    };

    $("sp-events").innerHTML = events
      .map(function (e) {
        var arm =
          (e.treatment_arms && e.treatment_arms.arm_code) || "?";
        return (
          '<div class="flex flex-wrap gap-x-3 gap-y-1 py-1.5 border-b border-ink-700/60">' +
          '<span class="text-slate-500 w-28 shrink-0">' +
          shortTime(e.event_at) +
          "</span>" +
          '<span class="text-white w-16">' +
          arm +
          "</span>" +
          '<span class="' +
          (color[e.event_type] || "text-slate-300") +
          ' w-16">' +
          e.event_type +
          "</span>" +
          '<span class="text-slate-400">' +
          (e.event_type === "NO_FILL" ? "—" : fmtPrice(e.event_price_usd)) +
          "</span>" +
          '<span class="text-slate-600">rem ' +
          (Number(e.remaining_pct_after || 0) * 100).toFixed(0) +
          "%</span></div>"
        );
      })
      .join("");
  }

  setTimeout(function () {
    var fs = $("filter-search");
    var fst = $("filter-status");
    if (fs) fs.addEventListener("input", renderSignals);
    if (fst) fst.addEventListener("change", renderSignals);
    var sel = $("specimen-select");
    if (sel) {
      sel.addEventListener("change", function (e) {
        if (e.target.value) loadSpecimen(e.target.value);
        else {
          $("specimen-empty").classList.remove("hidden");
          $("specimen-empty").style.display = "block";
          $("specimen-detail").classList.add("hidden");
          $("specimen-detail").style.display = "none";
        }
      });
    }
    var btn = $("btn-refresh");
    if (btn) {
      btn.addEventListener("click", function () {
        loadAll().then(function () {
          toast("Refreshed");
        });
      });
    }
  }, 0);

  loadAll();
  setInterval(loadAll, 60000);
})();
