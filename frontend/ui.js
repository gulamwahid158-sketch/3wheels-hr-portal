"use strict";
// Shared building blocks for the greytHR-style pages: date helpers, month grid,
// dialogs, collapsible cards, tab bars and empty states.

// ---- dates and times ----
const pad2 = n => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;                   // m is 1..12
const dateIso = d => isoOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
const todayIso = () => dateIso(new Date());
const localYm = () => todayIso().slice(0, 7);
const addMonths = (ym, n) => { const [y, m] = ym.split("-").map(Number), d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };
const monthName = (ym, style = "long") => new Date(ym + "-01T00:00").toLocaleDateString("en-GB", { month: style });
const monthTitle = ym => `${monthName(ym)} ${ym.slice(0, 4)}`;
const dayNum = iso => +iso.slice(8, 10);
const weekdayOf = (iso, style = "short") => new Date(iso + "T00:00").toLocaleDateString("en-GB", { weekday: style });
const longDate = iso => new Date(iso + "T00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
const timeMins = t => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "")); return m ? +m[1] * 60 + +m[2] : null; };
const hhmm = x => x == null || isNaN(x) ? "-" : `${pad2(Math.floor(x / 60))}:${pad2(Math.round(x % 60))}`;
// minutes between two HH:MM times; a night shift ends after midnight, so an earlier "out" means the next day
const workMins = (a, b) => { const x = timeMins(a), y = timeMins(b); return x == null || y == null ? null : (y >= x ? y - x : y + 1440 - x); };
const hour12 = h => `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
// "11:00-20:00" -> { start: 660, end: 1200, code: "11T8", name: "11am To 8pm" } (null when the shift is not a fixed time range)
function shiftInfo(shift) {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(shift || ""));
  if (!m) return { start: null, end: null, code: "FLEX", name: String(shift || "Flexible"), text: String(shift || "Flexible") };
  const start = +m[1] * 60 + +m[2], end = +m[3] * 60 + +m[4];
  return { start, end, code: `${+m[1]}T${(+m[3]) % 12 || 12}`, name: `${hour12(+m[1])} To ${hour12(+m[3])}`, text: `${m[1].padStart(2, "0")}:${m[2]} to ${m[3].padStart(2, "0")}:${m[4]}` };
}

// A month laid out in whole weeks (Sunday first). Days of the neighbouring months are flagged out:true.
function monthGrid(ym) {
  const [y, m] = ym.split("-").map(Number), first = new Date(y, m - 1, 1), count = new Date(y, m, 0).getDate();
  const lead = first.getDay(), total = Math.ceil((lead + count) / 7) * 7, cells = [];
  for (let i = 0; i < total; i++) { const d = new Date(y, m - 1, 1 - lead + i); cells.push({ iso: dateIso(d), day: d.getDate(), out: d.getMonth() !== m - 1 }); }
  return cells;
}

// ---- small pieces of markup ----
const segTabs = (names, cur, cls = "") => `<div class="seg-wrap"><div class="seg ${cls}" role="tablist">${names.map((n, i) => `<button type="button" role="tab" data-seg="${i}" class="${i === cur ? "on" : ""}">${esc(n)}</button>`).join("")}</div></div>`;
const underlineTabs = (names, cur) => `<div class="utabs" role="tablist">${names.map((n, i) => `<button type="button" role="tab" data-ut="${i}" class="${i === cur ? "on" : ""}">${esc(n)}</button>`).join("")}</div>`;
const wireSeg = (root, fn) => root.querySelectorAll("[data-seg]").forEach(b => b.onclick = () => fn(+b.dataset.seg));
const wireUt = (root, fn) => root.querySelectorAll("[data-ut]").forEach(b => b.onclick = () => fn(+b.dataset.ut));
const emptyBlock = (art, title, msg, btn = "", btnId = "") => `<div class="empty"><div class="e-art">${ART[art] || ""}</div>${title ? `<h3>${esc(title)}</h3>` : ""}<p>${esc(msg)}</p>${btn ? `<button class="btn" type="button" id="${btnId}">${esc(btn)}</button>` : ""}</div>`;

// Collapsible card used for history and pending lists.
// cols: [[label, value]...]; body: html shown when open; status: [text, cssClass]
function rcard(id, cols, status, body) {
  return `<article class="rcard" data-rc="${esc(id)}"><div class="rc-head" role="button" tabindex="0" aria-expanded="false">
    ${cols.map(c => `<div class="rc-col"><small>${esc(c[0])}</small><b>${esc(c[1])}</b></div>`).join("")}
    <span class="rc-status ${esc(status[1])}">${esc(status[0])}</span><span class="rc-chev">${icon("chev", "ico sm")}</span></div>
    <div class="rc-body" hidden>${body}</div></article>`;
}
function wireRcards(root) {
  root.querySelectorAll(".rc-head").forEach(h => {
    const toggle = () => { const body = h.nextElementSibling, open = body.hidden; body.hidden = !open; h.setAttribute("aria-expanded", String(open)); h.parentElement.classList.toggle("open", open); };
    h.onclick = toggle; h.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
  });
}
const rcStatus = s => s === "approved" ? ["APPROVED", "ok"] : s === "rejected" ? ["REJECTED", "bad"] : s === "pending" ? ["PENDING", "warn"] : s === "cancelled" || s === "withdrawn" ? ["WITHDRAWN", "mute"] : [String(s).toUpperCase(), "mute"];

// ---- dialog: round close button, Esc and a click outside close it ----
function openDialog(title, html, opts = {}) {
  closeDialog();
  document.body.insertAdjacentHTML("beforeend", `<div class="modal-back" id="dlg"><div class="dialog ${opts.wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="dlg-head"><h2>${esc(title)}</h2><button type="button" class="dlg-x" id="dlg-x" aria-label="Close">×</button></div><div class="dlg-body">${html}</div></div></div>`);
  $("#dlg-x").onclick = closeDialog;
  $("#dlg").onclick = e => { if (e.target.id === "dlg") closeDialog(); };
  return $("#dlg .dlg-body");
}
function closeDialog() { const d = $("#dlg"); if (d) d.remove(); }
if (!window.__dlgEsc) { window.__dlgEsc = true; document.addEventListener("keydown", e => { if (e.key === "Escape") closeDialog(); }); }

