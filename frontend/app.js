"use strict";
const $ = (s, r = document) => r.querySelector(s);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = n => "₹" + Number(n || 0).toLocaleString("en-IN");
const fdate = s => s ? new Date(s.length === 10 ? s + "T00:00" : s.replace(" ", "T")).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "-";
let ME = null;
let MAINT = false, _maintTimer = null;
// Role groups, kept in step with backend/app.py
const EXEC_ROLES = ["ceo", "coo", "cpo", "executive", "superadmin"];   // leadership tier
const HR_LIKE_ROLES = ["hr", "admin"];                                  // manage people, never executive accounts
const ADMIN_ROLES = [...HR_LIKE_ROLES, ...EXEC_ROLES];

async function api(path, method = "GET", data) {
  const r = await fetch("/api/" + path, { method, headers: { "Content-Type": "application/json" }, body: data ? JSON.stringify(data) : undefined });
  // 502/503/504 = server or database temporarily unavailable -> maintenance screen
  if ([502, 503, 504].includes(r.status)) { MAINT = true; render(); throw new Error("The portal is under maintenance"); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "login") { ME = null; tabAuth(false); render(); throw new Error("Please log in"); }
  if (!r.ok) throw new Error(j.error || "Request failed");
  if (path === "login") tabAuth(true);
  if (path === "logout") tabAuth(false);
  return j;
}

