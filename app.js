/* ============================================================
   Train Fund Tracker — static app (vanilla JS, no build step)
   ============================================================ */

/* ============================================================
   CONFIG
   ------------------------------------------------------------
   WORKER_URL: the deployed Cloudflare Worker base URL, e.g.
     "https://trainfundtrack-api.yourname.workers.dev"
   • When SET  → real logins + saving happen on the Worker
                 (passwords & GitHub token live server-side).
   • When EMPTY→ local-dev mode: uses CREDENTIALS below, reads
                 local data.json, "Save" just downloads a file.
   ============================================================ */
const WORKER_URL = "https://trainfundtrack-api.trainfundtrack.workers.dev";

/* ---- LOCAL-DEV credentials only (ignored when WORKER_URL is set).
   Blank on purpose: this repo is PUBLIC, so real passwords must never
   live here — they live only in the Worker's secrets. Once WORKER_URL
   is set, login goes through the Worker and these are never used. */
const CREDENTIALS = {
  admin: { password: "", role: "admin" },
  mohit: { password: "", role: "guest" },
};

/* ---- Capabilities by role ----
   admin  : edit everything (trains, both receipt columns, notes, partners)
   guest  : edit only the "Received Mohit" column                        */
const isAdmin = () => state.role === "admin";
const canEditVG = () => state.role === "admin";
const canEditMohit = () => state.role === "admin" || state.role === "guest";
const canEditAny = () => canEditVG() || canEditMohit();