// approvers offered in "Applying to": the reporting manager first, then the backup approvers
function approverList(info) {
  const out = [];
  if (info.manager) out.push({ id: info.manager.id, name: info.manager.name, label: "Manager" });
  (info.backups || []).forEach(b => out.push({ id: b.id, name: b.name, label: b.role.toUpperCase() }));
  return out;
}
const fmtComma = iso => { const d = new Date(String(iso).slice(0, 10) + "T00:00"); return isNaN(d) ? "-" : `${pad2(d.getDate())} ${d.toLocaleDateString("en-GB", { month: "short" })}, ${d.getFullYear()}`; };
function downloadCsv(name, rows) {
  const csv = rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
// financial year (April to March) as "2026 - 2027"
const fyStart = iso => +iso.slice(5, 7) >= 4 ? +iso.slice(0, 4) : +iso.slice(0, 4) - 1;
const fyLabel = y => `${y} - ${y + 1}`;

// ---- grey line drawings for empty states ----
const lineSvg = (vb, inner) => `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
Object.assign(ART, {
  emptyList: lineSvg("0 0 300 170", `<rect x="86" y="42" width="150" height="96" rx="6"/><path d="M104 74h52M104 90h34M104 106h44"/><circle cx="196" cy="78" r="10"/><path d="M180 108c3-9 29-9 32 0"/><rect x="36" y="84" width="64" height="54" rx="6" fill="var(--card)"/><circle cx="68" cy="108" r="13"/><path d="M62 108l12 0"/><rect x="170" y="12" width="64" height="30" rx="9" fill="var(--card)"/><path d="M190 27h.01M202 27h.01M214 27h.01"/><path d="M14 54l8 8m0-8l-8 8"/>`),
  calClock: lineSvg("0 0 200 160", `<rect x="40" y="36" width="120" height="96" rx="8"/><path d="M40 62h120M70 24v22M130 24v22"/><path d="M62 82h10M86 82h10M110 82h10M62 100h10M86 100h10"/><circle cx="130" cy="112" r="20" fill="var(--card)"/><path d="M130 100v12l8 5"/>`),
  tasksBoard: lineSvg("0 0 200 170", `<rect x="62" y="22" width="76" height="124" rx="6"/><rect x="72" y="34" width="26" height="8" rx="3" fill="var(--accent)"/><path d="M72 58h30M72 76h38M72 94h34M72 112h40"/><circle cx="76" cy="58" r="0"/><rect x="26" y="50" width="30" height="30" rx="3" fill="var(--accent)" fill-opacity=".5" transform="rotate(-12 41 65)"/><rect x="142" y="62" width="30" height="30" rx="3" fill="var(--card)" transform="rotate(10 157 77)"/><rect x="38" y="104" width="30" height="30" rx="3" fill="var(--card)" transform="rotate(8 53 119)"/>`),
  feedbackMon: lineSvg("0 0 220 180", `<rect x="46" y="34" width="128" height="86" rx="8"/><path d="M96 120v16M72 140h76"/><circle cx="110" cy="70" r="17" fill="var(--accent)" fill-opacity=".6"/><path d="M104 66h.01M116 66h.01M104 76c3 3 9 3 12 0"/><path d="M84 96l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" opacity=".5"/><path d="M106 96l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" opacity=".5"/><path d="M128 96l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" opacity=".5"/>`),
  thumb: lineSvg("0 0 200 200", `<circle cx="100" cy="104" r="76" fill="var(--accent)" fill-opacity=".35"/><path d="M82 112V80c0-6 4-10 9-10l3 24h30c6 0 9 5 8 10l-5 24c-1 5-5 8-10 8H82z" fill="var(--card)"/><path d="M70 112h12v36H70z" fill="var(--card)"/><path d="M146 40l4 9 9 1-7 6 2 9-8-5-8 5 2-9-7-6 9-1z" fill="var(--accent)"/>`),
});