// "Logged in" is remembered only in this tab's sessionStorage, which the browser
// clears when the tab or window is closed. So closing the tab ends the login:
// the next visit starts at the sign-in page. (A reload keeps it, as it is the same tab.)
function tabAuth(on) { try { on ? sessionStorage.setItem("tab_auth", "1") : sessionStorage.removeItem("tab_auth"); } catch { } }
function tabAuthed() { try { return sessionStorage.getItem("tab_auth") === "1"; } catch { return true; } }
async function bootMe() { if (!tabAuthed()) { ME = null; return; } await refreshMe(); }
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2600); }
const titleCase = s => String(s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
const badge = s => `<span class="badge ${esc(s)}">${esc(titleCase(s))}</span>`;
function table(cols, rows, empty = "Nothing here yet.") {
  if (!rows.length) return `<p class="mute">${esc(empty)}</p>`;
  return `<div class="tablewrap"><table><thead><tr>${cols.map(c => `<th>${esc(c[0])}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${c[2] ? c[1](r) : esc(c[1](r))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
// field: {n,label,type,opts,groups,req}  opts: [[value,label]]; groups: [{name,items:[string]}]
function form(id, fields, submit = "Submit") {
  return `<form id="${id}" novalidate>${`<div class="row">${fields.map(f => {
    if (f.type === "section") return `<div style="grid-column:1/-1;margin-top:14px;padding-top:12px;border-top:1px solid var(--line);font-weight:700;font-size:13px;color:var(--ink)">${esc(f.label)}</div>`;
    const c = `name="${f.n}" id="${id}-${f.n}" ${f.req === false ? "" : "required"}`;
    const isSel = v => f.value !== undefined && f.value !== null && String(f.value) === String(v);
    const opts = f.groups
      ? `<option value="">— Select Designation —</option>` + f.groups.map(g => `<optgroup label="${esc(g.name)}">${g.items.map(o => `<option value="${esc(o)}" ${isSel(o) ? "selected" : ""}>${esc(o)}</option>`).join("")}</optgroup>`).join("")
      : (f.opts || []).map(o => `<option value="${esc(o[0])}" ${isSel(o[0]) ? "selected" : ""}>${esc(o[1])}</option>`).join("");
    let inp = f.type === "select" ? `<select ${c}${f.groups ? " data-ddl" : ""}>${opts}</select>`
      : f.type === "textarea" ? `<textarea ${c} rows="2">${esc(f.value ?? "")}</textarea>`
      : `<input ${c} type="${f.type || "text"}" ${f.readonly ? "readonly" : ""} ${f.step ? `step="${f.step}"` : ""} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ""} ${f.value !== undefined && f.value !== null && f.value !== "" ? `value="${esc(f.value)}"` : ""}>`;
    return `<div><label for="${id}-${f.n}">${esc(f.label)}</label>${inp}</div>`;
  }).join("")}</div>`}<p class="err" id="${id}-err" role="alert"></p><button class="btn">${esc(submit)}</button></form>`;
}
function wire(id, endpoint, done, tweak) {
  const f = $("#" + id); if (!f) return;
  f.onsubmit = async e => {
    e.preventDefault(); $(`#${id}-err`).textContent = "";
    let data = Object.fromEntries(new FormData(f));
    if (tweak) data = tweak(data);
    try { await api(endpoint, "POST", data); toast("Submitted"); done(); } catch (er) { $(`#${id}-err`).textContent = er.message; }
  };
}
const tabs = (names, cur) => `<div class="tabs" role="tablist">${names.map((n, i) => `<button role="tab" data-t="${i}" class="${i === cur ? "on" : ""}">${esc(n)}</button>`).join("")}</div>`;
function wireTabs(fn) { document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => fn(+b.dataset.t)); }

// Long grouped lists (designations) use our own dropdown instead of the browser's, because a
// native <select> list opens upward when it is long. This one always opens below the field,
// scrolls inside itself, and has a search box. The real <select> stays in the page (hidden) and
// is kept in sync, so forms and the existing change handlers keep working unchanged.
function enhanceSelect(sel) {
  if (sel.dataset.ddlDone) return;
  sel.dataset.ddlDone = "1";
  const wrap = document.createElement("div"); wrap.className = "ddl";
  if (sel.style.minWidth) wrap.style.minWidth = sel.style.minWidth;
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "ddl-btn";
  btn.setAttribute("aria-haspopup", "listbox"); btn.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div"); panel.className = "ddl-panel"; panel.hidden = true;
  const search = document.createElement("input"); search.type = "search"; search.className = "ddl-search";
  search.placeholder = "Search..."; search.setAttribute("aria-label", "Search the list");
  const list = document.createElement("div"); list.className = "ddl-list"; list.setAttribute("role", "listbox");
  panel.append(search, list); wrap.append(btn, panel);
  sel.style.display = "none"; sel.after(wrap);

  const optLabel = o => o.textContent;
  const paintButton = () => {
    const o = sel.options[sel.selectedIndex];
    const text = o && o.value ? optLabel(o) : (sel.options[0] ? optLabel(sel.options[0]) : "Select");
    btn.innerHTML = `<span class="${o && o.value ? "" : "mute"}">${esc(text)}</span><i aria-hidden="true">▾</i>`;
  };
  const item = o => `<div class="ddl-opt${o.value === sel.value ? " sel" : ""}" role="option" aria-selected="${o.value === sel.value}" data-v="${esc(o.value)}">${esc(optLabel(o))}</div>`;
  const buildList = q => {
    const needle = q.trim().toLowerCase(), match = o => o.value && (!needle || optLabel(o).toLowerCase().includes(needle));
    let html = "";
    [...sel.children].forEach(ch => {
      if (ch.tagName === "OPTGROUP") {
        const rows = [...ch.children].filter(match);
        if (rows.length) html += `<div class="ddl-group">${esc(ch.label)}</div>${rows.map(item).join("")}`;
      } else if (match(ch)) html += item(ch);
    });
    list.innerHTML = html || `<div class="ddl-empty mute">Nothing found</div>`;
  };
  const close = () => { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  const open = () => {
    document.querySelectorAll(".ddl-panel:not([hidden])").forEach(p => { p.hidden = true; });
    search.value = ""; buildList("");
    panel.hidden = false; btn.setAttribute("aria-expanded", "true");
    const cur = list.querySelector(".sel"); if (cur) cur.scrollIntoView({ block: "nearest" });
    search.focus({ preventScroll: true });
  };
  btn.onclick = () => panel.hidden ? open() : close();
  search.oninput = () => buildList(search.value);
  list.onclick = e => {
    const row = e.target.closest(".ddl-opt"); if (!row) return;
    sel.value = row.dataset.v;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    paintButton(); close(); btn.focus();
  };
  panel.onkeydown = e => { if (e.key === "Escape") { close(); btn.focus(); } };
  paintButton();
  if (!window.__ddlCloseBound) {
    window.__ddlCloseBound = true;
    document.addEventListener("click", e => document.querySelectorAll(".ddl-panel:not([hidden])").forEach(p => {
      if (!p.parentElement.contains(e.target)) { p.hidden = true; const b = p.parentElement.querySelector(".ddl-btn"); if (b) b.setAttribute("aria-expanded", "false"); }
    }));
  }
}

// ---------------- pages ----------------
const P = {};
// Small line drawings for the Home page (drawn for this portal; they follow the theme colours)
const ART = {
  hero: `<svg viewBox="0 0 460 210" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="340" cy="66" r="26" fill="var(--accent)" stroke="none" opacity=".9"/>
    <path d="M340 24v-8M372 36l6-6M308 36l-6-6M388 66h8M284 66h-8"/>
    <path d="M8 178h444"/>
    <path d="M18 178c42-48 84-52 124-22s92 12 132-26 112-14 178 48" opacity=".55"/>
    <path d="M60 196c90-8 250-8 340 0" opacity=".35"/>
    <g transform="translate(170 108)">
      <path d="M12 58V34c0-8 6-14 14-14h46l22 16h12v22" fill="var(--card)"/>
      <path d="M26 20h46l6 8H26z" fill="var(--accent)" fill-opacity=".55"/>
      <path d="M30 30h34l14 10H30z"/>
      <circle cx="34" cy="62" r="10" fill="var(--card)"/><circle cx="106" cy="62" r="10" fill="var(--card)"/>
      <path d="M34 62h.01M106 62h.01"/>
    </g>
  </svg>`,
  review: `<svg viewBox="0 0 90 90" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="22" y="14" width="46" height="62" rx="5"/><rect x="34" y="8" width="22" height="12" rx="3" fill="var(--accent)"/>
    <path d="M32 36h5M43 36h17M32 48h5M43 48h17M32 60h5M43 60h12"/></svg>`,
  payslip: `<svg viewBox="0 0 120 100" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="28" y="8" width="50" height="70" rx="5"/><path d="M38 22h30M38 34h30M38 46h16"/>
    <circle cx="76" cy="66" r="19" fill="var(--accent)" fill-opacity=".25"/><path d="M90 80l16 14"/>
    <text x="76" y="73" text-anchor="middle" font-size="19" font-weight="700" fill="currentColor" stroke="none">₹</text></svg>`,
  track: `<svg viewBox="0 0 140 70" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10 54h120"/><circle cx="32" cy="54" r="8" fill="var(--accent)"/><circle cx="68" cy="54" r="8" fill="var(--accent)"/>
    <path d="M104 54V14l24 9-24 9" fill="var(--accent)" fill-opacity=".45"/></svg>`,
  doc: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="10" y="6" width="28" height="36" rx="4" fill="var(--accent)" fill-opacity=".2"/><path d="M17 16h14M17 24h14M17 32h8"/></svg>`,
};
const HOME_QUOTES = [
  "Small steps every day add up to big results.",
  "Well begun is half done. Make today count.",
  "Great teams are built one good day at a time.",
  "Focus on progress, not perfection.",
  "A calm start makes for a productive day.",
  "Do the next right thing, and then the one after.",
  "Your effort today is tomorrow's result.",
  "Good work is quiet work. Keep going.",
];
P.home = async el => {
  const h = await api("home");
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good Morning" : hour < 17 ? "Good Afternoon" : "Good Evening";
  const quote = HOME_QUOTES[Math.floor(Date.now() / 86400000) % HOME_QUOTES.length];
  const first = esc(ME.name.split(" ")[0]);
  const card = (title, body, link) => `<section class="card h-card"><div class="h-card-head"><h2>${title}</h2>${link ? `<a class="h-arrow" href="${link}" aria-label="Open ${esc(title)}">→</a>` : ""}</div>${body}</section>`;
  const empty = (art, msg) => `<div class="h-empty"><div class="h-art">${art}</div><p>${msg}</p></div>`;
  const note = (art, msg, link, label) => `<div class="h-note"><div class="h-ico">${art}</div><div><p>${msg}</p><a href="${link}">${label} →</a></div></div>`;
  const dayMonth = d => new Date(d + "T00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  const weekday = d => new Date(d + "T00:00").toLocaleDateString("en-IN", { weekday: "long" });
  const left = [
    card("Review", h.pending_reviews
      ? `<div class="h-empty"><div class="stat">${h.pending_reviews}</div><p>waiting for you</p><a href="#/review">Open Review →</a></div>`
      : empty(ART.review, "Hurrah! You've nothing to review.")),
    card("Quick Access", `<div class="qa"><div class="qa-links">
        <a href="#/payslips">Payslips</a><a href="#/it-statement">IT Statement</a><a href="#/ytd">YTD Reports</a><a href="#/reimbursement">Reimbursement</a><a href="#/loans">Loan Statement</a></div>
        <div class="qa-note">Use quick access to view important salary details.</div></div>`),
    card("IT Declaration", note(ART.doc, "Submit your Income Tax (IT) declaration.", "#/it-declaration", "Declare now")),
    card("Track", h.tracking.length
      ? h.tracking.map(t => `<p class="h-row">${esc(titleCase(t.kind))} ${badge(t.status)}</p>`).join("")
      : empty(ART.track, "All good! You've nothing new to track.")),
    card("My Tasks", h.tasks.length
      ? h.tasks.map(t => `<p class="h-row">${esc(t.title)} <span class="mute">${fdate(t.due_date)}</span></p>`).join("")
      : `<p class="mute">All clear.</p>`, "#/tasks"),
  ];
  const right = [
    card("Upcoming Holidays", h.holidays.length
      ? h.holidays.map(x => `<div class="h-hol"><b>${dayMonth(x.date)}</b> <span class="mute">${weekday(x.date)}</span><div class="mute">${esc(x.name)}${x.restricted ? ' <span class="badge">optional</span>' : ""}</div></div>`).join("")
      : `<p class="mute">No upcoming holidays.</p>`, "#/holidays"),
    card("Leave Balance", `${h.balances.filter(b => b.code !== "LOP").map(b => `<p class="h-row"><span class="stat">${b.balance}</span> <span class="mute">${esc(b.name)} · ${b.consumed} of ${b.granted} used</span></p>`).join("")}<a href="#/leave-apply">Apply Leave →</a>`),
    card("Payslip", `${h.payslip
      ? `<p class="h-row"><b>${esc(h.payslip.month)}</b> <span class="mute">Net pay</span> <b>${inr(h.payslip.net)}</b></p>`
      : empty(ART.payslip, "Uh oh! Your payslip will show up here after the release of payroll.")}<button class="btn h-btn" type="button" data-go="#/payslips">Request Payslip</button>`),
    card("POI", note(ART.doc, "Submit your Proof of Investments (POI).", "#/poi", "Submit proof")),
  ];
  el.innerHTML = `<div class="home2">
    <div class="greet"><div class="greet-text"><h1>${greet}, ${first}</h1><p>${esc(quote)}</p></div><div class="greet-art">${ART.hero}</div></div>
    ${h.birthdays.length ? `<div class="card home-bday">🎂 Birthday today: ${h.birthdays.map(b => esc(b.name)).join(", ")}</div>` : ""}
    <div class="h-cols"><div class="h-col">${left.join("")}</div><div class="h-col">${right.join("")}</div></div>
  </div>`;
  el.querySelectorAll("[data-go]").forEach(b => b.onclick = () => { location.hash = b.dataset.go; });
};

// ---------------- Engage: one feed of posts, polls, kudos and birthdays ----------------
const REACTIONS = ["👍", "❤️", "🎉", "👏", "😮"];
ART.cake = `<svg viewBox="0 0 120 90" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M10 14l14 6 14-6 14 6" opacity=".6"/>
  <rect x="34" y="52" width="52" height="24" rx="4" fill="var(--accent)" fill-opacity=".3"/>
  <path d="M34 62c8 6 10-4 17 0s10-4 17 0 12-4 18 0"/>
  <path d="M60 52V40"/><path d="M60 40c-4-4 0-9 0-9s4 5 0 9z" fill="var(--accent)"/>
  <path d="M96 24l3-5M104 36l6-2M16 46l-6-2"/><path d="M22 80h76"/></svg>`;
ART.kudos = `<svg viewBox="0 0 90 90" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="45" cy="34" r="20" fill="var(--accent)" fill-opacity=".3"/>
  <path d="M45 24l3 7 8 1-6 5 2 8-7-4-7 4 2-8-6-5 8-1z"/>
  <path d="M33 51l-8 24 11-5 5 9 5-25M57 51l8 24-11-5-5 9"/></svg>`;

// "a day ago", "3 days ago" ... for feed items
function timeAgo(it) {
  const s = String(it.created_at || ""); if (!s) return "";
  const d = new Date(s.length === 10 ? s + "T00:00" : s.replace(" ", "T"));
  if (isNaN(d)) return fdate(s);
  if (it.kind === "birthday") {
    const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate());
    const n = Math.round((day(new Date()) - day(d)) / 86400000);
    return n <= 0 ? "Today" : n === 1 ? "Yesterday" : n + " days ago";
  }
  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "a day ago" : days < 7 ? `${days} days ago` : fdate(s);
}

P.engage = async el => {
  const F = { type: "all", q: "", group: "", location: "", department: "", sort: "newest" };
  const expanded = new Set(["Groups"]);           // which filter sections are open
  let items = [];
  const canPost = ADMIN_ROLES.includes(ME.role);
  const first = ME.name.split(" ")[0];
  const initials = ME.name.split(" ").filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();
  const GROUPS = ["Announcements", "Events", "Recognition"];
  const ACTS = [["all", "All Activities", "▦"], ["kudos", "Kudos", "🏅"], ["polls", "Polls", "📊"], ["posts", "Posts", "📝"]];
  const typeOf = it => it.kind === "kudos" ? "kudos" : it.kind === "poll" ? "polls" : "posts";
  const uniq = k => [...new Set(items.map(i => i[k]).filter(Boolean))].sort();

  const visible = () => {
    const needle = F.q.trim().toLowerCase();
    const rows = items.filter(it => {
      if (F.type !== "all" && typeOf(it) !== F.type) return false;
      if (F.group && it.group !== F.group) return false;
      if (F.location && (it.location || "") !== F.location) return false;
      if (F.department && (it.department || "") !== F.department) return false;
      if (needle && ![it.body, it.author, it.from_name, it.to_name, it.value, it.options].filter(Boolean).join(" ").toLowerCase().includes(needle)) return false;
      return true;
    });
    rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) * (F.sort === "oldest" ? 1 : -1));
    return rows;
  };

  const t0 = new Date(), todayIso = `${t0.getFullYear()}-${String(t0.getMonth() + 1).padStart(2, "0")}-${String(t0.getDate()).padStart(2, "0")}`;
  const isToday = it => it.kind === "birthday" && String(it.created_at).slice(0, 10) === todayIso;
  const card = it => {
    let inner = "";
    if (it.kind === "post") inner = `<p class="fc-text">${esc(it.body)}</p>`;
    else if (it.kind === "poll") {
      const res = it.results || {}, total = Object.values(res).reduce((a, b) => a + b, 0) || 1;
      inner = `<p class="fc-text">${esc(it.body)}</p><div class="poll">${(it.options || "").split("|").map(o => `<div class="poll-opt"><button class="btn sec sm" type="button" data-vote="${it.id}" data-o="${esc(o)}">${it.my_vote === o ? "✓ " : ""}${esc(o)}</button> <span class="mute">${res[o] || 0} vote(s)</span><div class="bar"><i style="width:${(res[o] || 0) / total * 100}%"></i></div></div>`).join("")}</div>`;
    } else if (it.kind === "kudos") {
      inner = `<div class="fc-feature"><div class="fc-art">${ART.kudos}</div><div><p class="fc-big">${esc(it.from_name)} gave kudos to ${esc(it.to_name)}</p><span class="badge">${esc(it.value)}</span><p class="fc-text">${esc(it.message)}</p></div></div>`;
    } else if (isToday(it)) {
      // today's birthday: a bigger, celebratory card
      const sub = [it.designation, it.department].filter(Boolean).join(" · ");
      inner = `<div class="fc-feature"><div class="fc-art">${ART.cake}</div><div><p class="fc-kicker">Today's Birthday</p>
        <div class="fc-who"><span class="avatar big">${esc(it.author[0])}</span><div><b class="fc-big2">Happy Birthday, ${esc(it.author)}! 🎂</b>${sub ? `<div class="mute">${esc(sub)}</div>` : ""}</div></div>
        <p class="fc-text">Wishing you a wonderful year ahead. 🎉🎈</p></div></div>`;
    } else {
      inner = `<div class="fc-feature"><div class="fc-art">${ART.cake}</div><div><p class="mute fc-small">Happy Birthday ${esc(it.author)}, Have a great year ahead!</p><div class="fc-who"><span class="avatar sm">${esc(it.author[0])}</span><b class="fc-big">Happy Birthday, ${esc(it.author)}!</b></div></div></div>`;
    }
    const who = it.kind === "birthday" ? `<div class="fc-logo"><img src="assets/logo.png" alt=""></div><div><b>3Wheels AI</b><div class="mute fc-group">Group: ${esc(it.group)}</div></div>`
      : `<div class="avatar">${esc((it.author || "?")[0])}</div><div><b>${esc(it.author)}</b><div class="mute fc-group">Group: ${esc(it.group)}</div></div>`;
    const key = esc(it.key), mine = it.my_reaction;
    return `<article class="card fc${isToday(it) ? " fc-bday-today" : ""}"><div class="fc-head"><div class="fc-who">${who}</div><span class="mute fc-time">${esc(timeAgo(it))}</span></div>${inner}
      <div class="fc-foot"><div class="fc-rwrap"><button type="button" class="fc-react ${mine ? "on" : ""}" data-ropen>${mine || "☺"} Reaction</button>
        <div class="fc-picker" hidden>${REACTIONS.map(e => `<button type="button" class="${mine === e ? "on" : ""}" data-react="${key}" data-e="${e}" aria-label="React ${e}">${e}</button>`).join("")}</div></div>
        ${Object.entries(it.reactions || {}).map(([e, c]) => `<button type="button" class="fc-chip ${mine === e ? "mine" : ""}" data-react="${key}" data-e="${e}">${e} ${c}</button>`).join("")}</div></article>`;
  };

  const drawFeed = () => {
    const rows = visible();
    $("#eg-title").textContent = `${ACTS.find(a => a[0] === F.type)[1]} - ${F.group || "All Groups"}`;
    $("#eg-list").innerHTML = rows.length ? rows.map(card).join("") : `<div class="card eg-none">Nothing here yet.</div>`;
  };

  const drawFilters = () => {
    const radio = (name, val, label, icon = "") => `<label class="eg-opt ${F[name] === val ? "on" : ""}"><input type="radio" name="${name}" value="${esc(val)}" ${F[name] === val ? "checked" : ""}>${icon ? `<i>${icon}</i>` : ""}${esc(label)}</label>`;
    const section = (title, name, opts) => `<details class="eg-sec" data-sec="${title}" ${expanded.has(title) ? "open" : ""}><summary>${title}</summary>${radio(name, "", "All")}${opts.map(o => radio(name, o, o)).join("")}</details>`;
    const box = $("#eg-filters");
    box.innerHTML = `<h3>Filters</h3><div class="eg-sub">Activities</div>${ACTS.map(a => radio("type", a[0], a[1], a[2])).join("")}
      <div class="eg-search"><input id="eg-q" type="search" placeholder="Search" value="${esc(F.q)}" aria-label="Search the feed"></div>
      ${section("Groups", "group", GROUPS)}${section("Location", "location", uniq("location"))}${section("Department", "department", uniq("department"))}`;
    box.querySelectorAll("input[type=radio]").forEach(r => r.onchange = () => { F[r.name] = r.value; drawFilters(); drawFeed(); });
    $("#eg-q").oninput = e => { F.q = e.target.value; drawFeed(); };
    box.querySelectorAll("details").forEach(d => d.ontoggle = () => { d.open ? expanded.add(d.dataset.sec) : expanded.delete(d.dataset.sec); });
  };

  const load = async () => { items = await api("feed"); drawFilters(); drawFeed(); };

  const setReaction = async (key, emoji) => {
    const it = items.find(i => i.key === key); if (!it) return;
    const same = it.my_reaction === emoji, rc = { ...(it.reactions || {}) };
    if (it.my_reaction) { rc[it.my_reaction] = (rc[it.my_reaction] || 1) - 1; if (rc[it.my_reaction] <= 0) delete rc[it.my_reaction]; }
    if (!same) rc[emoji] = (rc[emoji] || 0) + 1;
    it.reactions = rc; it.my_reaction = same ? null : emoji; drawFeed();      // show it at once
    try { await api("react", "POST", { key, emoji: same ? null : emoji }); } catch (er) { toast(er.message); await load(); }
  };

  const closeModal = () => { const m = $("#eg-modal"); if (m) m.remove(); };
  const openModal = async kind => {
    closeModal();
    let title, html, endpoint, tweak;
    if (kind === "kudos") {
      title = "Give Kudos"; endpoint = "kudos"; tweak = d => ({ ...d, to_id: +d.to_id });
      html = form("mf", [{ n: "to_id", label: "To", type: "select", opts: await peopleOpts() }, { n: "value", label: "Value", type: "select", opts: ["Ownership", "Teamwork", "Innovation", "Customer focus"].map(x => [x, x]) }, { n: "message", label: "Message", type: "textarea" }], "Give kudos");
    } else if (kind === "poll") {
      title = "Create Poll"; endpoint = "feed";
      tweak = d => ({ body: d.body, type: "poll", options: String(d.options || "").split(/\r?\n|,/).map(s => s.trim()).filter(Boolean) });
      html = form("mf", [{ n: "body", label: "Question", type: "textarea" }, { n: "options", label: "Options (one per line, 2 to 7)", type: "textarea" }], "Create poll");
    } else {
      title = "Create Post"; endpoint = "feed"; tweak = d => ({ body: d.body, type: "post" });
      html = form("mf", [{ n: "body", label: "What do you want to share?", type: "textarea" }], "Post");
    }
    el.insertAdjacentHTML("beforeend", `<div class="modal-back" id="eg-modal"><div class="modal card" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="btn sec sm" id="eg-mclose">Close</button></div>${html}</div></div>`);
    $("#eg-mclose").onclick = closeModal;
    $("#eg-modal").onclick = e => { if (e.target.id === "eg-modal") closeModal(); };
    wire("mf", endpoint, async () => { closeModal(); await load(); }, tweak);
    const firstField = $("#mf textarea, #mf select"); if (firstField) firstField.focus();
  };
  if (!window.__egEsc) { window.__egEsc = true; document.addEventListener("keydown", e => { if (e.key === "Escape") { const m = $("#eg-modal"); if (m) m.remove(); } }); }

  el.innerHTML = `<div class="eg-wrap">
    <section class="card eg-top"><div class="avatar big eg-av">${esc(initials)}</div>
      <div class="eg-hey"><b>Hey ${esc(first)},</b><span class="mute">Ready to dive in ?</span></div>
      <div class="eg-tiles">
        <button class="eg-tile pink" type="button" data-open="kudos"><span>🏅</span>Give Kudos</button>
        <button class="eg-tile teal" type="button" data-open="poll"><span>📊</span>Create Polls</button>
        ${canPost ? '<button class="eg-tile violet" type="button" data-open="post"><span>📝</span>Create Post</button>' : ""}
      </div></section>
    <div class="eg-body"><div class="card eg-filters" id="eg-filters"></div>
      <section class="eg-main"><div class="eg-bar"><span id="eg-title">All Activities - All Groups</span>
        <label class="eg-sort">Sort: <select id="eg-sort"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label></div>
        <div id="eg-list"></div></section></div></div>`;
  el.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openModal(b.dataset.open));
  $("#eg-sort").onchange = e => { F.sort = e.target.value; drawFeed(); };
  $("#eg-list").onclick = async e => {
    const toggler = e.target.closest("[data-ropen]");
    $("#eg-list").querySelectorAll(".fc-picker:not([hidden])").forEach(p => { if (!toggler || p !== toggler.nextElementSibling) p.hidden = true; });
    if (toggler) { const p = toggler.nextElementSibling; p.hidden = !p.hidden; return; }
    const r = e.target.closest("[data-react]");
    if (r) { await setReaction(r.dataset.react, r.dataset.e); return; }
    const v = e.target.closest("[data-vote]");
    if (v) { try { await api(`feed/${v.dataset.vote}/vote`, "POST", { option: v.dataset.o }); await load(); } catch (er) { toast(er.message); } }
  };
  await load();
};


async function peopleOpts() { return (await api("people")).filter(p => p.id !== ME.id).map(p => [p.id, p.name]); }
// Kudos and Feedback live in pages-worklife.js


// Tasks and Review live in pages-todo.js


// ---- salary
P.payslips = async el => {
  const p = await api("my-payslip-requests");
  el.innerHTML = `<h1>Payslips</h1><div class="card"><h2>Request Payslip</h2><form id="psf"><label>Month</label><input type="month" name="month" required><p class="err" id="psf-err"></p><button class="btn">Request</button></form></div><div class="card"><h2>Available Payslips</h2>${table([["Month", r => r.month], ["Requested", r => r.created_at], ["", r => r.downloaded ? "<span class=mute>Downloaded</span>" : "<button class='btn sm' onclick='window.open(\"/api/payslip-download/" + r.id + "\");setTimeout(()=>render(),1000);'>Download</button>", 1]], p, "No payslips yet.")}</div>`;
  $("#psf").onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target); await api("payslip-request", "POST", { month: f.get("month") }); toast("Payslip requested to accounts"); };
};
P.ytd = async el => {
  const y = await api("ytd");
  el.innerHTML = `<h1>YTD Reports</h1><div class="card"><p class="mute">Apr 2026 onwards · ${y.months} month(s)</p><div class="grid">${["basic", "hra", "allowances", "pf", "tax", "pt", "net"].map(k => `<div><span class="mute">${k.toUpperCase()}</span><div class="stat">${inr(y[k])}</div></div>`).join("")}</div></div>`;
};
P["it-statement"] = async el => {
  const s = await api("it-statement");
  el.innerHTML = `<h1>IT Statement</h1><div class="grid"><div class="card"><span class="mute">Gross earned</span><div class="stat">${inr(s.gross)}</div></div><div class="card"><span class="mute">Tax deducted</span><div class="stat">${inr(s.tax_deducted)}</div></div></div>
  <div class="card"><h2>Declared investments</h2>${table([["Section", r => r.section], ["Amount", r => inr(r.amount)]], s.declarations)}</div>`;
};
const SECTIONS = ["80C", "80D", "80G", "24(b)", "HRA", "NPS"].map(x => [x, x]);
function crud(title, ep, fields, cols, submit) {
  return async el => {
    const draw = async () => {
      const rows = await api(ep);
      el.innerHTML = `<h1>${esc(title)}</h1><div class="card"><h2>New</h2>${form("cf", fields, submit)}</div><div class="card">${table(cols, rows)}</div>`;
      wire("cf", ep, draw);
    };
    draw();
  };
}
const FY = { n: "fy", label: "Financial year", value: "2026-27" };
P["it-declaration"] = crud("IT Declaration", "it-declaration", [FY, { n: "section", label: "Section", type: "select", opts: SECTIONS }, { n: "description", label: "Description", req: false }, { n: "amount", label: "Amount (₹)", type: "number", step: "0.01" }], [["FY", r => r.fy], ["Section", r => r.section], ["Description", r => r.description], ["Amount", r => inr(r.amount)], ["Status", r => badge(r.status), 1]]);
P.poi = crud("Proof of Investment", "poi", [FY, { n: "section", label: "Section", type: "select", opts: SECTIONS }, { n: "description", label: "Description", req: false }, { n: "amount", label: "Amount (₹)", type: "number", step: "0.01" }, { n: "proof_note", label: "Proof reference", req: false }], [["FY", r => r.fy], ["Section", r => r.section], ["Amount", r => inr(r.amount)], ["Proof", r => r.proof_note], ["Status", r => badge(r.status), 1]]);
P.reimbursement = crud("Reimbursement", "reimbursement", [{ n: "category", label: "Category", type: "select", opts: ["Internet", "Travel", "Medical", "Phone", "Other"].map(x => [x, x]) }, { n: "amount", label: "Amount (₹)", type: "number", step: "0.01" }, { n: "bill_date", label: "Bill date", type: "date" }, { n: "description", label: "Description", req: false }], [["Category", r => r.category], ["Amount", r => inr(r.amount)], ["Bill date", r => fdate(r.bill_date)], ["Status", r => badge(r.status), 1]]);
P.loans = crud("Loans and Advances", "loans", [{ n: "amount", label: "Amount (₹)", type: "number" }, { n: "tenure_months", label: "Tenure (months)", type: "number" }, { n: "reason", label: "Reason", type: "textarea" }], [["Amount", r => inr(r.amount)], ["Tenure", r => r.tenure_months + " mo"], ["Reason", r => r.reason], ["Status", r => badge(r.status), 1]]);
P.helpdesk = crud("Helpdesk", "tickets", [{ n: "category", label: "Category", type: "select", opts: ["IT", "HR", "Finance", "Admin"].map(x => [x, x]) }, { n: "subject", label: "Subject" }, { n: "body", label: "Details", type: "textarea" }], [["#", r => r.id], ["Category", r => r.category], ["Subject", r => r.subject], ["Status", r => badge(r.status), 1], ["Opened", r => fdate(r.created_at)]], "Raise ticket");
P.resignation = crud("Resignation", "resignation", [{ n: "last_day", label: "Proposed last working day", type: "date" }, { n: "reason", label: "Reason", type: "textarea" }], [["Last day", r => fdate(r.last_day)], ["Reason", r => r.reason], ["Status", r => badge(r.status), 1]], "Submit resignation");
P["salary-revision"] = async el => {
  const r = await api("salary-revisions");
  el.innerHTML = `<h1>Salary Revision</h1><div class="card">${table([["Effective", x => fdate(x.effective_from)], ["Old CTC", x => inr(x.old_ctc)], ["New CTC", x => inr(x.new_ctc)], ["Note", x => x.note]], r)}</div>`;
};

P["payslip-requests"] = P.accounts = async el => {
  let activeId = null;
  const draw = async () => {
    const rows = await api("payslip-requests");
    const active = activeId ? rows.find(r => r.id === activeId) : null;
    const pending = rows.filter(r => r.status !== "sent");
    el.innerHTML = `<h1>Payslip Requests</h1>
      ${active ? `<div class="card" style="border-left:4px solid var(--brand)">
        <h2>Upload &amp; Send Payslip — ${esc(active.name)} (${esc(active.emp_no)})</h2>
        <p class="mute">${esc(active.designation || "")} · ${esc(active.department || "")} · ${esc(active.month)}</p>
        <form id="ps-send" data-id="${active.id}">
          <div class="row">
            <div><label for="ps-send-file">Attach payslip file</label><input id="ps-send-file" type="file" name="file" accept=".pdf,.png,.jpg,.jpeg"></div>
          </div>
          <p class="err" id="ps-send-err" role="alert"></p>
          <button class="btn">Upload &amp; Send</button>
          <button class="btn sec" type="button" id="ps-send-cancel">Cancel</button>
        </form>
      </div>` : ""}
      <div class="card">
        <h2>All Payslip Requests (${pending.length} pending)</h2>
        <p class="mute">Click Execute on a single request to upload and send that employee's payslip.</p>
        ${table([
          ["#", r => r.id],
          ["Employee", r => `<b>${esc(r.name)}</b><br><small class="mute">${esc(r.emp_no)} · ${esc(r.designation || "")} · ${esc(r.department || "")}</small>`, 1],
          ["Month", r => esc(r.month)],
          ["Requested", r => fdate(r.created_at)],
          ["Status", r => badge(r.status), 1],
          ["Action", r => r.status === "sent" ? `<span class="mute">Sent</span>` : `<button class="btn sm" data-psx="${r.id}">Execute</button>`, 1]
        ], rows, "No payslip requests.")}
      </div>`;
    el.querySelectorAll("[data-psx]").forEach(b => b.onclick = () => {
      activeId = +b.dataset.psx;
      draw();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    const cancel = $("#ps-send-cancel");
    if (cancel) cancel.onclick = () => { activeId = null; draw(); };
    const form = $("#ps-send");
    if (form) form.onsubmit = async e => {
      e.preventDefault();
      const errEl = $("#ps-send-err"); errEl.textContent = "";
      const fd = new FormData(form);
      const file = fd.get("file");
      if (!file || !file.name) { errEl.textContent = "Please attach the payslip file."; return; }
      try {
        const res = await fetch("/api/payslip-requests/" + form.dataset.id + "/send", { method: "POST", body: fd, credentials: "same-origin" });
        if (!res.ok) { let m = "Upload failed"; try { m = (await res.json()).error || m; } catch { } throw new Error(m); }
        toast("Payslip sent to " + (active ? active.name : "employee"));
        activeId = null;
        draw();
      } catch (er) { errEl.textContent = er.message; }
    };
  };
  await draw();
};
// Leave pages (Leave Apply, Leave Balances, Leave Calendar, Holiday Calendar) live in pages-leave.js
const thisMonth = () => new Date().toISOString().slice(0, 7);   // used by the HR Admin attendance tabs


// Attendance pages (Attendance Info, My Regularizations, Regularization & Permission) live in pages-attendance.js


// ---- docs / people / hub
// Document Center lives in pages-docs.js, People and Org Chart in pages-people.js


P["request-hub"] = async el => {
  const h = await api("request-hub");
  el.innerHTML = `<h1>Request Hub</h1><div class="card">${table([["Type", r => r.type], ["Details", r => r.summary], ["Status", r => badge(r.status), 1], ["Raised", r => fdate(r.created_at)]], h)}</div>`;
};

// ---------------- shell ----------------
// Sidebar mirrors the original: leaf items and collapsible groups. [route,label,icon] or [label,icon,[children]]
const NAV = [["home", "Home", "home"], ["engage", "Engage", "engage"],
  ["My Worklife", "worklife", [["kudos", "Kudos"], ["feedback", "Feedback"]]],
  ["To do", "todo", [["tasks", "Tasks"], ["review", "Review"]]],
  ["Salary", "salary", [["payslips", "Payslips"], ["ytd", "YTD Reports"], ["it-statement", "IT Statement"], ["it-declaration", "IT Declaration"], ["loans", "Loans and Advances"], ["reimbursement", "Reimbursement"], ["poi", "Proof Of Investment"], ["salary-revision", "Salary Revision"]]],
  ["Leave", "leave", [["leave-apply", "Leave Apply"], ["leave-balances", "Leave Balances"], ["leave-calendar", "Leave Calendar"], ["holidays", "Holiday Calendar"]]],
  ["Attendance", "attendance", [["attendance", "Attendance Info"], ["regularization", "Regularization & Permission"]]],
  ["documents", "Document Center", "docs"], ["people", "People", "people"], ["helpdesk", "Helpdesk", "help"], ["request-hub", "Request Hub", "hub"], ["delegates", "Workflow Delegates", "deleg"]];
const openGroups = new Set();

// Thin line icons (24x24) for the sidebar and header
const ICONS = {
  home: '<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"/>',
  engage: '<circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a5.9 5.9 0 0 0 0 8.4M16.2 7.8a5.9 5.9 0 0 1 0 8.4M5 5a9.9 9.9 0 0 0 0 14M19 5a9.9 9.9 0 0 1 0 14"/>',
  worklife: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  todo: '<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M9 12h6M9 16h4"/>',
  salary: '<path d="M3 15c3 1 5 2 8 2h3a2 2 0 0 0 0-4h-3"/><path d="M3 12l5-1 4 1M12 13l5-2 4 2-6 6-8-1"/><circle cx="15" cy="6" r="2.5"/>',
  leave: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  attendance: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 12l3 3 5-6"/>',
  docs: '<path d="M6 4h11a1 1 0 0 1 1 1v15H7a1 1 0 0 1-1-1z"/><path d="M6 19a1 1 0 0 1 1-1h11"/>',
  people: '<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19c.5-3.2 2.8-5 5.5-5s5 1.8 5.5 5"/><path d="M16 6.5a3 3 0 0 1 0 5.5M18.5 14.5c1.7.6 2.6 2 3 4.5"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  hub: '<path d="M12 4l9 5-9 5-9-5z"/><path d="M3 14l9 5 9-5"/>',
  deleg: '<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="12" r="2"/><path d="M7 8v8M9 12h6"/>',
  suite: '<path d="M3 10l9-6 9 6zM5 10v9M9.5 10v9M14.5 10v9M19 10v9M3 20h18"/>',
  admin: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  accounts: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16M8 15h3"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  power: '<path d="M12 3v8"/><path d="M7 6.3a7.5 7.5 0 1 0 10 0"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
};
const icon = (k, cls = "ico") => ICONS[k] ? `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>` : esc(k || "");

// Page titles for the header; the colour of the little tab shape follows the sidebar section.
const TITLES = { home: "Home", engage: "Engage", kudos: "Kudos", feedback: "Feedback", tasks: "Tasks", review: "Review", payslips: "Payslips", ytd: "YTD Reports", "it-statement": "IT Statement", "it-declaration": "IT Declaration", loans: "Loans and Advances", reimbursement: "Reimbursement", poi: "Proof Of Investment", "salary-revision": "Salary Revision", "leave-apply": "Leave Apply", "leave-balances": "Leave Balances", "leave-calendar": "Leave Calendar", holidays: "Holiday Calendar", attendance: "Attendance Info", regularization: "Regularization & Permission", documents: "Document Center", people: "People", helpdesk: "Helpdesk", "request-hub": "Request Hub", delegates: "Workflow Delegates", "my-info": "My Info", executive: "Leadership Suite", admin: "HR Admin", accounts: "Accounts Admin" };
const ROUTE_ALIAS = { "my-regularizations": "attendance" };
TITLES["my-regularizations"] = "My Regularizations";
const CRUMB_COLOR = { home: "#c4b5fd", engage: "#fdba9b", kudos: "#5ed3d1", feedback: "#5ed3d1", tasks: "#86d9a0", review: "#86d9a0", "leave-apply": "#5fd1d8", "leave-balances": "#5fd1d8", "leave-calendar": "#5fd1d8", holidays: "#5fd1d8", attendance: "#c4b5fd", regularization: "#c4b5fd", documents: "#f0a8d8", people: "#c4b5fd" };
const QUICK_LINKS = [["#/payslips", "Payslips"], ["#/leave-apply", "Apply Leave"], ["#/attendance", "Attendance Info"], ["#/regularization", "Regularization"], ["#/holidays", "Holiday Calendar"], ["#/documents", "Document Center"], ["#/people", "People Directory"], ["#/helpdesk", "Raise a Ticket"]];
// Pages can replace the header trail, e.g. setCrumb(["Attendance Info", "My Regularizations"])
function setCrumb(parts) {
  const el = $("#crumb"); if (!el) return;
  el.innerHTML = parts.map((p, i) => i === parts.length - 1 ? `<b>${esc(p)}</b>` : `<span>${esc(p)}</span><i>/</i>`).join("");
}

P["my-info"] = async el => {
  const m = ME;
  el.innerHTML = `<h1>My Info</h1><div class="card"><div style="display:flex;gap:16px;align-items:center"><span class="avatar big">${esc(m.name[0])}</span><div><h2 style="margin:0">${esc(m.name)}</h2><span class="mute">${esc(m.designation)} · ${esc(m.department)}</span></div></div></div>
  <div class="card grid">${[["Employee ID", m.emp_no], ["Email", m.email], ["Location", m.location], ["Joined", fdate(m.join_date)], ["Reports to", m.manager_name || "-"], ["Shift", m.shift], ["Skills", m.skills]].map(([k, v]) => `<div><span class="mute">${esc(k)}</span><div>${esc(v)}</div></div>`).join("")}</div>
  <div class="card"><h2>Other</h2><a href="#/resignation">Resignation</a></div>`;
};
P.delegates = async el => {
  const draw = async () => {
    const [d, ppl] = await Promise.all([api("delegates"), peopleOpts()]);
    el.innerHTML = `<h1>Workflow Delegates</h1><p class="mute">Let a colleague approve requests on your behalf while you are away.</p>
    <div class="card">${form("df", [{ n: "to_id", label: "Delegate to", type: "select", opts: ppl }, { n: "from_date", label: "From", type: "date" }, { n: "to_date", label: "To", type: "date" }], "Delegate")}</div>
    <div class="card"><h2>Delegated by me</h2>${table([["To", r => r.to_name], ["From", r => fdate(r.from_date)], ["To", r => fdate(r.to_date)], ["", r => `<button class="btn sec sm" data-del="${r.id}">Remove</button>`, 1]], d.given)}</div>
    <div class="card"><h2>Delegated to me</h2>${table([["From", r => r.from_name], ["Start", r => fdate(r.from_date)], ["End", r => fdate(r.to_date)]], d.received)}</div>`;
    wire("df", "delegates", draw, x => ({ ...x, to_id: +x.to_id }));
    el.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => { await api("delegates/" + b.dataset.del, "DELETE"); draw(); });
  };
  draw();
};

// ---- admin & executive control
P.executive = async el => {
  const isExec = EXEC_ROLES.includes(ME.role);
  if (!isExec) { el.innerHTML = '<div class="card err">Executive Suite is only accessible to CEO, COO, CPO, and Super Admin.</div>'; return; }
  if (ME.role === "superadmin") { el.innerHTML = `<h1>Superadmin Suite</h1><div class="grid"><a class="card" href="#/admin" onclick="render()" style="text-decoration:none;color:inherit"><h2>HR Admin</h2><p class="mute">Manage employees, attendance, leave, tickets, documents.</p></a><a class="card" href="#/accounts" onclick="render()" style="text-decoration:none;color:inherit"><h2>Accounts Admin</h2><p class="mute">Payslip requests and approvals.</p></a></div>`; return; }
  let tab = ME.role === "coo" ? 1 : ME.role === "cpo" ? 2 : 0;
  const NAMES = ["CEO Command Center", "COO Operations", "CPO & HR Governance", "Payroll & Financials", "Master Approvals"];

  const draw = async () => {
    const s = await api("executive/summary");
    const totReqs = s.pending_leaves.length + s.pending_regs.length + s.pending_reimbursements.length + s.pending_loans.length;
    let inner = "";

    if (tab === 0) {
      inner = `
      <div class="grid">
        <div class="card"><span class="mute">Company Headcount</span><div class="stat">${s.dept_stats.reduce((a, b) => a + b.active, 0)} <small class="mute" style="font-size:14px">/ ${s.dept_stats.reduce((a, b) => a + b.total, 0)} total</small></div></div>
        <div class="card"><span class="mute">Monthly Net Payroll</span><div class="stat">${inr(s.payroll.total_net)}</div><small class="mute">${esc(s.payroll.month || "-")}</small></div>
        <div class="card"><span class="mute">Attendance Today</span><div class="stat">${s.attendance_today.P || 0} Present</div><small class="mute">${s.attendance_today.A || 0} Absent · ${s.attendance_today.CL || 0} Leave</small></div>
        <div class="card"><span class="mute">Company-Wide Pending</span><div class="stat">${totReqs}</div><small class="mute">Leaves, regs, claims & loans</small></div>
        <div class="card"><span class="mute">Pending Resignations</span><div class="stat">${s.resignations.filter(r => r.status === 'pending').length}</div><small class="mute">Attrition alert</small></div>
      </div>
      <div class="card">
        <h2>Department Workforce & Leadership</h2>
        ${table([["Department", r => r.department], ["Total", r => r.total], ["Active", r => r.active], ["HR Team", r => r.hr_count], ["Managers", r => r.manager_count]], s.dept_stats)}
      </div>
      <div class="card">
        <h2>Resignations Watchlist</h2>
        ${table([["Employee", r => r.emp_name], ["Department", r => r.department], ["Designation", r => r.designation], ["Last Working Day", r => fdate(r.last_day)], ["Reason", r => r.reason], ["Status", r => badge(r.status), 1]], s.resignations, "No resignations submitted.")}
      </div>`;
    }

    if (tab === 1) {
      inner = `
      <div class="grid">
        <div class="card"><span class="mute">Workforce Locations</span><div class="stat">${s.locations.length}</div><small class="mute">Hubs & branches</small></div>
        <div class="card"><span class="mute">Today's Staff Present</span><div class="stat">${s.attendance_today.P || 0}</div><small class="mute">Punctuality tracked</small></div>
        <div class="card"><span class="mute">Open Tickets</span><div class="stat">${s.tickets.filter(t => t.status === 'open').reduce((a, b) => a + b.count, 0)}</div><small class="mute">Across IT/HR/Admin</small></div>
      </div>
      <div class="card">
        <h2>Workforce Distribution by Location</h2>
        ${table([["Location", r => r.location || "Remote/Unassigned"], ["Active Employees", r => r.count]], s.locations)}
      </div>
      <div class="card">
        <h2>Helpdesk & Support Operations</h2>
        ${table([["Category", r => r.category], ["Status", r => badge(r.status), 1], ["Count", r => r.count]], s.tickets, "No support tickets recorded.")}
      </div>`;
    }

    if (tab === 2) {
      inner = `
      <div class="card" style="border-left:4px solid var(--brand)">
        <h2>HR Team Direct Governance & Control</h2>
        <p class="mute">As Executive Leadership, you have direct authority over HR personnel. You can manage status, passwords, and assignments here.</p>
        ${table([
          ["Emp ID", r => r.emp_no],
          ["Name", r => `<b>${esc(r.name)}</b>`, 1],
          ["Email", r => r.email],
          ["Designation", r => r.designation],
          ["Reports To", r => r.manager_name || "—"],
          ["Status", r => badge(r.active ? "active" : "inactive"), 1],
          ["Governance Actions", r => `
            <button class="btn sec sm" data-hract="${r.id}" data-to="${r.active ? 0 : 1}">${r.active ? "Deactivate HR" : "Activate HR"}</button>
            <button class="btn sec sm" data-hrpw="${r.id}">Reset Password</button>
          `, 1]
        ], s.hr_team, "No HR team members configured.")}
      </div>
      <div class="card">
        <h2>Company Leave Liability Overview</h2>
        ${table([["Leave Code", r => r.code], ["Leave Name", r => r.name], ["Total Granted (Days)", r => r.total_granted], ["Total Consumed (Days)", r => r.total_consumed], ["Remaining Org Balance", r => (r.total_granted - r.total_consumed).toFixed(1)]], s.leave_overview)}
      </div>`;
    }

    if (tab === 3) {
      inner = `
      <div class="card">
        <h2>Latest Monthly Payroll Summary (${esc(s.payroll.month || "-")})</h2>
        <div class="grid">
          <div><span class="mute">Gross Basic</span><div class="stat">${inr(s.payroll.total_basic)}</div></div>
          <div><span class="mute">Total HRA</span><div class="stat">${inr(s.payroll.total_hra)}</div></div>
          <div><span class="mute">Allowances</span><div class="stat">${inr(s.payroll.total_allowances)}</div></div>
          <div><span class="mute">PF Deductions</span><div class="stat">${inr(s.payroll.total_pf)}</div></div>
          <div><span class="mute">Tax Deductions</span><div class="stat">${inr(s.payroll.total_tax)}</div></div>
          <div><span class="mute">Net Bank Payout</span><div class="stat" style="color:var(--brand)">${inr(s.payroll.total_net)}</div></div>
        </div>
      </div>
      <div class="card">
        <h2>Department-wise Payroll Distribution</h2>
        ${table([["Department", r => r.department], ["Employees Count", r => r.employee_count], ["Monthly Gross CTC", r => inr(r.gross_spend)], ["Monthly Net Payout", r => inr(r.net_payout)]], s.dept_payroll)}
      </div>
      <div class="grid">
        <div class="card">
          <h2>Pending Reimbursements (${s.pending_reimbursements.length})</h2>
          ${table([["Employee", r => r.emp_name], ["Dept", r => r.department], ["Category", r => r.category], ["Amount", r => inr(r.amount)], ["Bill Date", r => fdate(r.bill_date)]], s.pending_reimbursements, "No pending reimbursements.")}
        </div>
        <div class="card">
          <h2>Pending Loans & Advances (${s.pending_loans.length})</h2>
          ${table([["Employee", r => r.emp_name], ["Dept", r => r.department], ["Amount", r => inr(r.amount)], ["Tenure", r => `${r.tenure_months} mo`], ["Reason", r => r.reason]], s.pending_loans, "No pending loans.")}
        </div>
      </div>`;
    }

    if (tab === 4) {
      const allPending = [
        ...s.pending_leaves.map(x => ({ ...x, _t: "request", _kind: `Leave (${x.code})`, _dt: `${x.from_date}→${x.to_date} (${x.days}d): ${x.reason || ""}` })),
        ...s.pending_regs.map(x => ({ ...x, _t: "regularization", _kind: `Regularize (${x.kind})`, _dt: `${x.date} ${x.in_time || ""}-${x.out_time || ""}: ${x.reason || ""}` })),
        ...s.pending_reimbursements.map(x => ({ ...x, _t: "reimbursement", _kind: `Claim: ${x.category}`, _dt: `${inr(x.amount)} (Bill: ${fdate(x.bill_date)})` })),
        ...s.pending_loans.map(x => ({ ...x, _t: "loan", _kind: `Loan Request`, _dt: `${inr(x.amount)} for ${x.tenure_months} mo - ${x.reason || ""}` }))
      ];
      inner = `
      <div class="card">
        <h2>Master Approvals Override</h2>
        <p class="mute">As CEO/COO/CPO, you have master authority to approve or reject any pending request company-wide, including requests submitted by HR.</p>
        ${table([
          ["Employee", r => `<b>${esc(r.emp_name)}</b> <span class="badge ${esc(r.emp_role || "")}">${esc(titleCase(r.emp_role))}</span>`, 1],
          ["Department", r => r.department],
          ["Request Type", r => r._kind],
          ["Details", r => r._dt],
          ["Action", r => r.emp_id === ME.id ? `<span class="mute">Self (Cannot approve)</span>` : `
            <button class="btn sm" data-mdec="approve" data-t="${r._t}" data-i="${r.id}">Approve</button>
            <button class="btn bad sm" data-mdec="reject" data-t="${r._t}" data-i="${r.id}">Reject</button>
          `, 1]
        ], allPending, "No pending requests requiring approval.")}
      </div>`;
    }

    el.innerHTML = `<h1>${esc(ME.role.toUpperCase())} Leadership Suite</h1>${tabs(NAMES, tab)}${inner}`;
    wireTabs(i => { tab = i; draw(); });

    el.querySelectorAll("[data-hract]").forEach(b => b.onclick = async () => {
      try {
        await api("admin/employees/" + b.dataset.hract, "PATCH", { active: b.dataset.to === "1" });
        toast("HR status updated"); draw();
      } catch (e) { toast(e.message); }
    });

    el.querySelectorAll("[data-hrpw]").forEach(b => b.onclick = async () => {
      const pw = prompt("New password for this HR employee (min 8 characters):");
      if (!pw) return;
      try {
        await api(`admin/employees/${b.dataset.hrpw}/password`, "POST", { password: pw });
        toast("HR password reset successfully");
      } catch (e) { toast(e.message); }
    });

    el.querySelectorAll("[data-mdec]").forEach(b => b.onclick = async () => {
      try {
        await api(`review/${b.dataset.t}/${b.dataset.i}`, "POST", { action: b.dataset.mdec });
        toast("Decision recorded"); refreshMe(); draw();
      } catch (e) { toast(e.message); }
    });
  };

  draw();
};

P.admin = async el => {
  const ADMINS = ADMIN_ROLES;
  if (!ADMINS.includes(ME.role)) { el.innerHTML = '<div class="card err">Admin is only available to HR and Executive Leadership.</div>'; return; }
  let tab = 0;
  const NAMES = ["📊 Overview", "👥 Employees", "🕒 Attendance", "✅ Leave Approvals", "📅 Casual Leave (CL)", "🎉 Holidays", "🎫 Tickets", "📄 Documents", "📧 Email Outbox", "📋 Attendance Overview"];
  const draw = async () => {
    let inner = "";
    if (tab === 0) {
      const s = await api("admin/summary");
      inner = `<div class="grid">${[["Active employees", s.employees], ["Inactive", s.inactive], ["On leave today", s.on_leave_today], ["Pending requests", s.pending_requests], ["Open tickets", s.open_tickets], ["Pending resignations", s.pending_resignations]].map(([k, v]) => `<div class="card"><span class="mute">${k}</span><div class="stat">${v}</div></div>`).join("")}</div><div class="card"><h2>Department-wise</h2><div class="grid">${(s.dept_counts||[]).map(d=>`<div><span class="mute">${esc(d.department||"Unassigned")}</span><div class="stat">${d.c}</div></div>`).join("")}</div></div>`;
    }
    if (tab === 1) {
      const [emps, desig] = await Promise.all([api("admin/employees"), api("designations")]);
      const mgr = [["", "— None —"], ...emps.filter(e => e.active).map(e => [e.id, e.name])];
      const isExec = EXEC_ROLES.includes(ME.role);
      const roleChoices = isExec
        ? [["employee", "Employee"], ["manager", "Manager"], ["hr", "HR"], ["admin", "Admin"], ["executive", "Executive"], ["cpo", "CPO"], ["coo", "COO"], ["ceo", "CEO"]]
        : [["employee", "Employee"], ["manager", "Manager"], ["hr", "HR"]];
      // Grouped dropdown options: department (or department — sub-group)
      const desigOptGroups = desig.groups.flatMap(d => d.groups.map(g => ({
        name: d.groups.length > 1 ? `${d.department} — ${g.name}` : d.department,
        items: g.items
      })));
      const deptByDesig = {};
      desig.groups.forEach(d => d.groups.forEach(g => g.items.forEach(x => { deptByDesig[x] = d.department; })));
      const editing = draw._editDesig ? emps.find(e => e.id === draw._editDesig) : null;
      const view = draw._empView || "list";
      const editId = draw._empEditId ? +draw._empEditId : null;
      const editingEmp = editId ? emps.find(e => e.id === editId) : null;
      const viewBar = `<div class="card" style="padding:10px 14px">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button class="btn ${view === "list" ? "" : "sec"}" data-empview="list">📋 Employee List (${emps.length})</button>
          <button class="btn ${view === "add" ? "" : "sec"}" data-empview="add">➕ Add New Employee</button>
          <button class="btn ${view === "edit" ? "" : "sec"}" data-empview="edit">✏️ Edit Employee</button>
        </div>
      </div>`;
      const empPicker = `<div style="max-width:480px;margin-bottom:6px">
        <label for="emp-edit-pick">Select employee to edit</label>
        <select id="emp-edit-pick">
          <option value="">— Select Employee —</option>
          ${emps.map(e => `<option value="${e.id}" ${e.id === editId ? "selected" : ""}>${esc(e.emp_no)} — ${esc(e.name)} (${esc(e.designation || "-")})</option>`).join("")}
        </select>
      </div>`;
      const shiftOpts = [["11:00-20:00", "11:00-20:00"], ["09:00-18:00", "09:00-18:00"], ["10:00-19:00", "10:00-19:00"], ["Flexible", "Flexible"]];
      const addFields = [
        { type: "section", label: "Account & Work Details" },
        { n: "name", label: "Full name" },
        { n: "email", label: "Official Work Email", type: "email", placeholder: "name@3wheels.ai" },
        { n: "password", label: "Temporary password (min 8)", type: "password" },
        { n: "role", label: "Role", type: "select", opts: [["", "— Select Role —"], ...roleChoices] },
        { n: "department", label: "Department", type: "select", opts: [["", "— Select Department —"], ...desig.departments.map(d => [d, d])] },
        { n: "designation", label: "Designation (Job Title)", type: "select", opts: [["", "— Select Designation —"]], groups: desigOptGroups },
        { n: "location", label: "Location / Branch", req: false },
        { n: "manager_id", label: "Reports to (Manager)", type: "select", opts: [["", "— Select Manager —"], ...mgr], req: false },
        { n: "join_date", label: "Joining date", type: "date" },
        { n: "employment_type", label: "Employment type", type: "select", opts: [["Full-time", "Full-time"], ["Part-time", "Part-time"], ["Contract", "Contract"], ["Intern", "Intern"], ["Consultant", "Consultant"]], req: false },
        { n: "work_mode", label: "Work mode", type: "select", opts: [["On-site", "On-site"], ["Remote", "Remote"], ["Hybrid", "Hybrid"]], req: false },
        { n: "shift", label: "Shift", type: "select", opts: shiftOpts, req: false },

        { type: "section", label: "Personal Details" },
        { n: "personal_email", label: "Personal email", type: "email", req: false },
        { n: "phone", label: "Mobile number", type: "tel", req: false },
        { n: "alternate_phone", label: "Alternate phone", type: "tel", req: false },
        { n: "dob", label: "Date of birth", type: "date", req: false },
        { n: "gender", label: "Gender", type: "select", opts: [["", "— Select —"], ["Male", "Male"], ["Female", "Female"], ["Other", "Other"], ["Prefer not to say", "Prefer not to say"]], req: false },
        { n: "marital_status", label: "Marital status", type: "select", opts: [["", "— Select —"], ["Single", "Single"], ["Married", "Married"], ["Divorced", "Divorced"], ["Widowed", "Widowed"], ["Prefer not to say", "Prefer not to say"]], req: false },
        { n: "blood_group", label: "Blood group", type: "select", opts: [["", "— Select —"], ["A+", "A+"], ["A-", "A-"], ["B+", "B+"], ["B-", "B-"], ["AB+", "AB+"], ["AB-", "AB-"], ["O+", "O+"], ["O-", "O-"], ["Unknown", "Unknown"]], req: false },
        { n: "nationality", label: "Nationality", value: "Indian", req: false },
        { n: "father_name", label: "Father's name", req: false },
        { n: "mother_name", label: "Mother's name", req: false },

        { type: "section", label: "Address & Emergency Contact" },
        { n: "current_address", label: "Current address", type: "textarea", req: false },
        { n: "permanent_address", label: "Permanent address", type: "textarea", req: false },
        { n: "emergency_contact_name", label: "Emergency contact name", req: false },
        { n: "emergency_contact_phone", label: "Emergency contact number", type: "tel", req: false },
        { n: "emergency_contact_relation", label: "Relationship", type: "select", opts: [["", "— Select —"], ["Father", "Father"], ["Mother", "Mother"], ["Spouse", "Spouse"], ["Sibling", "Sibling"], ["Friend", "Friend"], ["Other", "Other"]], req: false },

        { type: "section", label: "Statutory & Bank Details" },
        { n: "aadhaar_no", label: "Aadhaar number", req: false },
        { n: "pan_no", label: "PAN number", req: false },
        { n: "uan_no", label: "UAN / PF number", req: false },
        { n: "esi_no", label: "ESI number", req: false },
        { n: "bank_name", label: "Bank name", req: false },
        { n: "bank_account_no", label: "Bank account number", req: false },
        { n: "ifsc_code", label: "IFSC code", req: false },
        { n: "branch_name", label: "Branch name", req: false },

        { type: "section", label: "Education & Experience" },
        { n: "qualification", label: "Highest qualification", req: false },
        { n: "previous_company", label: "Previous company", req: false },
        { n: "previous_experience", label: "Previous experience (e.g. 3 years)", req: false }
      ];
      const ev = editingEmp || {};
      // Keep the employee's current manager selectable even if that manager has since
      // been deactivated — otherwise the dropdown silently drops their real reporting manager.
      let mgrForEdit = mgr;
      if (ev.manager_id && !mgr.some(([id]) => id === ev.manager_id)) {
        const currentMgr = emps.find(e => e.id === ev.manager_id);
        if (currentMgr) mgrForEdit = [...mgr, [currentMgr.id, `${currentMgr.name} (Inactive)`]];
      }
      const editFields = [
        { type: "section", label: "Account & Work Details" },
        { n: "emp_no", label: "Employee code", value: ev.emp_no, placeholder: "e.g. 3WAI00001" },
        { n: "name", label: "Full name", value: ev.name },
        { n: "email", label: "Official work email (read-only)", type: "email", value: ev.email, readonly: true, req: false },
        { n: "role", label: "Role", type: "select", opts: roleChoices, value: ev.role },
        { n: "department", label: "Department", type: "select", opts: desig.departments.map(d => [d, d]), value: ev.department },
        { n: "designation", label: "Designation (Job Title)", type: "select", groups: desigOptGroups, value: ev.designation },
        { n: "location", label: "Location / Branch", value: ev.location, req: false },
        { n: "manager_id", label: "Reports to (Manager)", type: "select", opts: mgrForEdit, value: ev.manager_id, req: false },
        { n: "join_date", label: "Joining date", type: "date", value: ev.join_date, req: false },
        { n: "employment_type", label: "Employment type", type: "select", opts: [["", "— Select —"], ["Full-time", "Full-time"], ["Part-time", "Part-time"], ["Contract", "Contract"], ["Intern", "Intern"], ["Consultant", "Consultant"]], value: ev.employment_type, req: false },
        { n: "work_mode", label: "Work mode", type: "select", opts: [["", "— Select —"], ["On-site", "On-site"], ["Remote", "Remote"], ["Hybrid", "Hybrid"]], value: ev.work_mode, req: false },
        { n: "shift", label: "Shift", type: "select", opts: shiftOpts, value: ev.shift, req: false },

        { type: "section", label: "Personal Details" },
        { n: "personal_email", label: "Personal email", type: "email", value: ev.personal_email, req: false },
        { n: "phone", label: "Mobile number", type: "tel", value: ev.phone, req: false },
        { n: "alternate_phone", label: "Alternate phone", type: "tel", value: ev.alternate_phone, req: false },
        { n: "dob", label: "Date of birth", type: "date", value: ev.dob, req: false },
        { n: "gender", label: "Gender", type: "select", opts: [["", "— Select —"], ["Male", "Male"], ["Female", "Female"], ["Other", "Other"], ["Prefer not to say", "Prefer not to say"]], value: ev.gender, req: false },
        { n: "marital_status", label: "Marital status", type: "select", opts: [["", "— Select —"], ["Single", "Single"], ["Married", "Married"], ["Divorced", "Divorced"], ["Widowed", "Widowed"], ["Prefer not to say", "Prefer not to say"]], value: ev.marital_status, req: false },
        { n: "blood_group", label: "Blood group", type: "select", opts: [["", "— Select —"], ["A+", "A+"], ["A-", "A-"], ["B+", "B+"], ["B-", "B-"], ["AB+", "AB+"], ["AB-", "AB-"], ["O+", "O+"], ["O-", "O-"], ["Unknown", "Unknown"]], value: ev.blood_group, req: false },
        { n: "nationality", label: "Nationality", value: ev.nationality, req: false },
        { n: "father_name", label: "Father's name", value: ev.father_name, req: false },
        { n: "mother_name", label: "Mother's name", value: ev.mother_name, req: false },

        { type: "section", label: "Address & Emergency Contact" },
        { n: "current_address", label: "Current address", type: "textarea", value: ev.current_address, req: false },
        { n: "permanent_address", label: "Permanent address", type: "textarea", value: ev.permanent_address, req: false },
        { n: "emergency_contact_name", label: "Emergency contact name", value: ev.emergency_contact_name, req: false },
        { n: "emergency_contact_phone", label: "Emergency contact number", type: "tel", value: ev.emergency_contact_phone, req: false },
        { n: "emergency_contact_relation", label: "Relationship", type: "select", opts: [["", "— Select —"], ["Father", "Father"], ["Mother", "Mother"], ["Spouse", "Spouse"], ["Sibling", "Sibling"], ["Friend", "Friend"], ["Other", "Other"]], value: ev.emergency_contact_relation, req: false },

        { type: "section", label: "Statutory & Bank Details" },
        { n: "aadhaar_no", label: "Aadhaar number", value: ev.aadhaar_no, req: false },
        { n: "pan_no", label: "PAN number", value: ev.pan_no, req: false },
        { n: "uan_no", label: "UAN / PF number", value: ev.uan_no, req: false },
        { n: "esi_no", label: "ESI number", value: ev.esi_no, req: false },
        { n: "bank_name", label: "Bank name", value: ev.bank_name, req: false },
        { n: "bank_account_no", label: "Bank account number", value: ev.bank_account_no, req: false },
        { n: "ifsc_code", label: "IFSC code", value: ev.ifsc_code, req: false },
        { n: "branch_name", label: "Branch name", value: ev.branch_name, req: false },

        { type: "section", label: "Education & Experience" },
        { n: "qualification", label: "Highest qualification", value: ev.qualification, req: false },
        { n: "previous_company", label: "Previous company", value: ev.previous_company, req: false },
        { n: "previous_experience", label: "Previous experience (e.g. 3 years)", value: ev.previous_experience, req: false }
      ];
      let body = "";
      if (view === "add") {
        body = `<div class="card">
          <h2>➕ Add New Employee</h2>
          <p class="mute">HR & Executives can onboard new members. When submitted, an official welcome email with login ID and temporary password will be dispatched to their official email.</p>
          ${form("ae", addFields, "Add member & Dispatch Email")}
        </div>`;
      } else if (view === "edit") {
        body = `<div class="card">
          <h2>✏️ Edit Employee${editingEmp ? ` — ${esc(editingEmp.name)} (${esc(editingEmp.emp_no)})` : ""}</h2>
          <p class="mute">Select an employee, update their profile details, then save. Email address (login ID) cannot be changed here.</p>
          ${empPicker}
          ${editingEmp ? form("ee", editFields, "Save Changes") : `<p class="mute">No employee selected yet.</p>`}
        </div>`;
      } else {
        body = `${editing ? `<div class="card" style="border-left:4px solid var(--brand)">
          <h2>Update Designation — ${esc(editing.name)}</h2>
          <p class="mute">Current designation: <b>${esc(editing.designation || "—")}</b></p>
          <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
            <div><label for="edit-desig-sel">New designation</label>
              <select id="edit-desig-sel" data-ddl style="min-width:320px">
                ${editing.designation && !desig.flat.includes(editing.designation) ? `<option selected value="${esc(editing.designation)}">${esc(editing.designation)} (current)</option>` : ""}
                ${desigOptGroups.map(g => `<optgroup label="${esc(g.name)}">${g.items.map(d => `<option ${d === editing.designation ? "selected" : ""}>${esc(d)}</option>`).join("")}</optgroup>`).join("")}
              </select>
            </div>
            <button class="btn" id="edit-desig-save">Save Designation</button>
            <button class="btn sec" id="edit-desig-cancel">Cancel</button>
          </div>
        </div>` : ""}
        <div class="card">
          <h2>📋 Employee List</h2>
          ${table([
            ["ID", r => r.emp_no],
            ["Name", r => `<b>${esc(r.name)}</b>`, 1],
            ["Designation", r => esc(r.designation || "-")],
            ["Dept", r => r.department],
            ["Role", r => badge(r.role), 1],
            ["Reports to", r => r.manager_name || "-"],
            ["Status", r => badge(r.active ? "active" : "inactive"), 1],
            ["Actions", r => {
              if (!isExec && EXEC_ROLES.includes(r.role)) return `<span class="badge ceo">Leadership</span>`;
              const editBtn = `<button class="btn sm" data-empedit="${r.id}">Edit</button>`;
              if (r.id === ME.id) return `${editBtn} <span class="mute">Current User</span>`;
              return `
                ${editBtn}
                <button class="btn sec sm" data-desig="${r.id}" title="Change Designation">Edit Title</button>
                <button class="btn sec sm" data-act="${r.id}" data-to="${r.active ? 0 : 1}">${r.active ? "Deactivate" : "Activate"}</button>
                <button class="btn sec sm" data-pw="${r.id}">Reset password</button>
              `;
            }, 1]
          ], emps)}
        </div>`;
      }
      inner = viewBar + body;
      // Stored for the post-render wiring below.
      draw._desigDeptMap = deptByDesig;
      draw._editingEmp = editing;
    }
    if (tab === 2) {
      const emps = await api("admin/employees");
      const activeEmps = emps.filter(e => e.active);
      const todayIso = new Date().toISOString().slice(0, 10);
      const attRecords = await api("admin/attendance?month=" + thisMonth());
      inner = `
      <div class="card" style="border-left:4px solid #1d6f42">
        <h2>📥 Download Attendance Excel — All Employees</h2>
        <p class="mute">Select a month and download one workbook containing the monthly summary, every employee's day-by-day attendance, and a separate sheet per employee.</p>
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
          <div><label for="att-xls-month">Month</label><input id="att-xls-month" type="month" value="${thisMonth()}" style="max-width:200px"></div>
          <button class="btn" id="att-xls-btn" style="background:#1d6f42;color:#fff;border-color:#1d6f42">📥 Download Excel</button>
        </div>
      </div>
      <div class="card" style="border-left:4px solid var(--brand)">
        <h2>Record / Update Employee Attendance</h2>
        <p class="mute">HR has authority to mark or adjust attendance for any employee (present, absent, half-day, on-leave) with check-in and check-out times.</p>
        ${form("atf", [
          { n: "emp_id", label: "Select Employee", type: "select", opts: activeEmps.map(e => [e.id, `${e.name} (${e.emp_no}) - ${e.designation}`]) },
          { n: "date", label: "Attendance Date", type: "date", value: todayIso },
          { n: "status", label: "Attendance Status", type: "select", opts: [
            ["P", "P — Present (Working)"],
            ["A", "A — Absent"],
            ["CL", "CL — Casual Leave"],
            ["CO", "CO — Compensatory Off"],
            ["LOP", "LOP — Loss of Pay"],
            ["H", "H — Public Holiday"],
            ["O", "O — Weekly Off / Weekend"]
          ]},
          { n: "first_in", label: "In Time (e.g. 10:00)", type: "time", req: false },
          { n: "last_out", label: "Out Time (e.g. 19:00)", type: "time", req: false }
        ], "Save Attendance")}
      </div>
      <div class="card">
        <h2>Attendance Sheet (${thisMonth()})</h2>
        ${table([
          ["Emp ID", r => r.emp_no],
          ["Employee", r => `<b>${esc(r.emp_name)}</b><br><small class="mute">${esc(r.designation || "")}</small>`, 1],
          ["Date", r => fdate(r.date)],
          ["Status", r => badge(r.status), 1],
          ["In Time", r => r.first_in || "-"],
          ["Out Time", r => r.last_out || "-"],
          ["Quick HR Actions", r => `
            <button class="btn sec sm" data-quickatt="${r.emp_id}" data-date="${r.date}" data-st="P">Mark P</button>
            <button class="btn sec sm" data-quickatt="${r.emp_id}" data-date="${r.date}" data-st="A">Mark A</button>
          `, 1]
        ], attRecords, "No attendance entries found for this month.")}
      </div>`;
    }
    if (tab === 3) {
      const reqs = await api("admin/requests");
      const allLeaves = [
        ...reqs.leaves.map(x => ({ ...x, _t: "request", _kind: `${x.code} Leave`, _dt: `${fdate(x.from_date)}→${fdate(x.to_date)} (${x.days} day(s))` })),
        ...reqs.regularizations.map(x => ({ ...x, _t: "regularization", _kind: `Regularize (${x.kind})`, _dt: `${fdate(x.date)} (${x.in_time || ""}-${x.out_time || ""})` }))
      ];
      const allHistory = [
        ...(reqs.history || []).map(x => ({ ...x, _kind: `${x.code} Leave`, _dt: `${fdate(x.from_date)}→${fdate(x.to_date)} (${x.days}d)` })),
        ...(reqs.reg_history || []).map(x => ({ ...x, _kind: `Regularize (${x.kind})`, _dt: fdate(x.date) }))
      ];
      inner = `
      <div class="card" style="border-left:4px solid var(--brand)">
        <h2>Pending Employee Leave & Regularization Approvals</h2>
        <p class="mute">HR administrative access to review, approve, or reject employee leave requests across all departments.</p>
        ${table([
          ["Employee", r => `<b>${esc(r.emp_name)}</b> <span class="badge ${esc(r.emp_role || "")}">${esc(titleCase(r.emp_role))}</span><br><small class="mute">${esc(r.designation || "")} · ${esc(r.department || "")}</small>`, 1],
          ["Request Type", r => `<b>${esc(r._kind)}</b>`, 1],
          ["Dates / Timing", r => r._dt],
          ["Reason", r => esc(r.reason || "-")],
          ["HR Action", r => `
            <button class="btn sm" data-hrappr="${r.id}" data-t="${r._t}" data-a="approve">Approve Leave</button>
            <button class="btn bad sm" data-hrappr="${r.id}" data-t="${r._t}" data-a="reject">Reject</button>
          `, 1]
        ], allLeaves, "No pending employee leave or regularization requests.")}
      </div>
      <div class="card">
        <h2>Manager Decisions Log (Approved & Rejected Leaves)</h2>
        <p class="mute">Real-time log of leaves and requests decided by Managers / Team Leads across the company.</p>
        ${table([
          ["Employee", r => `<b>${esc(r.emp_name)}</b><br><small class="mute">${esc(r.designation || "")} · ${esc(r.department || "")}</small>`, 1],
          ["Request", r => r._kind],
          ["Dates / Timing", r => r._dt],
          ["Decision", r => badge(r.status), 1],
          ["Decided By (Manager/TL)", r => r.decider_name ? `<b>${esc(r.decider_name)}</b> <span class="badge ${esc(r.decider_role || "")}">${esc(titleCase(r.decider_role))}</span><br><small class="mute">${esc(r.decider_designation || "")}</small>` : '<span class="mute">System / Direct</span>', 1],
          ["Decided At", r => fdate(r.decided_at)]
        ], allHistory, "No manager decision records yet.")}
      </div>`;
    }
    if (tab === 4) {
      const [clList, emps] = await Promise.all([api("admin/leave-balances?code=CL"), api("admin/employees")]);
      const clEditId = draw._clEdit ? +draw._clEdit : null;
      const clEdit = clEditId ? clList.find(x => x.emp_id === clEditId) : null;
      draw._clList = clList;
      inner = `
      <div class="card" style="border-left:4px solid var(--brand)">
        <h2>Casual Leave (CL) Management</h2>
        <p class="mute">Add or remove Casual Leaves for any member. Any adjustment made here is instantly visible to all members across the portal.</p>
        ${form("gl", [
          { n: "emp_id", label: "Select Employee", type: "select", opts: [["", "— Select Employee —"], ...clList.map(e => [e.emp_id, `${e.name} (${e.emp_no}) — Current CL: ${e.balance} days`])] },
          { n: "code", label: "Leave Type", type: "select", opts: [["", "— Select Leave Type —"], ["CL", "Casual Leave (CL)"], ["CO", "Comp Off (CO)"]] },
          { n: "days", label: "Days to Add (+) or Remove (-)", type: "number", step: "0.5", value: "1" }
        ], "Update Casual Leave Balance")}
      </div>
      <div class="card" style="border-left:4px solid #1565c0">
        <h2>✏️ Edit Casual Leave for One Employee</h2>
        <p class="mute">Set the exact total CL grant for a member — useful for correcting a wrong value.</p>
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
          <div><label for="cl-edit-emp">Employee</label>
            <select id="cl-edit-emp" style="min-width:340px">
              <option value="">— Select Employee —</option>
              ${clList.map(e => `<option value="${e.emp_id}" ${e.emp_id === clEditId ? "selected" : ""}>${esc(e.name)} (${esc(e.emp_no)}) — Current CL: ${e.balance} days</option>`).join("")}
            </select>
          </div>
          <div><label for="cl-edit-val">New total CL granted</label>
            <input id="cl-edit-val" type="number" step="0.5" min="0" max="365" style="max-width:170px" value="${clEdit ? clEdit.granted : ""}" placeholder="e.g. 16">
          </div>
          <span id="cl-edit-hint" class="mute" style="padding-bottom:9px">${clEdit ? `Granted ${clEdit.granted} · Consumed ${clEdit.consumed} · Balance ${clEdit.balance} days` : "Select an employee first"}</span>
          <button class="btn" id="cl-edit-save">Save CL</button>
        </div>
      </div>
      <div class="card" style="border-left:4px solid #1d6f42">
        <h2>👥 Same Casual Leave for All Employees</h2>
        <p class="mute">Give the same CL value to every active employee in one click.</p>
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
          <div><label for="cl-bulk-mode">Action</label>
            <select id="cl-bulk-mode" style="min-width:240px">
              <option value="">— Select Action —</option>
              <option value="set">Set exact CL for everyone</option>
              <option value="add">Add days to everyone</option>
            </select>
          </div>
          <div><label for="cl-bulk-days">CL days</label>
            <input id="cl-bulk-days" type="number" step="0.5" min="0" max="365" style="max-width:170px" value="0" placeholder="e.g. 16">
          </div>
          <button class="btn" id="cl-bulk-apply" style="background:#1d6f42;color:#fff;border-color:#1d6f42">Apply to All Employees</button>
        </div>
      </div>
      <div class="card">
        <h2>Company-Wide Casual Leave (CL) Balances</h2>
        <p class="mute">Live status of Casual Leave granted, consumed, and remaining balance for each team member.</p>
        ${table([
          ["Emp ID", r => r.emp_no],
          ["Member", r => `<b>${esc(r.name)}</b>`, 1],
          ["Designation", r => r.designation],
          ["Department", r => r.department],
          ["CL Granted", r => `${r.granted} days`],
          ["CL Consumed", r => `${r.consumed} days`],
          ["Available CL Balance", r => `<span class="badge CL" style="font-weight:700;font-size:13px">${r.balance} CL available</span>`, 1],
          ["Edit", r => `<button class="btn sec sm" data-cledit="${r.emp_id}">Edit CL</button>`, 1]
        ], clList)}
      </div>`;
    }
    if (tab === 5) {
      const h = await api("holidays");
      inner = `<div class="card">${form("ah", [{ n: "date", label: "Date", type: "date" }, { n: "name", label: "Holiday name" }, { n: "restricted", label: "Type", type: "select", opts: [["0", "Public"], ["1", "Restricted (optional)"]] }], "Save holiday")}</div>
      <div class="card">${table([["Date", r => fdate(r.date)], ["Holiday", r => r.name], ["Type", r => r.restricted ? "Restricted" : "Public"], ["", r => `<button class="btn sec sm" data-hd="${esc(r.date)}">Delete</button>`, 1]], h)}</div>`;
    }
    if (tab === 6) {
      const t = await api("admin/tickets");
      inner = `<div class="card">${table([["#", r => r.id], ["Employee", r => r.emp_name], ["Category", r => r.category], ["Subject", r => r.subject], ["Details", r => r.body], ["Status", r => `<select data-tk="${r.id}" aria-label="Ticket status">${["open", "in_progress", "resolved", "closed"].map(x => `<option value="${x}" ${x === r.status ? "selected" : ""}>${titleCase(x)}</option>`).join("")}</select>`, 1]], t, "No tickets.")}</div>`;
    }
    if (tab === 7) {
      const emps = await api("admin/employees");
      inner = `<div class="card"><p class="mute">Leave "Send to" empty to publish for everyone (policies, notices).</p>${form("ad", [{ n: "title", label: "Title" }, { n: "category", label: "Category", type: "select", opts: ["Policies", "Letters", "Notices"].map(x => [x, x]) }, { n: "emp_id", label: "Send to", type: "select", opts: [["", "Everyone"], ...emps.filter(e => e.active).map(e => [e.id, e.name])], req: false }, { n: "body", label: "Content", type: "textarea" }], "Publish")}</div>`;
    }
    if (tab === 8) {
      const outbox = await api("admin/outbox");
      inner = `
      <div class="card" style="border-left:4px solid var(--brand)">
        <h2>Official Welcome Email Outbox</h2>
        <p class="mute">Log of official account credential emails dispatched to new members upon onboarding.</p>
        ${table([
          ["#", r => r.id],
          ["Official Email", r => `<b>${esc(r.to_email)}</b>`, 1],
          ["Subject", r => esc(r.subject)],
          ["Email Body / Credentials", r => `<pre style="white-space:pre-wrap;margin:0;font-size:11px;background:var(--bg);padding:8px;border-radius:6px">${esc(r.body)}</pre>`, 1],
          ["Dispatched At", r => fdate(r.sent_at)]
        ], outbox, "No official emails sent yet.")}
      </div>`;
    }
    if (tab === 9) {
      // ---- Attendance Overview for HR ----
      // month picker state
      if (!draw._aoMonth) draw._aoMonth = thisMonth();
      const aoMonth = draw._aoMonth;
      const [overview, emps] = await Promise.all([
        api("admin/attendance-overview?month=" + aoMonth),
        api("admin/employees")
      ]);
      // Status badge colour helper
      const stBadge = (count, code, color) =>
        count > 0
          ? `<span style="display:inline-block;min-width:28px;padding:2px 7px;border-radius:12px;background:${color};color:#fff;font-weight:700;font-size:12px;margin:1px">${count}</span>`
          : `<span style="display:inline-block;min-width:28px;padding:2px 7px;border-radius:12px;background:#e0e0e0;color:#888;font-size:12px;margin:1px">0</span>`;
      // Drill-down: if a row was clicked, show that employee's day-by-day
      const drillKey = "__aoDrill";
      const selEmpId = draw[drillKey] || null;
      let drillHtml = "";
      if (selEmpId) {
        const detail = await api("admin/attendance-overview?month=" + aoMonth + "&emp_id=" + selEmpId);
        const selEmp = overview.find(e => e.emp_id === selEmpId);
        const statusLabel = { P: "Present", A: "Absent", CL: "Casual Leave", CO: "Comp Off", LOP: "Loss of Pay", H: "Holiday", O: "Weekly Off" };
        const statusColor = { P: "#388e3c", A: "#c62828", CL: "#1565c0", CO: "#6a1b9a", LOP: "#b71c1c", H: "#e65100", O: "#546e7a" };
        drillHtml = `
        <div class="card" style="border-left:4px solid var(--brand);margin-top:16px">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px">
            <h2 style="margin:0">📅 ${esc(selEmp ? selEmp.name : "")} — Day-by-Day (${aoMonth})</h2>
            <button class="btn sec sm" id="ao-back">← Back to All</button>
          </div>
          ${table([
            ["Date", r => fdate(r.date)],
            ["Status", r => {
              const color = statusColor[r.status] || "#555";
              return `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:${color};color:#fff;font-weight:700;font-size:12px">${esc(r.status)}</span> <span class="mute">${statusLabel[r.status] || r.status}</span>`;
            }, 1],
            ["In Time", r => r.first_in || "—"],
            ["Out Time", r => r.last_out || "—"],
            ["HR Quick Action", r => `
              <button class="btn sec sm" data-quickatt="${r.emp_id}" data-date="${r.date}" data-st="P" title="Mark Present">✅ P</button>
              <button class="btn sec sm" data-quickatt="${r.emp_id}" data-date="${r.date}" data-st="A" title="Mark Absent" style="color:#c62828">❌ A</button>
              <button class="btn sec sm" data-quickatt="${r.emp_id}" data-date="${r.date}" data-st="CL" title="Mark Casual Leave" style="color:#1565c0">🏖 CL</button>
            `, 1]
          ], detail, "No attendance records for this employee in selected month.")}
        </div>`;
      }
      inner = `
      <div class="card" style="border-left:4px solid var(--brand)">
        <h2>📋 Company-Wide Attendance Overview</h2>
        <p class="mute">Monthly attendance summary for all employees — Present, Absent, Casual Leave, Comp Off, LOP, Holiday, Weekly Off, and total working hours. Click any employee row to see day-by-day detail.</p>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
          <label style="font-weight:600">Select Month:</label>
          <input type="month" id="ao-month" value="${esc(aoMonth)}" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--card);color:var(--text)">
          <button class="btn sm" id="ao-go">View</button>
          <span class="mute" style="font-size:13px">Showing <b>${overview.length}</b> active employee(s)</span>
          <button class="btn sm" id="ao-excel" style="background:#1d6f42;color:#fff;border-color:#1d6f42;margin-left:8px" title="Download attendance Excel (.xlsx) with Summary and per-employee sheets">📥 Download Excel</button>
        </div>
        <div class="tablewrap"><table>
          <thead><tr>
            <th>Emp ID</th><th>Employee</th><th>Dept</th>
            <th style="color:#388e3c">✅ Present</th>
            <th style="color:#c62828">❌ Absent</th>
            <th style="color:#1565c0">🏖 CL</th>
            <th style="color:#6a1b9a">🔄 CO</th>
            <th style="color:#b71c1c">⚠ LOP</th>
            <th style="color:#e65100">🎉 Holiday</th>
            <th style="color:#546e7a">📅 W/Off</th>
            <th>⏱ Hrs</th>
            <th>Total Days</th>
          </tr></thead>
          <tbody>
            ${overview.map(r => `
              <tr class="ao-row" data-eid="${r.emp_id}" style="cursor:pointer" title="Click to see day-by-day for ${esc(r.name)}">
                <td><span class="mute">${esc(r.emp_no)}</span></td>
                <td><b>${esc(r.name)}</b><br><small class="mute">${esc(r.designation || "")} · <span class="badge ${esc(r.role)}">${esc(r.role.toUpperCase())}</span></small></td>
                <td>${esc(r.department || "—")}</td>
                <td style="text-align:center">${stBadge(r.present, "P", "#388e3c")}</td>
                <td style="text-align:center">${stBadge(r.absent, "A", "#c62828")}</td>
                <td style="text-align:center">${stBadge(r.casual_leave, "CL", "#1565c0")}</td>
                <td style="text-align:center">${stBadge(r.comp_off, "CO", "#6a1b9a")}</td>
                <td style="text-align:center">${stBadge(r.lop, "LOP", "#b71c1c")}</td>
                <td style="text-align:center">${stBadge(r.holiday, "H", "#e65100")}</td>
                <td style="text-align:center">${stBadge(r.weekly_off, "O", "#546e7a")}</td>
                <td style="text-align:center;font-weight:600">${r.working_hours}h</td>
                <td style="text-align:center">${r.total_days}</td>
              </tr>`).join("")}
            ${!overview.length ? `<tr><td colspan="12" class="mute" style="text-align:center;padding:20px">No attendance data found for ${esc(aoMonth)}.</td></tr>` : ""}
          </tbody>
        </table></div>
        <p class="mute" style="margin-top:8px;font-size:12px">
          <b>Legend:</b>
          P = Present &nbsp;|&nbsp; A = Absent &nbsp;|&nbsp; CL = Casual Leave &nbsp;|&nbsp; CO = Compensatory Off &nbsp;|&nbsp; LOP = Loss of Pay &nbsp;|&nbsp; H = Public Holiday &nbsp;|&nbsp; O = Weekly Off
        </p>
      </div>
      ${drillHtml}`;
    }
    el.innerHTML = `<h1>HR Admin</h1>${tabs(NAMES, tab)}${inner}`;
    el.querySelectorAll("select[data-ddl]").forEach(enhanceSelect);
    wireTabs(i => { tab = i; draw._aoMonth = null; draw.__aoDrill = null; draw._editDesig = null; draw._empView = null; draw._empEditId = null; draw._clEdit = null; draw(); });
    wire("ae", "admin/employees", () => { toast("Member added & credentials sent to official email!"); draw._empView = "list"; draw(); }, d => ({ ...d, manager_id: d.manager_id ? +d.manager_id : null }));
    wire("atf", "admin/attendance", draw, d => ({ ...d, emp_id: +d.emp_id }));
    wire("ah", "admin/holidays", draw);
    wire("ad", "admin/documents", draw, d => ({ ...d, emp_id: d.emp_id ? +d.emp_id : null }));

    // Employees tab: list / add / edit sub-views
    el.querySelectorAll("[data-empview]").forEach(b => b.onclick = () => {
      draw._empView = b.dataset.empview;
      draw._editDesig = null;
      if (b.dataset.empview !== "edit") draw._empEditId = null;
      draw();
    });
    const empPick = $("#emp-edit-pick");
    if (empPick) empPick.onchange = () => {
      draw._empEditId = empPick.value ? +empPick.value : null;
      draw();
    };
    el.querySelectorAll("[data-empedit]").forEach(b => b.onclick = () => {
      draw._empView = "edit";
      draw._empEditId = +b.dataset.empedit;
      draw._editDesig = null;
      draw();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    const eeForm = $("#ee");
    if (eeForm) eeForm.onsubmit = async e => {
      e.preventDefault();
      const errEl = $("#ee-err"); if (errEl) errEl.textContent = "";
      const data = Object.fromEntries(new FormData(eeForm));
      data.manager_id = data.manager_id ? +data.manager_id : null;
      if (!data.join_date) delete data.join_date;
      try {
        await api("admin/employees/" + draw._empEditId, "PATCH", data);
        toast("Employee details updated");
        draw._empView = "list";
        draw();
      } catch (er) { if (errEl) errEl.textContent = er.message; }
    };
    const eeDesigSel = $("#ee-designation"), eeDeptSel = $("#ee-department");
    if (eeDesigSel && eeDeptSel) eeDesigSel.onchange = () => {
      const dept = (draw._desigDeptMap || {})[eeDesigSel.value];
      if (dept && [...eeDeptSel.options].some(o => o.value === dept)) eeDeptSel.value = dept;
    };

    // Designation master list wiring (Employees tab)
    if (tab === 1) {
      const desigSel = $("#ae-designation"), deptSel = $("#ae-department");
      if (desigSel && deptSel) desigSel.onchange = () => {
        const dept = (draw._desigDeptMap || {})[desigSel.value];
        if (dept && [...deptSel.options].some(o => o.value === dept)) deptSel.value = dept;
      };
      const editing = draw._editingEmp;
      if (editing) {
        $("#edit-desig-cancel").onclick = () => { draw._editDesig = null; draw(); };
        $("#edit-desig-save").onclick = async () => {
          const val = $("#edit-desig-sel").value;
          try {
            await api("admin/employees/" + editing.id, "PATCH", { designation: val });
            toast("Designation updated to " + val);
            draw._editDesig = null; draw();
          } catch (e) { toast("❌ " + e.message); }
        };
      }
    }

    // Casual Leave (CL) tab: edit one employee + bulk apply to everyone
    if (tab === 4) {
      const clEmp = $("#cl-edit-emp"), clVal = $("#cl-edit-val"), clHint = $("#cl-edit-hint");
      if (clEmp) clEmp.onchange = () => {
        const emp = (draw._clList || []).find(x => x.emp_id === +clEmp.value);
        if (emp) {
          clVal.value = emp.granted;
          if (clHint) clHint.textContent = `Granted ${emp.granted} · Consumed ${emp.consumed} · Balance ${emp.balance} days`;
        } else {
          clVal.value = "";
          if (clHint) clHint.textContent = "Select an employee first";
        }
      };
      const clSave = $("#cl-edit-save");
      if (clSave) clSave.onclick = async () => {
        if (!clEmp || !clEmp.value) { toast("Select an employee first"); return; }
        if (clVal.value === "" || isNaN(+clVal.value)) { toast("Enter the new CL days"); return; }
        try {
          await api("admin/leave-grant", "POST", { emp_id: +clEmp.value, code: "CL", days: +clVal.value, mode: "set" });
          toast("CL updated to " + clVal.value + " day(s)");
          draw._clEdit = +clEmp.value;
          draw();
        } catch (e) { toast("❌ " + e.message); }
      };
      const clBulk = $("#cl-bulk-apply");
      if (clBulk) clBulk.onclick = async () => {
        const mode = $("#cl-bulk-mode").value;
        const days = +$("#cl-bulk-days").value;
        if (!mode) { toast("Select an action first"); return; }
        if (isNaN(days)) { toast("Enter CL days"); return; }
        const verb = mode === "set" ? "Set CL to" : "Add CL";
        if (!confirm(`${verb} ${days} day(s) for ALL active employees?`)) return;
        try {
          const r = await api("admin/leave-grant-bulk", "POST", { code: "CL", days, mode });
          toast(`CL updated for ${r.updated} employee(s)` + (r.skipped && r.skipped.length ? ` · skipped ${r.skipped.length}` : ""));
          draw._clEdit = null; draw();
        } catch (e) { toast("❌ " + e.message); }
      };
      el.querySelectorAll("[data-cledit]").forEach(b => b.onclick = () => {
        draw._clEdit = +b.dataset.cledit;
        draw();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      // Add/remove CL form (custom submit so the placeholder can be validated)
      const glForm = $("#gl");
      if (glForm) glForm.onsubmit = async e => {
        e.preventDefault();
        const errEl = $("#gl-err"); if (errEl) errEl.textContent = "";
        const d = Object.fromEntries(new FormData(glForm));
        if (!d.emp_id) { if (errEl) errEl.textContent = "Please select an employee."; return; }
        if (!d.days || isNaN(+d.days) || +d.days === 0) { if (errEl) errEl.textContent = "Enter days to add or remove (non-zero)."; return; }
        try {
          await api("admin/leave-grant", "POST", { emp_id: +d.emp_id, code: d.code || "CL", days: +d.days });
          toast("Casual Leave balance adjusted!");
          draw();
        } catch (er) { if (errEl) errEl.textContent = er.message; }
      };
    }

    // Month-wise attendance Excel download (Admin > Attendance tab)
    const attXlsBtn = $("#att-xls-btn");
    if (attXlsBtn) attXlsBtn.onclick = () => {
      const mv = $("#att-xls-month");
      downloadAttendanceExcel(mv && mv.value ? mv.value : thisMonth());
    };

    // Attendance Overview tab bindings
    if (tab === 9) {
      const aoGoBtn = $("#ao-go");
      if (aoGoBtn) aoGoBtn.onclick = () => {
        const mv = $("#ao-month");
        if (mv && mv.value) { draw._aoMonth = mv.value; draw[draw.drillKey || "__aoDrill"] = null; draw(); }
      };
      const backBtn = $("#ao-back");
      if (backBtn) backBtn.onclick = () => { draw["__aoDrill"] = null; draw(); };
      el.querySelectorAll(".ao-row").forEach(row => row.onclick = () => {
        draw["__aoDrill"] = +row.dataset.eid; draw();
      });
      // Excel download button
      const aoExcelBtn = $("#ao-excel");
      if (aoExcelBtn) aoExcelBtn.onclick = () => {
        const mv = $("#ao-month");
        const month = (mv && mv.value) ? mv.value : draw._aoMonth;
        downloadAttendanceExcel(month);
      };
    }

    el.querySelectorAll("[data-desig]").forEach(b => b.onclick = () => {
      draw._editDesig = +b.dataset.desig;
      draw();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    el.querySelectorAll("[data-quickatt]").forEach(b => b.onclick = async () => {
      try {
        await api("admin/attendance", "POST", { emp_id: +b.dataset.quickatt, date: b.dataset.date, status: b.dataset.st });
        toast("Attendance marked as " + b.dataset.st); draw();
      } catch (e) { toast(e.message); }
    });

    el.querySelectorAll("[data-hrappr]").forEach(b => b.onclick = async () => {
      try {
        await api(`admin/review/${b.dataset.t}/${b.dataset.hrappr}`, "POST", { action: b.dataset.a });
        toast("Request " + (b.dataset.a === "approve" ? "Approved" : "Rejected"));
        draw();
      } catch (e) { toast(e.message); }
    });

    el.querySelectorAll("[data-act]").forEach(b => b.onclick = async () => { try { await api("admin/employees/" + b.dataset.act, "PATCH", { active: b.dataset.to === "1" }); draw(); } catch (e) { toast(e.message); } });
    el.querySelectorAll("[data-pw]").forEach(b => b.onclick = async () => { const pw = prompt("New temporary password (min 8 characters)"); if (!pw) return; try { await api(`admin/employees/${b.dataset.pw}/password`, "POST", { password: pw }); toast("Password updated"); } catch (e) { toast(e.message); } });
    el.querySelectorAll("[data-hd]").forEach(b => b.onclick = async () => { if (confirm("Delete this holiday?")) { await api("admin/holidays/" + b.dataset.hd, "DELETE"); draw(); } });
    el.querySelectorAll("[data-tk]").forEach(sel => sel.onchange = async () => { try { await api("admin/tickets/" + sel.dataset.tk, "PATCH", { status: sel.value }); toast("Ticket updated"); } catch (e) { toast(e.message); } });
  };
  draw();
};

function bindSide(route) {
  document.querySelectorAll(".grp").forEach(b => b.onclick = e => {
    e.stopPropagation();
    // Accordion: opening one dropdown closes every other one, including the one that
    // holds the current page. "" means "all closed" (an empty set would fall back to the current page's group).
    const g = b.dataset.g, wasOpen = b.getAttribute("aria-expanded") === "true";
    openGroups.clear(); openGroups.add(wasOpen ? "" : g);
    $("#side").innerHTML = sidebar(route); bindSide(route);
    const nb = $(`.grp[data-g="${g}"]`); if (nb) nb.focus();
  });
  if (!window.__sideCloseBound) {
    window.__sideCloseBound = true;
    document.addEventListener("click", e => {
      if (!e.target.closest(".grp") && !e.target.closest(".sub")) {
        if (openGroups.size) { openGroups.clear(); document.querySelectorAll(".sub.open").forEach(s=>s.classList.remove("open")); document.querySelectorAll(".grp").forEach(bb=>bb.setAttribute("aria-expanded","false")); }
      }
    });
  }
}
function sidebar(route) {
  const link = (r, l, ic) => `<a href="#/${r}" onclick="setTimeout(()=>render(),0)" class="${r === route ? "on" : ""}"><span class="ic" aria-hidden="true">${icon(ic)}</span>${esc(l)}${r === "review" && ME.pending_reviews ? ` <span class="badge pending">${ME.pending_reviews}</span>` : ""}</a>`;
  const isExec = EXEC_ROLES.includes(ME.role);
  const isHR = HR_LIKE_ROLES.includes(ME.role) || ME.role === "superadmin";
  let navList = [...NAV];
  if (isExec) {
    if (ME.role === "superadmin") {
      navList = [["executive", "Superadmin Suite", "suite"], ...navList];
    } else {
      // HR Admin sits at the top, above Home
      navList = [["executive", `${ME.role.toUpperCase()} Suite`, "suite"], ["admin", "HR Admin", "admin"], ...navList, ["accounts", "Accounts Admin", "accounts"]];
    }
  } else if (isHR) {
    navList = [["admin", "HR Admin", "admin"], ...navList];
  } else if (ME.role === "accounts" || ME.role === "superadmin") {
    navList = [...navList, ["accounts", "Accounts Admin", "accounts"]];
  }
  return `<div class="logo"><img src="assets/logo.png" alt="" aria-hidden="true"><span>3Wheels AI</span></div>
  <div class="prof"><span class="avatar">${esc(ME.name[0])}</span><div><b>Hi ${esc(ME.name.split(" ")[0])}</b> <span class="badge ${esc(ME.role)}">${esc(ME.role.toUpperCase())}</span><br><a href="#/my-info">View My Info</a></div><a href="#/my-info" class="gear" aria-label="Settings">${icon("admin")}</a></div>
  <nav>${navList.map(n => {
    if (typeof n[2] !== "object") return link(n[0], n[1], n[2]);
    const [label, ic, kids] = n, has = kids.some(k => k[0] === route), open = openGroups.size ? openGroups.has(label) : has;
    return `<button class="grp" data-g="${esc(label)}" aria-expanded="${open}"><span class="ic" aria-hidden="true">${icon(ic)}</span>${esc(label)}<span class="chev">${icon("chev", "ico sm")}</span></button><div class="sub ${open ? "open" : ""}">${kids.map(k => link(k[0], k[1])).join("")}</div>`;
  }).join("")}</nav>`;
}

// ---- Excel Export: Attendance Overview (server-generated, styled) ----
async function downloadAttendanceExcel(month) {
  toast("Preparing Excel file, please wait…");
  try {
    const res = await fetch("/api/admin/attendance-export?month=" + encodeURIComponent(month), {
      credentials: "same-origin"
    });
    if (!res.ok) {
      let msg = "Excel export failed";
      try { const j = await res.json(); msg = j.error || msg; } catch { }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "3WheelsAI_Attendance_" + month + ".xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("✅ Excel downloaded");
  } catch (e) {
    console.error(e);
    toast("❌ " + (e.message || e));
  }
}
const sysDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
const curTheme = () => document.documentElement.dataset.theme || (sysDark() ? "dark" : "light");
const themeBtn = (cls = "") => `<button class="theme-btn ${cls}" id="theme" type="button" aria-label="Switch to ${curTheme() === "dark" ? "light" : "dark"} mode">${curTheme() === "dark" ? "☀ Light" : "🌙 Dark"}</button>`;
function bindTheme() {
  const b = $("#theme"); if (!b) return;
  b.onclick = () => {
    const n = curTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = n;
    try { localStorage.setItem("theme", n); } catch { }
    b.outerHTML = themeBtn(b.classList.contains("theme-float") ? "theme-float" : ""); bindTheme(); $("#theme").focus();
  };
}

async function refreshMe() { try { ME = await api("me"); const b = $("#bellcount"); if (b) b.textContent = ME.unread || ""; } catch { } }

function retryAfterMaintenance() {
  clearTimeout(_maintTimer);
  MAINT = false;
  checkHealth().then(bootMe).then(render);  // a 503 here switches the maintenance screen straight back on
}

// Asks the server (and through it the database) if all is well; a 503 turns on the maintenance screen.
async function checkHealth() { try { await api("health"); } catch { } }

function renderMaintenance(app) {
  app.innerHTML = `${themeBtn("theme-float")}<div class="maint-wrap"><div class="maint card">
    <div class="maint-icon" aria-hidden="true">🛠️</div>
    <div class="login-brand"><img src="assets/logo.png" alt=""><span>3Wheels AI</span></div>
    <h1>We'll be back soon</h1>
    <p class="mute">The website is under maintenance right now. Please wait a few minutes. This page checks again by itself and opens the portal as soon as it is ready.</p>
    <button class="btn" id="maint-retry" type="button">Try again</button>
    <p class="mute maint-note">Sorry for the inconvenience.</p>
  </div></div>`;
  bindTheme();
  $("#maint-retry").onclick = retryAfterMaintenance;
  clearTimeout(_maintTimer);
  _maintTimer = setTimeout(retryAfterMaintenance, 20000);
}

function render() {
  const app = $("#app");
  if (MAINT) { renderMaintenance(app); return; }
  if (!ME) {
    app.innerHTML = `${themeBtn("theme-float")}<div class="login-wrap">
      <section class="login-hero" aria-hidden="true">
        <div class="hero-brand"><span class="hero-logo"><img src="assets/logo.png" alt=""></span>3Wheels AI</div>
        <div class="hero-copy">
          <h2>Your people, payroll and time, in one place.</h2>
          <p>The 3Wheels AI workspace for leave, attendance, payslips and approvals.</p>
          <ul class="hero-feats">
            <li><span class="fi">🌿</span><div><b>Leave and attendance</b><span>Apply, track balances and regularise in a few clicks.</span></div></li>
            <li><span class="fi">💰</span><div><b>Payslips and salary</b><span>Request payslips and see your year to date reports.</span></div></li>
            <li><span class="fi">✅</span><div><b>Quick approvals</b><span>Managers and HR review requests as they arrive.</span></div></li>
          </ul>
        </div>
        <div class="hero-foot">© ${new Date().getFullYear()} 3Wheels AI · Secure employee workspace</div>
      </section>
      <section class="login-panel">
        <div class="login card">
          <div class="login-brand"><img src="assets/logo.png" alt="3Wheels AI"></div>
          <h1>Welcome back</h1>
          <p class="mute login-sub">Sign in to your 3Wheels AI workspace</p>
          ${form("lg", [{ n: "email", label: "Work email", type: "email", placeholder: "name@3wheels.ai" }, { n: "password", label: "Password", type: "password", placeholder: "Enter your password" }], "Sign in")}
          <p class="login-help mute">Trouble signing in? Contact your HR team.</p>
        </div>
      </section>
    </div>`;
    bindTheme();
    const em = $("#lg-email"), pw = $("#lg-password");
    em.autocomplete = "username"; pw.autocomplete = "current-password"; em.focus();
    const tg = document.createElement("button");
    tg.type = "button"; tg.className = "pw-toggle"; tg.textContent = "Show"; tg.setAttribute("aria-label", "Show password");
    pw.parentElement.classList.add("pw-wrap"); pw.parentElement.appendChild(tg);
    tg.onclick = () => { const show = pw.type === "password"; pw.type = show ? "text" : "password"; tg.textContent = show ? "Hide" : "Show"; tg.setAttribute("aria-label", show ? "Hide password" : "Show password"); };
    $("#lg").onsubmit = async e => {
      e.preventDefault(); $("#lg-err").textContent = "";
      const btn = e.target.querySelector("button.btn"); btn.disabled = true; btn.textContent = "Signing in…";
      try { await api("login", "POST", Object.fromEntries(new FormData(e.target))); await refreshMe(); location.hash = ["ceo", "coo", "cpo", "executive"].includes(ME.role) ? "#/executive" : "#/home"; render(); }
      catch (er) { $("#lg-err").textContent = er.message; btn.disabled = false; btn.textContent = "Sign in"; }
    };
    return;
  }
  const route = (location.hash.replace("#/", "") || (["ceo", "coo", "cpo", "executive"].includes(ME.role) ? "executive" : "home"));
  openGroups.clear();  // on every page change only the current page's dropdown starts open
  const navRoute = ROUTE_ALIAS[route] || route;   // sub pages light up their parent in the sidebar
  app.innerHTML = `<div class="shell"><aside id="side" aria-label="Main menu">${sidebar(navRoute)}</aside>
  <div class="main"><header class="topbar"><button class="menu-btn" id="mb" aria-label="Menu">☰</button>
    <div class="crumb"><span class="crumb-shape" style="--c:${CRUMB_COLOR[route] || "#c4b5fd"}"></span><span id="crumb"></span></div>
    <div class="top-right">
      <div class="ql"><button class="ql-btn" id="ql" type="button" aria-haspopup="true" aria-expanded="false">Quick Links ${icon("chev", "ico sm")}</button>
        <div class="ql-panel" id="ql-panel" hidden>${QUICK_LINKS.map(l => `<a href="${l[0]}">${esc(l[1])}</a>`).join("")}</div></div>
      ${themeBtn()}
      <button class="bell" id="bell" aria-label="Notifications">${icon("bell")}<b id="bellcount">${ME.unread || ""}</b></button>
      <button class="signout" id="out" type="button" aria-label="Sign out" title="Sign out">${icon("power")}</button>
    </div></header><main id="page" tabindex="-1"></main><footer class="foot">© ${new Date().getFullYear()} 3Wheels AI · HR Portal</footer></div></div>`;
  bindSide(navRoute); bindTheme();
  setCrumb([TITLES[route] || titleCase(route)]);
  $("#mb").onclick = () => $("#side").classList.toggle("open");
  $("#out").onclick = async () => { await api("logout", "POST"); ME = null; render(); };
  const qlBtn = $("#ql"), qlPanel = $("#ql-panel");
  qlBtn.onclick = e => { e.stopPropagation(); qlPanel.hidden = !qlPanel.hidden; qlBtn.setAttribute("aria-expanded", String(!qlPanel.hidden)); };
  qlPanel.onclick = () => { qlPanel.hidden = true; qlBtn.setAttribute("aria-expanded", "false"); };
  if (!window.__qlClose) { window.__qlClose = true; document.addEventListener("click", () => { const p = $("#ql-panel"); if (p && !p.hidden) { p.hidden = true; const b = $("#ql"); if (b) b.setAttribute("aria-expanded", "false"); } }); }
  $("#bell").onclick = async () => { const n = await api("notifications"); $("#page").innerHTML = `<h1>Notifications</h1><div class="card">${table([["Message", r => r.text + (r.text.includes("requested payslip") ? ' <button class="btn sm" onclick="location.hash=\'#/accounts\';render();">Execute</button>' : r.text.includes("is ready") ? ' <button class="btn sm" onclick="location.hash=\'#/payslips\';render();">Download</button>' : ""), 1], ["Received at", r => r.created_at]], n, "No notifications.")}</div>`; $("#bellcount").textContent = ""; };
  const page = $("#page");
  (P[route] || P.home)(page).catch(e => { page.innerHTML = `<div class="card err">${esc(e.message)}</div>`; });
}
// The start-up code (first render, hash routing, idle logout) lives in boot.js,
// which index.html loads after this file and the page files.