/* ---- App state ---- */
const state = {
  data: null,
  role: null,
  globalRange: { from: "", to: "" },
  perTrain: {},        // id -> { open, from, to }
  visible: {},         // id -> bool
  dirty: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ============================================================
   Date & number utilities (dates handled as YYYY-MM-DD strings)
   ============================================================ */
function todayISO() {
  const d = new Date();
  return isoFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
}
function isoFromParts(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function parseUTC(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function isoFromUTC(ms) {
  const d = new Date(ms);
  return isoFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
const DAY = 86400000;
function addDays(ms, n) { return ms + n * DAY; }
function subDaysISO(iso, n) { return isoFromUTC(parseUTC(iso) - n * DAY); }

function prettyDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d} ${months[m - 1]} ${y}`;
}

const CUR = () => (state.data && state.data.meta.currency) || "₹";
function fmtMoney(n) {
  if (n == null || isNaN(n)) return "—";
  const neg = n < 0;
  const abs = Math.abs(Math.round(n));
  // Indian grouping
  const s = abs.toLocaleString("en-IN");
  return (neg ? "-" : "") + CUR() + s;
}
function fmtNum(n) { return Math.round(n).toLocaleString("en-IN"); }

/* ============================================================
   Schedule generation + per-train calculation
   ============================================================ */
function txTotal(t) { return (Number(t.vg) || 0) + (Number(t.mohit) || 0); }

function scheduleDates(train) {
  const { frequency, start, end } = train.schedule;
  const step = frequency === "daily" ? 1 : frequency === "weekly" ? 7 : 0;
  if (!step) return [];
  const out = [];
  let cur = parseUTC(start);
  const stop = parseUTC(end);
  while (cur <= stop) {
    out.push(isoFromUTC(cur));
    cur = addDays(cur, step);
  }
  return out;
}

/* Returns a computed view of a train for a given [from,to] window.
   "Till date" metrics cap the window end at today. */
function computeTrain(train, from, to) {
  const today = todayISO();
  const lo = from || "0000-01-01";
  const hiRaw = to || "9999-12-31";
  const hi = hiRaw < today ? hiRaw : today;      // cap at today for "till date"

  const rate = train.schedule.rate || 0;
  const sched = scheduleDates(train);

  // expected (number of scheduled dates within window) * rate
  let expectedCount = 0;
  for (const d of sched) if (d >= lo && d <= hi) expectedCount++;
  const expected = expectedCount * rate;

  // received within window (VG + Mohit)
  let received = 0;
  for (const t of train.transactions) if (t.date >= lo && t.date <= hi) received += txTotal(t);

  // all-time received (for breakeven / recovery)
  let receivedAll = 0;
  for (const t of train.transactions) receivedAll += txTotal(t);

  const shortfall = expected - received;          // collection pending vs schedule
  const recoveryGap = train.investment - receivedAll; // toward breakeven (all-time)
  const recoveryPct = train.investment > 0 ? (receivedAll / train.investment) * 100 : 0;

  return {
    expected, received, receivedAll, shortfall,
    investment: train.investment, recoveryGap, recoveryPct,
    windowFrom: from || (sched[0] || train.schedule.start),
    windowTo: hi,
  };
}

/* Build union rows (schedule ∪ transactions) for the detail table */
function detailRows(train, from, to) {
  const rate = train.schedule.rate || 0;
  const sched = new Set(scheduleDates(train));
  const vgByDate = {}, mohitByDate = {}, noteByDate = {}, idxByDate = {};
  train.transactions.forEach((t, i) => {
    vgByDate[t.date] = (vgByDate[t.date] || 0) + (Number(t.vg) || 0);
    mohitByDate[t.date] = (mohitByDate[t.date] || 0) + (Number(t.mohit) || 0);
    if (t.note) noteByDate[t.date] = t.note;
    idxByDate[t.date] = i; // last index on that date (for edit)
  });
  const allDates = new Set([...sched, ...Object.keys(idxByDate)]);
  const lo = from || "0000-01-01";
  const hi = to || "9999-12-31";
  const rows = [...allDates].filter(d => d >= lo && d <= hi).sort();
  return rows.map(d => {
    const isSched = sched.has(d);
    const exp = isSched ? rate : 0;
    const hasTx = d in idxByDate;
    const vg = vgByDate[d] || 0;
    const mohit = mohitByDate[d] || 0;
    return {
      date: d, expected: exp, vg, mohit, hasTx,
      diff: exp - vg - mohit,
      note: noteByDate[d] || "",
      txIndex: hasTx ? idxByDate[d] : -1,
    };
  });
}

/* ============================================================
   AUTH
   ============================================================ */
function doLogin(user, pass) {
  const name = user.trim().toLowerCase();
  const u = CREDENTIALS[name];
  if (u && u.password === pass) {
    sessionStorage.setItem("tft_role", u.role);
    sessionStorage.setItem("tft_user", name);
    return u.role;
  }
  return null;
}
function currentRole() { return sessionStorage.getItem("tft_role"); }
function logout() { sessionStorage.removeItem("tft_role"); location.reload(); }

/* ============================================================
   DATA LOADING
   ============================================================ */
async function loadData() {
  // In Worker mode, read the freshest copy via the Worker (bypasses the
  // ~1-min GitHub Pages rebuild delay). Locally, read the file directly.
  const src = WORKER_URL ? WORKER_URL + "/api/data" : "data.json?_=" + Date.now();
  const res = await fetch(src, { cache: "no-store" });
  if (!res.ok) throw new Error("Could not load data (" + res.status + ")");
  return res.json();
}

async function serverLogin(user, pass) {
  try {
    const res = await fetch(WORKER_URL + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user.trim().toLowerCase(), password: pass }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    sessionStorage.setItem("tft_role", j.role);
    sessionStorage.setItem("tft_user", j.username);
    sessionStorage.setItem("tft_token", j.token);
    return j.role;
  } catch { return null; }
}

/* ============================================================
   SAVE — via Cloudflare Worker (GitHub token stays server-side)
   ============================================================ */
function serializeData() {
  state.data.meta.updated = todayISO();
  return JSON.stringify(state.data, null, 2) + "\n";
}

async function saveToServer() {
  if (!WORKER_URL) { downloadJson(); return; }   // local dev: fall back to download
  const btn = $("#btn-save");
  const token = sessionStorage.getItem("tft_token");
  btn.disabled = true;
  setSaveStatus("Saving…", "");
  try {
    serializeData(); // stamp updated date
    const res = await fetch(WORKER_URL + "/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ data: state.data }),
    });
    if (res.status === 401) { setSaveStatus("Session expired — log out and back in.", "err"); return; }
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || ("HTTP " + res.status)); }
    state.dirty = false;
    $("#dirty-flag").hidden = true;
    $("#data-updated").textContent = prettyDate(state.data.meta.updated);
    setSaveStatus("Saved ✓ (live in ~1 min)", "ok");
  } catch (e) {
    setSaveStatus("Save failed: " + e.message, "err");
  } finally {
    btn.disabled = false;
  }
}
function setSaveStatus(msg, cls) {
  const el = $("#save-status");
  el.hidden = false;
  el.textContent = msg;
  el.className = "save-status " + cls;
  if (cls === "ok") setTimeout(() => { el.hidden = true; }, 4000);
}

/* ============================================================
   RENDERING
   ============================================================ */
function markDirty() {
  state.dirty = true;
  $("#dirty-flag").hidden = false;
}

function renderAll() {
  renderTrainFilter();
  renderTrainList();
  renderCumulative();
  renderRangeNote();
  $("#data-updated").textContent = prettyDate(state.data.meta.updated);
}

function renderRangeNote() {
  const { from, to } = state.globalRange;
  const today = todayISO();
  let txt = "Showing cumulative totals ";
  if (!from && !to) txt += "for all time";
  else txt += `from ${from ? prettyDate(from) : "start"} to ${to ? prettyDate(to) : "today"}`;
  txt += ` · “till date” metrics are capped at today (${prettyDate(today)}).`;
  $("#range-note").textContent = txt;
}

function renderTrainFilter() {
  const wrap = $("#train-filter");
  wrap.innerHTML = "";
  state.data.trains.forEach(t => {
    const label = document.createElement("label");
    label.className = "tf-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.visible[t.id] !== false;
    cb.addEventListener("change", () => {
      state.visible[t.id] = cb.checked;
      renderTrainList();
      renderCumulative();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + t.name));
    wrap.appendChild(label);
  });
}

function kpiTile(label, value, cls, sub) {
  return `<div class="tile">
    <div class="t-label">${label}</div>
    <div class="t-value ${cls || ""}">${value}</div>
    ${sub ? `<div class="t-sub">${sub}</div>` : ""}
  </div>`;
}

function renderTrainList() {
  const list = $("#train-list");
  list.innerHTML = "";
  state.data.trains.forEach(train => {
    if (state.visible[train.id] === false) return;
    const pt = state.perTrain[train.id] || (state.perTrain[train.id] = {
      open: false, from: state.globalRange.from, to: state.globalRange.to,
    });
    const c = computeTrain(train, pt.from, pt.to);

    const card = document.createElement("div");
    card.className = "card" + (pt.open ? " open" : "");

    const shortClass = c.shortfall > 0 ? "neg" : "pos";
    card.innerHTML = `
      <div class="card-head">
        <span class="card-caret">▶</span>
        <span class="card-title">${train.name}</span>
        <div class="head-kpis">
          <div class="head-kpi"><span class="k-label">Invested</span><span class="k-val tnum">${fmtMoney(c.investment)}</span></div>
          <div class="head-kpi"><span class="k-label">Received</span><span class="k-val tnum">${fmtMoney(c.received)}</span></div>
          <div class="head-kpi"><span class="k-label">Recovered</span><span class="k-val tnum">${c.recoveryPct.toFixed(1)}%</span></div>
        </div>
      </div>
      <div class="card-body"></div>`;

    card.querySelector(".card-head").addEventListener("click", () => {
      pt.open = !pt.open;
      card.classList.toggle("open", pt.open);
      if (pt.open && !card.querySelector(".card-body").dataset.built) {
        buildCardBody(card.querySelector(".card-body"), train);
      }
    });

    if (pt.open) buildCardBody(card.querySelector(".card-body"), train);
    list.appendChild(card);
  });
}

function buildCardBody(body, train) {
  const pt = state.perTrain[train.id];
  const c = computeTrain(train, pt.from, pt.to);
  body.dataset.built = "1";

  const shortClass = c.shortfall > 0 ? "neg" : (c.shortfall < 0 ? "pos" : "");
  const shortLabel = c.shortfall > 0 ? "Pending vs expected" : (c.shortfall < 0 ? "Collected above expected" : "On target");

  const tiles = `
    <div class="kpi-grid">
      ${kpiTile("Total invested", fmtMoney(c.investment))}
      ${kpiTile("Received (VG+Mohit, range)", fmtMoney(c.received))}
      ${kpiTile("Expected till date (range)", fmtMoney(c.expected))}
      ${kpiTile(shortLabel, fmtMoney(Math.abs(c.shortfall)), shortClass)}
    </div>`;

  const pct = Math.min(100, Math.max(0, c.recoveryPct));
  const meter = `
    <div class="meter-wrap">
      <div class="meter-top">
        <span>Recovery toward breakeven <span class="muted">(all-time received vs invested)</span></span>
        <span class="tnum"><strong>${c.recoveryPct.toFixed(1)}%</strong></span>
      </div>
      <div class="meter"><div class="meter-fill" style="width:${pct}%"></div></div>
      <div class="meter-sub">Received ${fmtMoney(c.receivedAll)} of ${fmtMoney(c.investment)} ·
        <strong>${fmtMoney(c.recoveryGap)}</strong> still to recover</div>
    </div>`;

  const ownRange = `
    <div class="sub-controls">
      <div class="own-range ctrl">
        <label>From</label><input type="date" class="pt-from" value="${pt.from || ""}" />
      </div>
      <div class="own-range ctrl">
        <label>To</label><input type="date" class="pt-to" value="${pt.to || ""}" />
      </div>
      <button class="btn btn-ghost btn-sm pt-sync">Use global range</button>
      <button class="btn btn-ghost btn-sm pt-clear">All time</button>
      ${canEditAny() ? `<div class="spacer"></div>${isAdmin() ? '<button class="btn btn-ghost btn-sm pt-edit">Edit train</button>' : ""}<button class="btn btn-primary btn-sm pt-add">+ Add receipt</button>` : ""}
    </div>`;

  body.innerHTML = tiles + meter + ownRange + `
    <div class="detail-grid">
      <div>${renderScheduleTable(train, pt)}</div>
      <div>${renderBreakdown(train)}</div>
    </div>`;

  // wire range inputs
  const refresh = () => { body.dataset.built = ""; buildCardBody(body, train); renderCumulative(); };
  body.querySelector(".pt-from").addEventListener("change", e => { pt.from = e.target.value; refresh(); });
  body.querySelector(".pt-to").addEventListener("change", e => { pt.to = e.target.value; refresh(); });
  body.querySelector(".pt-sync").addEventListener("click", () => { pt.from = state.globalRange.from; pt.to = state.globalRange.to; refresh(); });
  body.querySelector(".pt-clear").addEventListener("click", () => { pt.from = ""; pt.to = ""; refresh(); });
  const addBtn = body.querySelector(".pt-add");
  if (addBtn) addBtn.addEventListener("click", () => openEntryModal(train.id, -1));
  const editBtn = body.querySelector(".pt-edit");
  if (editBtn) editBtn.addEventListener("click", () => openTrainModal(train.id));

  // wire row edit (admin edits both columns; guest edits Received Mohit)
  if (canEditAny()) {
    body.querySelectorAll(".row-edit").forEach(el => {
      el.addEventListener("click", () => openEntryModal(train.id, Number(el.dataset.idx), el.dataset.date));
    });
  }
}

function renderScheduleTable(train, pt) {
  const rows = detailRows(train, pt.from, pt.to);
  if (!rows.length) {
    return `<div class="sched-wrap"><p class="muted" style="padding:14px">No scheduled dates or receipts in this range.${
      train.schedule.frequency === "none" ? " This train has no rent schedule set yet." : ""}</p></div>`;
  }
  const edit = canEditAny();
  const body = rows.map(r => {
    const diffCls = r.diff > 0 ? "diff-neg" : (r.diff < 0 ? "diff-pos" : "");
    const vgCell = r.hasTx ? fmtNum(r.vg) : '<span class="muted">—</span>';
    const mohitCell = r.hasTx ? fmtNum(r.mohit) : '<span class="muted">—</span>';
    const showDiff = r.hasTx || r.expected;
    const editCell = edit
      ? `<td><span class="row-edit" data-idx="${r.txIndex}" data-date="${r.date}">${r.txIndex >= 0 ? "edit" : "add"}</span></td>`
      : "";
    return `<tr>
      <td>${prettyDate(r.date)}</td>
      <td>${r.expected ? fmtNum(r.expected) : '<span class="muted">—</span>'}</td>
      <td>${vgCell}</td>
      <td>${mohitCell}</td>
      <td class="${diffCls}">${showDiff ? fmtNum(r.diff) : ""}</td>
      <td class="note">${r.note || ""}</td>
      ${editCell}
    </tr>`;
  }).join("");
  return `<div class="sched-wrap"><div class="sched-scroll"><table class="sched">
    <thead><tr><th>Date</th><th>Expected</th><th>Received VG</th><th>Received Mohit</th><th>Diff</th><th>Note</th>${edit ? "<th></th>" : ""}</tr></thead>
    <tbody>${body}</tbody>
  </table></div></div>`;
}

function renderBreakdown(train) {
  const rows = (train.breakdown || []).map(b => {
    const val = b.amount == null ? (b.note || "—") : fmtMoney(b.amount);
    return `<tr><td>${b.label}</td><td class="tnum">${val}</td></tr>`;
  }).join("");
  return `<div class="breakdown">
    <h3>Procurement details (from sheet)</h3>
    <table><tbody>${rows}</tbody></table>
  </div>`;
}

function renderCumulative() {
  const trains = state.data.trains.filter(t => state.visible[t.id] !== false);
  const { from, to } = state.globalRange;
  let invested = 0, received = 0, expected = 0, receivedAll = 0;
  trains.forEach(t => {
    const c = computeTrain(t, from, to);
    invested += c.investment; received += c.received; expected += c.expected; receivedAll += c.receivedAll;
  });
  const shortfall = expected - received;
  const recoveryGap = invested - receivedAll;
  const recoveryPct = invested > 0 ? (receivedAll / invested) * 100 : 0;
  const pct = Math.min(100, Math.max(0, recoveryPct));
  const shortClass = shortfall > 0 ? "neg" : (shortfall < 0 ? "pos" : "");

  // Total Expense is always the sum of ALL trains' invested amounts (not just visible)
  const totalExpense = state.data.trains.reduce((a, t) => a + (Number(t.investment) || 0), 0);
  const partners = state.data.meta.partners || [];
  const yp = partners.find(p => p.key === "yp") || { label: "Paid VG", amount: 0 };
  const m = partners.find(p => p.key === "m") || { label: "Paid Mohit", amount: 0 };
  const split = totalExpense / 2;

  // Total received per stream, across ALL trains, up to today ("till date")
  const today = todayISO();
  let totalRecVG = 0, totalRecMohit = 0;
  state.data.trains.forEach(t => t.transactions.forEach(x => {
    if (x.date <= today) { totalRecVG += Number(x.vg) || 0; totalRecMohit += Number(x.mohit) || 0; }
  }));

  // Due formulas: 50% Split − Paid − (half of the other partner's extra collection)
  const dueMohit = split - (Number(m.amount) || 0) - ((totalRecVG - totalRecMohit) / 2);
  const dueVG    = split - (Number(yp.amount) || 0) - ((totalRecMohit - totalRecVG) / 2);

  const admin = isAdmin();
  const rn = state.data.meta.rowNotes || (state.data.meta.rowNotes = {});
  const auto = '<span class="muted">(auto)</span>';
  const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const noteCell = (id, noteVal) => admin
    ? `<td class="rn-cell"><input class="rn-input" data-rowid="${id}" value="${esc(noteVal)}" placeholder="—" /></td>`
    : `<td class="rn-cell note">${esc(noteVal)}</td>`;
  const prow = (id, label, val, bold, cls) => {
    let note;
    if (id.indexOf("custom:") === 0) note = (state.data.meta.financeNotes[+id.split(":")[1]] || {}).note || "";
    else note = rn[id] || "";
    const lab = bold ? `<strong>${label}</strong>` : label;
    const amt = bold ? `<strong>${fmtMoney(val)}</strong>` : fmtMoney(val);
    return `<tr${cls ? ` class="${cls}"` : ""}><td>${lab}</td><td class="tnum">${amt}</td>${noteCell(id, note)}</tr>`;
  };
  const notes =
    prow("totalExpense", `Total Expense ${auto} <span class="muted">(sum of all trains invested)</span>`, totalExpense, true) +
    prow("paidVG", yp.label, yp.amount) +
    prow("paidMohit", m.label, m.amount) +
    prow("split", `50% Split ${auto}`, split, false, "sep") +
    prow("totalRecVG", `Total Received VG ${auto}`, totalRecVG) +
    prow("totalRecMohit", `Total Received Mohit ${auto}`, totalRecMohit) +
    prow("dueMohit", `Due Mohit ${auto}`, dueMohit, false, "sep") +
    prow("dueVG", `Due VG ${auto}`, dueVG) +
    (state.data.meta.financeNotes || []).map((n, i) => prow("custom:" + i, n.label, n.amount, false, "sep")).join("");

  $("#cumulative").innerHTML = `
    <div class="cum-card">
      <h2>Cumulative — ${trains.length} train${trains.length === 1 ? "" : "s"} selected</h2>
      <div class="cum-sub">${from || to ? `Range: ${from ? prettyDate(from) : "start"} → ${to ? prettyDate(to) : "today"}` : "All time"}</div>
      <div class="kpi-grid">
        ${kpiTile("Total invested", fmtMoney(invested))}
        ${kpiTile("Total received (range)", fmtMoney(received))}
        ${kpiTile("Total expected till date (range)", fmtMoney(expected))}
        ${kpiTile(shortfall >= 0 ? "Total pending vs expected" : "Collected above expected", fmtMoney(Math.abs(shortfall)), shortClass)}
      </div>
      <div class="meter-wrap">
        <div class="meter-top">
          <span>Overall recovery toward breakeven <span class="muted">(all-time received vs invested)</span></span>
          <span class="tnum"><strong>${recoveryPct.toFixed(1)}%</strong></span>
        </div>
        <div class="meter"><div class="meter-fill" style="width:${pct}%"></div></div>
        <div class="meter-sub">Received ${fmtMoney(receivedAll)} of ${fmtMoney(invested)} ·
          <strong>${fmtMoney(recoveryGap)}</strong> still to recover</div>
      </div>
      <div class="breakdown" style="margin-top:16px">
        <h3 style="display:flex;justify-content:space-between;align-items:center">
          <span>Partnership &amp; procurement</span>
          ${admin ? '<span class="row-edit" id="edit-notes-btn">edit amounts</span>' : ""}
        </h3>
        <table class="partnership">
          <thead><tr><th>Item</th><th>Amount</th><th>Notes</th></tr></thead>
          <tbody>${notes}</tbody>
        </table>
      </div>
    </div>`;

  if (admin) {
    $("#edit-notes-btn").addEventListener("click", openNotesModal);
    $$("#cumulative .rn-input").forEach(inp => {
      inp.addEventListener("change", () => {
        const id = inp.dataset.rowid;
        if (id.indexOf("custom:") === 0) {
          const i = +id.split(":")[1];
          if (state.data.meta.financeNotes[i]) state.data.meta.financeNotes[i].note = inp.value;
        } else {
          state.data.meta.rowNotes[id] = inp.value;
        }
        markDirty();
      });
    });
  }
}

/* ============================================================
   ENTRY MODAL (admin)
   ============================================================ */
function openEntryModal(trainId, txIndex, presetDate) {
  const modal = $("#entry-modal");
  $("#entry-train").value = trainId;
  $("#entry-index").value = txIndex;
  const train = state.data.trains.find(t => t.id === trainId);
  if (txIndex >= 0) {
    const t = train.transactions[txIndex];
    $("#entry-title").textContent = "Edit receipt — " + train.name;
    $("#entry-date").value = t.date;
    $("#entry-vg").value = t.vg || 0;
    $("#entry-mohit").value = t.mohit || 0;
    $("#entry-note").value = t.note || "";
    $("#entry-delete").hidden = !isAdmin();
  } else {
    $("#entry-title").textContent = "Add receipt — " + train.name;
    $("#entry-date").value = presetDate || todayISO();
    $("#entry-vg").value = "";
    $("#entry-mohit").value = "";
    $("#entry-note").value = "";
    $("#entry-delete").hidden = true;
  }
  // guest can only edit the Received Mohit column
  const vgLocked = !canEditVG();
  $("#entry-vg").disabled = vgLocked;
  $("#entry-note").disabled = !isAdmin();
  modal.hidden = false;
}
function closeEntryModal() { $("#entry-modal").hidden = true; }

function saveEntry() {
  const trainId = $("#entry-train").value;
  const idx = Number($("#entry-index").value);
  const date = $("#entry-date").value;
  const vg = Number($("#entry-vg").value) || 0;
  const mohit = Number($("#entry-mohit").value) || 0;
  const note = $("#entry-note").value.trim();
  if (!date) { alert("Please enter a valid date."); return; }
  const train = state.data.trains.find(t => t.id === trainId);
  const entry = { date, vg, mohit };
  if (note) entry.note = note;
  if (idx >= 0) train.transactions[idx] = entry;
  else train.transactions.push(entry);
  train.transactions.sort((a, b) => a.date.localeCompare(b.date));
  markDirty();
  closeEntryModal();
  rebuildOpenCards();
  renderCumulative();
}
function deleteEntry() {
  const trainId = $("#entry-train").value;
  const idx = Number($("#entry-index").value);
  if (idx < 0) return;
  const train = state.data.trains.find(t => t.id === trainId);
  train.transactions.splice(idx, 1);
  markDirty();
  closeEntryModal();
  rebuildOpenCards();
  renderCumulative();
}
function rebuildOpenCards() {
  // simplest: re-render whole list preserving open/visibility state
  renderTrainList();
}

/* ============================================================
   TRAIN MODAL (admin) — add / edit / delete trains
   ============================================================ */
function slugify(name) {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "train";
  let id = base, n = 2;
  while (state.data.trains.some(t => t.id === id)) id = base + "-" + n++;
  return id;
}
function openTrainModal(id) {
  const m = $("#train-modal");
  $("#train-edit-id").value = id || "";
  if (id) {
    const t = state.data.trains.find(x => x.id === id);
    $("#train-modal-title").textContent = "Edit train — " + t.name;
    $("#train-name").value = t.name;
    $("#train-invested").value = t.investment;
    $("#train-freq").value = t.schedule.frequency;
    $("#train-rate").value = t.schedule.rate || 0;
    $("#train-start").value = t.schedule.start || "";
    $("#train-end").value = t.schedule.end || "";
    $("#train-delete").hidden = false;
  } else {
    $("#train-modal-title").textContent = "Add train";
    $("#train-name").value = "";
    $("#train-invested").value = "";
    $("#train-freq").value = "daily";
    $("#train-rate").value = "";
    $("#train-start").value = todayISO();
    $("#train-end").value = "";
    $("#train-delete").hidden = true;
  }
  m.hidden = false;
}
function closeTrainModal() { $("#train-modal").hidden = true; }
function saveTrain() {
  const id = $("#train-edit-id").value;
  const name = $("#train-name").value.trim();
  const investment = Number($("#train-invested").value) || 0;
  const frequency = $("#train-freq").value;
  const rate = Number($("#train-rate").value) || 0;
  const start = $("#train-start").value;
  const end = $("#train-end").value;
  if (!name) { alert("Train name is required."); return; }
  if (frequency !== "none" && (!start || !end)) { alert("Please set schedule start and end dates (or choose frequency “None”)."); return; }
  if (id) {
    const t = state.data.trains.find(x => x.id === id);
    t.name = name;
    t.investment = investment;
    t.schedule = { frequency, rate, start: start || t.schedule.start, end: end || t.schedule.end };
  } else {
    const newId = slugify(name);
    state.data.trains.push({
      id: newId, name, investment,
      schedule: { frequency, rate, start: start || todayISO(), end: end || todayISO() },
      breakdown: [], transactions: [],
    });
    state.visible[newId] = true;
    state.perTrain[newId] = { open: true, from: state.globalRange.from, to: state.globalRange.to };
  }
  markDirty();
  closeTrainModal();
  renderAll();
}
function deleteTrain() {
  const id = $("#train-edit-id").value;
  if (!id) return;
  const t = state.data.trains.find(x => x.id === id);
  if (!confirm(`Delete train ${t.name} and all its receipts? This cannot be undone (until you reload without saving).`)) return;
  state.data.trains = state.data.trains.filter(x => x.id !== id);
  delete state.visible[id];
  delete state.perTrain[id];
  markDirty();
  closeTrainModal();
  renderAll();
}

/* ============================================================
   NOTES MODAL (admin) — edit partnership / procurement notes
   ============================================================ */
function openNotesModal() {
  const wrap = $("#notes-rows");
  wrap.innerHTML = "";
  // partner rows (label + amount editable, not removable)
  const partners = state.data.meta.partners || [];
  ["yp", "m"].forEach(key => {
    const p = partners.find(x => x.key === key) || { key, label: key === "yp" ? "Paid VG" : "Paid Mohit", amount: 0 };
    wrap.appendChild(noteRowEl(p.label, p.amount, { key, fixed: true }));
  });
  // custom notes
  (state.data.meta.financeNotes || []).forEach(n => wrap.appendChild(noteRowEl(n.label, n.amount, {})));
  $("#notes-modal").hidden = false;
}
function noteRowEl(label, amount, opts) {
  opts = opts || {};
  const row = document.createElement("div");
  row.className = "note-row";
  if (opts.key) row.dataset.key = opts.key;
  row.innerHTML = `
    <input type="text" class="n-label" placeholder="Label" value="${(label || "").replace(/"/g, "&quot;")}" />
    <input type="number" class="n-amount" step="1" placeholder="Amount" value="${amount == null ? "" : amount}" />
    ${opts.fixed ? '<span class="note-del" style="color:var(--muted);cursor:default" title="Partner contribution — not removable">●</span>'
                 : '<button class="note-del" title="Remove">✕</button>'}`;
  if (!opts.fixed) row.querySelector(".note-del").addEventListener("click", () => row.remove());
  return row;
}
function saveNotes() {
  const rows = $$("#notes-rows .note-row");
  const partners = [];
  const notes = [];
  rows.forEach(r => {
    const label = r.querySelector(".n-label").value.trim();
    const amt = r.querySelector(".n-amount").value;
    const amount = amt === "" ? 0 : Number(amt);
    if (r.dataset.key) partners.push({ key: r.dataset.key, label: label || r.dataset.key, amount });
    else if (label) notes.push({ label, amount });
  });
  state.data.meta.partners = partners;
  state.data.meta.financeNotes = notes;
  markDirty();
  $("#notes-modal").hidden = true;
  renderCumulative();
}

/* ============================================================
   WIRING
   ============================================================ */
function applyPreset(preset) {
  const today = todayISO();
  if (preset === "all") { state.globalRange = { from: "", to: "" }; }
  else if (preset === "30") { state.globalRange = { from: subDaysISO(today, 29), to: today }; }
  else if (preset === "90") { state.globalRange = { from: subDaysISO(today, 89), to: today }; }
  else if (preset === "mtd") {
    const [y, m] = today.split("-");
    state.globalRange = { from: `${y}-${m}-01`, to: today };
  }
  $("#global-from").value = state.globalRange.from;
  $("#global-to").value = state.globalRange.to;
  $$("#global-presets .chip").forEach(c => c.classList.toggle("active", c.dataset.preset === preset));
  // propagate to per-train ranges that were synced (reset all to follow global)
  Object.values(state.perTrain).forEach(pt => { pt.from = state.globalRange.from; pt.to = state.globalRange.to; });
  renderAll();
}

function wireControls() {
  $("#global-from").addEventListener("change", e => {
    state.globalRange.from = e.target.value;
    $$("#global-presets .chip").forEach(c => c.classList.remove("active"));
    syncPerTrainToGlobal(); renderAll();
  });
  $("#global-to").addEventListener("change", e => {
    state.globalRange.to = e.target.value;
    $$("#global-presets .chip").forEach(c => c.classList.remove("active"));
    syncPerTrainToGlobal(); renderAll();
  });
  $$("#global-presets .chip").forEach(c =>
    c.addEventListener("click", () => applyPreset(c.dataset.preset)));
  $("#btn-clear-range").addEventListener("click", () => applyPreset("all"));

  $("#btn-expand-all").addEventListener("click", () => {
    state.data.trains.forEach(t => { (state.perTrain[t.id] = state.perTrain[t.id] || {}).open = true; });
    syncOpenDefaults(); renderTrainList();
  });
  $("#btn-collapse-all").addEventListener("click", () => {
    Object.values(state.perTrain).forEach(pt => pt.open = false);
    renderTrainList();
  });

  $("#btn-logout").addEventListener("click", logout);

  // train modal
  $("#btn-add-train").addEventListener("click", () => openTrainModal(null));
  $("#train-close").addEventListener("click", closeTrainModal);
  $("#train-save").addEventListener("click", saveTrain);
  $("#train-delete").addEventListener("click", deleteTrain);
  $("#train-modal").addEventListener("click", e => { if (e.target.id === "train-modal") closeTrainModal(); });

  // notes modal
  $("#notes-close").addEventListener("click", () => $("#notes-modal").hidden = true);
  $("#notes-save").addEventListener("click", saveNotes);
  $("#notes-add").addEventListener("click", () => $("#notes-rows").appendChild(noteRowEl("", "")));
  $("#notes-modal").addEventListener("click", e => { if (e.target.id === "notes-modal") $("#notes-modal").hidden = true; });

  // save / backup
  $("#btn-save").addEventListener("click", saveToServer);
  $("#btn-backup").addEventListener("click", downloadJson);

  // entry modal
  $("#entry-close").addEventListener("click", closeEntryModal);
  $("#entry-save").addEventListener("click", saveEntry);
  $("#entry-delete").addEventListener("click", deleteEntry);
  $("#entry-modal").addEventListener("click", e => { if (e.target.id === "entry-modal") closeEntryModal(); });

  window.addEventListener("beforeunload", e => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
  });
}
function syncPerTrainToGlobal() {
  Object.values(state.perTrain).forEach(pt => { pt.from = state.globalRange.from; pt.to = state.globalRange.to; });
}
function syncOpenDefaults() {
  state.data.trains.forEach(t => {
    const pt = state.perTrain[t.id] = state.perTrain[t.id] || { open: true, from: state.globalRange.from, to: state.globalRange.to };
    if (pt.from === undefined) pt.from = state.globalRange.from;
    if (pt.to === undefined) pt.to = state.globalRange.to;
  });
}

function downloadJson() {
  const blob = new Blob([serializeData()], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "data.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ============================================================
   BOOT
   ============================================================ */
async function boot() {
  $("#today-label").textContent = prettyDate(todayISO());
  state.role = currentRole();

  // login form
  $("#login-form").addEventListener("submit", async e => {
    e.preventDefault();
    const user = $("#login-user").value, pass = $("#login-pass").value;
    const role = WORKER_URL ? await serverLogin(user, pass) : doLogin(user, pass);
    if (!role) { $("#login-error").hidden = false; return; }
    state.role = role;
    await startApp();
  });

  if (state.role) await startApp();
}

async function startApp() {
  $("#login-screen").hidden = true;
  $("#app").hidden = false;

  // role UI
  const badge = $("#role-badge");
  badge.textContent = sessionStorage.getItem("tft_user") || state.role;
  badge.classList.toggle("admin", state.role === "admin");
  $("#btn-save").hidden = !(WORKER_URL && canEditAny());   // real save only exists in Worker mode
  $("#btn-backup").hidden = !canEditAny();                 // download a JSON backup anytime
  $("#btn-add-train").hidden = state.role !== "admin";

  if (!state.data) {
    try { state.data = await loadData(); }
    catch (err) { alert(err.message); return; }
  }
  // default visibility + first train open
  state.data.trains.forEach((t, i) => {
    if (state.visible[t.id] === undefined) state.visible[t.id] = true;
    state.perTrain[t.id] = state.perTrain[t.id] || { open: false, from: "", to: "" };
  });
  state.globalRange = { from: "", to: "" };
  wireControls();
  renderAll();
}

boot();
