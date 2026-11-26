"use strict";
// Attendance pages in the greytHR style:
//   Attendance Info, My Regularizations (regularize a day), Regularization & Permission (ask for permission)

const STATUS_NAME = { P: "Present", A: "Absent", CL: "Casual Leave", CO: "Comp Off", LOP: "Loss Of Pay", L: "Leave", HD: "Present / Leave", H: "Holiday", O: "Weekly Off" };
const EXC = ["A", "L", "HD"];               // days that show a + to regularize (absent, leave without punch, half day)
const BREAK_MIN = 45;                       // lunch break taken off the worked time
const LATE_GRACE = 15;                      // minutes allowed after shift start

// Numbers for a set of attendance rows (up to and including the given date)
function attStats(days, shiftText, upTo) {
  const sh = shiftInfo(shiftText), rows = days.filter(d => d.date <= upTo);
  const present = rows.filter(d => d.status === "P" || d.status === "HD");   // days that have punch times
  const half = rows.filter(d => d.status === "HD").length;
  const worked = present.filter(d => d.first_in && d.last_out).map(d => workMins(d.first_in, d.last_out)).filter(x => x > 0);
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const avgTotal = avg(worked);
  return {
    sh, rows, present: present.length - half / 2,
    absent: rows.filter(d => d.status === "A").length,
    holidays: rows.filter(d => d.status === "H").length,
    leave: rows.filter(d => ["CL", "CO", "LOP", "L"].includes(d.status)).length + half / 2,
    half,
    late: sh.start == null ? 0 : present.filter(d => d.first_in && timeMins(d.first_in) > sh.start + LATE_GRACE).length,
    early: sh.end == null ? 0 : present.filter(d => d.last_out && timeMins(d.last_out) < sh.end).length,
    avgShift: sh.start == null ? null : sh.end - sh.start,
    avgActual: avgTotal == null ? null : Math.max(avgTotal - BREAK_MIN, 0),
    avgIn: avg(present.filter(d => d.first_in).map(d => timeMins(d.first_in))),
    avgOut: avg(present.filter(d => d.last_out).map(d => timeMins(d.last_out))),
    workingDays: rows.filter(d => !["H", "O"].includes(d.status)).length,
  };
}
const hms = x => { if (x == null) return "-"; const s = Math.round(x * 60); return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s % 3600 / 60))}:${pad2(s % 60)}`; };

function donut(parts) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1, R = 62, W = 38, C = 2 * Math.PI * R;
  let acc = 0, rings = "", labels = "";
  parts.forEach(p => {
    const f = p.value / total; if (!f) return;
    rings += `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${p.color}" stroke-width="${W}" stroke-dasharray="${f * C} ${C - f * C}" stroke-dashoffset="${-acc * C}" transform="rotate(-90 100 100)"/>`;
    const mid = (acc + f / 2) * 2 * Math.PI - Math.PI / 2;
    labels += `<text x="${100 + R * Math.cos(mid)}" y="${104 + R * Math.sin(mid)}" text-anchor="middle" font-size="12" fill="#4a5568">${Math.round(f * 100)}%</text>`;
    acc += f;
  });
  return `<svg viewBox="0 0 200 200" class="donut" role="img" aria-label="Attendance split">${rings}${labels}</svg>`;
}

// ------------------------------------------------------------------ Attendance Info
P.attendance = async el => {
  let ym = localYm(), sel = todayIso(), view = "grid";
  const holidays = await api("holidays");
  const holName = Object.fromEntries(holidays.map(h => [h.date, h.name]));

  const draw = async () => {
    const [cur, prev] = await Promise.all([api("attendance?month=" + ym), api("attendance?month=" + addMonths(ym, -1))]);
    // One punch so far: the server stores it as both in and out. Show it as First In only; Last Out (and the hours) appear with the next punch.
    [cur, prev].forEach(m => m.days.forEach(d => { if (d.last_out && d.last_out === d.first_in) d.last_out = null; }));
    const today = todayIso(), byDate = Object.fromEntries(cur.days.map(d => [d.date, d]));
    const st = attStats(cur.days, cur.shift, today), pst = attStats(prev.days, prev.shift, "9999-99-99"), sh = st.sh;
    if (sel.slice(0, 7) !== ym) sel = ym === today.slice(0, 7) ? today : ym + "-01";
    const exceptions = cur.days.filter(d => EXC.includes(d.status)).length;
    const change = st.avgActual != null && pst.avgActual ? Math.round((st.avgActual - pst.avgActual) / pst.avgActual * 100) : null;
    const flagged = d => d && d.status === "P" && sh.start != null && d.first_in && timeMins(d.first_in) > sh.start + LATE_GRACE;

    const cell = c => {
      const d = byDate[c.iso], s = d && !c.out ? d.status : "";
      return `<div class="ac ${c.out ? "out" : ""} ${s ? "s-" + s : ""} ${c.iso === today ? "today" : ""} ${c.iso === sel && !c.out ? "sel" : ""}" data-d="${c.iso}" ${c.out ? "" : 'tabindex="0"'}>
        <span class="ac-n">${pad2(c.day)}</span>${s === "HD" ? '<b class="ac-st"><i>P</i><i>L</i></b>' : s ? `<b class="ac-st">${esc(s)}</b>` : ""}${c.out ? "" : `<small class="ac-sh">${esc(sh.code)}</small>`}${!c.out && flagged(d) ? '<i class="ac-flag" title="Late in"></i>' : ""}</div>`;
    };
    const grid = view === "grid"
      ? `<div class="ac-head">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(x => `<div>${x}</div>`).join("")}</div><div class="ac-grid">${monthGrid(ym).map(cell).join("")}</div>`
      : `<div class="tablewrap">${table([["Date", r => longDate(r.date)], ["Day", r => weekdayOf(r.date)], ["Status", r => statusBadge(r.status), 1], ["First In", r => r.first_in || "-"], ["Last Out", r => r.last_out || "-"], ["Work Hrs", r => r.first_in && r.last_out ? hhmm(workMins(r.first_in, r.last_out)) : "-"]], cur.days, "No attendance recorded for this month.")}</div>`;

    // the chosen day
    const r = byDate[sel], inM = r && r.first_in ? timeMins(r.first_in) : null, outM = r && r.last_out ? timeMins(r.last_out) : null;
    const total = inM != null && outM != null && workMins(r.first_in, r.last_out) > 0 ? workMins(r.first_in, r.last_out) : null;
    const lateIn = inM != null && sh.start != null && inM > sh.start ? inM - sh.start : null;
    const earlyOut = outM != null && sh.end != null && outM < sh.end ? sh.end - outM : null;
    const brk = total != null && total > 300 ? BREAK_MIN : null;
    const remark = !r ? "" : r.status === "H" ? (holName[sel] || "Holiday") : (STATUS_NAME[r.status] || "");
    const s1 = sh.start == null ? null : [sh.start, sh.start + 180], s2 = sh.start == null ? null : [sh.start + 225, sh.end];
    const range = x => x ? `${hhmm(x[0])} - ${hhmm(x[1])}` : "-";
    // a half day shows one session as Present and the other as Half Day (the one the person was not there for)
    const cameLate = inM != null && s2 && inM >= s2[0] - 30;
    const sessionStatus = n => !r ? "-" : r.status === "HD" ? ((n === 2) === cameLate ? "Present" : "Leave") : r.status === "P" ? "Present" : (STATUS_NAME[r.status] || r.status);

    el.innerHTML = `<div class="att">
      <div class="att-top"><button class="btn" type="button" id="to-reg">My Regularizations</button></div>
      ${exceptions ? `<div class="att-exc"><span class="exc-ic">!</span><span>${exceptions} exception day(s): leave / half day with no full punch</span><a href="#/my-regularizations">Regularize</a></div>` : ""}
      <div class="att-stats">
        <div class="stat-box"><div class="sb-h">AVG. WORK HRS</div><div class="sb-v">${hhmm(st.avgShift)}</div></div>
        <div class="stat-box"><div class="sb-h">AVG. ACTUAL WORK HRS</div><div class="sb-v">${hhmm(st.avgActual)}${change != null ? `<small class="${change < 0 ? "neg" : "pos"}">${change > 0 ? "+" : ""}${change}% From ${monthName(addMonths(ym, -1))}</small>` : ""}</div></div>
        <div class="stat-box"><div class="sb-h">PENALTY DAYS</div><div class="sb-v">0</div></div>
        <a href="#" class="att-ins" id="insights">+3 INSIGHTS</a>
        <div class="att-view" role="group" aria-label="View"><button type="button" data-view="grid" class="${view === "grid" ? "on" : ""}" aria-label="Calendar view">▦</button><button type="button" data-view="list" class="${view === "list" ? "on" : ""}" aria-label="List view">☰</button></div>
      </div>
      <div class="att-body">
        <section class="att-cal"><div class="cal-nav"><button type="button" id="cal-prev">‹ Prev</button><b>${monthTitle(ym)}</b><button type="button" id="cal-next">Next ›</button></div>${grid}</section>
        <div class="att-side">
          <div class="sd-card"><div class="sd-date"><b>${dayNum(sel)}</b><small>${weekdayOf(sel)}</small></div>
            <div><b>${esc(sh.name)}(${esc(sh.code)})</b><small>Shift : ${esc(sh.text)}</small></div>
            <div><b>${sh.start != null ? `${hhmm(sh.start)} ${sh.start < 720 ? "Am" : "Pm"} To ${hhmm(sh.end)} ${sh.end < 720 ? "Am" : "Pm"}` : "Flexible"}</b><small>Attendance Scheme</small></div></div>
          <div class="sd-table"><div class="sd-sub">Processed on</div><div class="tablewrap"><table><thead><tr><th>First In</th><th>Last Out</th><th>Late In</th><th>Early Out</th><th>Total Work Hrs</th><th>Break Hrs</th><th>Actual Work Hrs</th></tr></thead>
            <tbody><tr><td>${r && r.first_in ? esc(r.first_in) : "-"}</td><td>${r && r.last_out ? esc(r.last_out) : "-"}</td><td>${lateIn != null ? hhmm(lateIn) : "-"}</td><td>${earlyOut != null ? hhmm(earlyOut) : "-"}</td><td>${hhmm(total)}</td><td>${brk ? hhmm(brk) : "-"}</td><td>${total != null ? hhmm(total - (brk || 0)) : "-"}</td></tr></tbody></table></div></div>
          <div class="sd-table"><div class="sd-title">Status Details</div><div class="tablewrap"><table><thead><tr><th>Status</th><th>Remarks</th></tr></thead><tbody><tr><td>${r ? esc(STATUS_NAME[r.status] || r.status) : "-"}</td><td>${remark ? esc(remark) : "-"}</td></tr></tbody></table></div></div>
          <div class="sd-table"><div class="sd-title">Session Details</div><div class="tablewrap"><table><thead><tr><th>Session</th><th>Session Timing</th><th>Status</th><th>First In</th><th>Last Out</th></tr></thead>
            <tbody><tr><td>Session 1</td><td>${range(s1)}</td><td>${esc(sessionStatus(1))}</td><td>${r && r.first_in ? esc(r.first_in) : "-"}</td><td>-</td></tr><tr><td>Session 2</td><td>${range(s2)}</td><td>${esc(sessionStatus(2))}</td><td>-</td><td>${r && r.last_out ? esc(r.last_out) : "-"}</td></tr></tbody></table></div></div>
        </div></div></div>`;

    $("#to-reg").onclick = () => { location.hash = "#/my-regularizations"; };
    $("#cal-prev").onclick = () => { ym = addMonths(ym, -1); draw(); };
    $("#cal-next").onclick = () => { ym = addMonths(ym, 1); draw(); };
    el.querySelectorAll("[data-view]").forEach(b => b.onclick = () => { view = b.dataset.view; draw(); });
    el.querySelectorAll(".ac:not(.out)").forEach(c => { c.onclick = () => { sel = c.dataset.d; draw(); }; c.onkeydown = e => { if (e.key === "Enter") c.click(); }; });
    $("#insights").onclick = e => { e.preventDefault(); showInsights(ym, cur, today); };
  };

  const showInsights = (month, cur, today) => {
    const last = month === today.slice(0, 7) ? today : month + "-" + pad2(new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate());
    const st = attStats(cur.days, cur.shift, last);
    const label = `${pad2(1)} ${monthName(month, "short")} - ${pad2(dayNum(last))} ${monthName(month, "short")}`;
    const body = openDialog(`Insights for Attendance Period ${label}`, `
      <div class="ins-range">${longDate(month + "-01")} - ${longDate(last)}</div>
      <p class="ins-days">Total Working Days: <b>${st.workingDays}</b></p>
      <div class="ins-strip">${[["AVG. WORK HRS", hhmm(st.avgShift)], ["AVG. ACTUAL WORK HRS", hhmm(st.avgActual)], ["PENALTY DAYS", "0"], ["LATE IN", st.late], ["EARLY OUT", st.early], ["LEAVE TAKEN", st.leave]].map(x => `<div><small>${x[0]}</small><b>${x[1]}</b></div>`).join("")}</div>
      <div class="ins-chart">${donut([{ value: st.absent, color: "#b6cbe0" }, { value: st.holidays, color: "#b7e4c2" }, { value: st.present, color: "#bdebf6" }, { value: st.leave, color: "#ffd8bd" }])}</div>
      <p class="ins-avg"><span>Avg First In Time:</span> <b>${hms(st.avgIn)}</b> <i></i> <span>Avg Last Out Time:</span> <b>${hms(st.avgOut)}</b></p>
      <div class="ins-legend"><span><i style="background:#b6cbe0"></i>Absent</span><span><i style="background:#b7e4c2"></i>Holidays</span><span><i style="background:#bdebf6"></i>Present</span><span><i style="background:#ffd8bd"></i>Leave</span></div>`, { wide: true });
    return body;
  };
  await draw();
};

// ------------------------------------------------------------------ Regularize / Permission (shared)
// cfg: { kind, crumb, tabs, dark, miniCal ("upper" | "plain"), emptyTitle, emptyMsg, noun }
async function regulPage(el, cfg) {
  let tab = 0, ym = localYm(), picked = [], rows = {}, approver = "", remarks = "";
  const kind = cfg.kind;
  if (cfg.crumb) setCrumb(cfg.crumb);
  const [info, mine] = await Promise.all([api("approval-info"), api("regularization")]);
  const approvers = [];
  if (info.manager) approvers.push({ id: info.manager.id, name: info.manager.name, label: "Manager" });
  (info.backups || []).forEach(b => approvers.push({ id: b.id, name: b.name, label: b.role.toUpperCase() }));
  approver = approvers.length ? String(approvers[0].id) : "";
  const today = todayIso();

  const draw = async (reload = false) => {
    const att = await api("attendance?month=" + ym), shift = shiftInfo(att.shift);
    const gap = new Set(att.days.filter(d => EXC.includes(d.status)).map(d => d.date));   // absent, leave (no punch) and half days
    const dayInfo = Object.fromEntries(att.days.map(d => [d.date, d]));
    const list = (await api("regularization")).filter(r => r.kind === kind);   // always fresh
    const pending = list.filter(r => r.status === "pending"), history = list.filter(r => r.status !== "pending");

    const calHead = cfg.miniCal === "upper"
      ? `<div class="mc-nav"><button type="button" id="mc-prev">‹ Prev</button><b>${monthTitle(ym).toUpperCase()}</b><button type="button" id="mc-next">Next ›</button></div>`
      : `<div class="mc-nav plain"><button type="button" id="mc-prev" aria-label="Previous month">‹</button><b>${monthTitle(ym)}</b><button type="button" id="mc-next" aria-label="Next month">›</button></div>`;
    const wk = cfg.miniCal === "upper" ? ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] : ["S", "M", "T", "W", "T", "F", "S"];
    const mc = monthGrid(ym).map(c => {
      const future = c.iso > today, cls = [c.out ? "out" : "", future ? "future" : "", c.iso === today ? "today" : "", gap.has(c.iso) && !c.out ? "gap" : "", picked.includes(c.iso) ? "picked" : ""].join(" ");
      return `<button type="button" class="mc-d ${cls}" data-d="${c.iso}" ${future || c.out ? "disabled" : ""}>${c.day}${gap.has(c.iso) && !c.out && !future ? '<i class="mc-plus" aria-hidden="true">+</i>' : ""}</button>`;
    }).join("");
    const gapCount = gap.size;
    const calFoot = cfg.kind === "regularize"
      ? `<div class="mc-foot">${gapCount} exception day(s). Days with a + are leave / half day: pick one, enter the right time and send it for approval.</div>`
      : `<div class="mc-foot two"><span class="neg">${gapCount} Gap day(s)</span><button type="button" class="btn sec" id="quick-add">Quick Add</button></div>`;
    const jump = picked.length ? `<div class="mc-jump"><small>JUMP TO</small>${picked.map(d => `<a href="#" data-jump="${d}">${dayNum(d)} ${weekdayOf(d)}</a>`).join("")}</div>` : "";

    let main;
    if (!picked.length) {
      main = `<div class="rg-empty">${emptyBlock("calClock", cfg.emptyTitle, cfg.emptyMsg)}</div>`;
    } else {
      const apprOpts = approvers.map(a => `<option value="${a.id}" ${String(a.id) === approver ? "selected" : ""}>${esc(a.name)} (${esc(a.label)})</option>`).join("");
      main = `<div class="rg-form card">
        <div class="rg-appr"><span class="avatar">${esc((approvers.find(a => String(a.id) === approver) || { name: "?" }).name[0])}</span><div><label for="rg-appr">Approver</label><select id="rg-appr" ${approvers.length ? "" : "disabled"}>${apprOpts}</select></div></div>
        <label for="rg-remarks">Remarks</label><textarea id="rg-remarks" rows="4" placeholder="Remarks">${esc(remarks)}</textarea>
        ${picked.map(d => { const di = dayInfo[d], r = rows[d] || (rows[d] = { in: di && di.first_in ? di.first_in : shift.start != null ? hhmm(shift.start) : "", out: di && di.last_out && di.last_out !== di.first_in ? di.last_out : shift.end != null ? hhmm(shift.end) : "", reason: "" });
          return `<div class="rg-day" data-day="${d}"><div class="rg-dh"><div class="sd-date"><b>${dayNum(d)}</b><small>${weekdayOf(d)}</small></div><div class="rg-shift">${esc(shift.name)}${di && EXC.includes(di.status) ? ` <span class="rg-was">was: ${esc(STATUS_NAME[di.status])}${di.first_in ? ` (${esc(di.first_in)} - ${esc(di.last_out || "?")})` : ""}</span>` : ""}</div><button type="button" class="rg-x" data-remove="${d}" aria-label="Remove ${d}">×</button></div>
            <div class="rg-cols"><div><label>From</label><input type="time" data-f="in" value="${esc(r.in)}"></div><div><label>To</label><input type="time" data-f="out" value="${esc(r.out)}"></div><div class="rg-reason"><label>Reason</label><input type="text" data-f="reason" placeholder="Please enter a reason." value="${esc(r.reason)}"></div></div></div>`; }).join("")}
      </div>`;
    }
    const noteDate = longDate(today);
    const applyView = `<div class="rg"><div class="rg-cal"><div class="mc ${cfg.miniCal}">${calHead}<div class="mc-wk">${wk.map(x => `<span>${x}</span>`).join("")}</div><div class="mc-grid">${mc}</div>${calFoot}${jump}</div></div>
      <section class="rg-main">${main}</section>
      <div class="rg-note">${cfg.noteHtml ? cfg.noteHtml(noteDate) : `You can ${cfg.noun} any day up to <b>${noteDate}</b>. Days marked in orange have no attendance.`}</div></div>
      ${picked.length ? `<div class="rg-bar"><button type="button" class="link" id="rg-cancel">Cancel</button><button type="button" class="btn sec" id="rg-submit">Submit</button></div>` : ""}`;

    const card = r => rcard(r.id, [[cfg.byLabel, r.approver_name || "-"], ["No. of days", "1"]], r.status === "pending" ? ["PENDING", "warn"] : r.status === "approved" ? ["CLOSED", "closed"] : ["REJECTED", "bad"],
      `<div class="rc-line"><span>Dates applied :</span> <b>${longDate(r.date)}</b></div><div class="rc-foot"><div><small>${cfg.onLabel}</small><b>${esc(String(r.decided_at || r.created_at || "").slice(0, 10) ? longDate(String(r.decided_at || r.created_at).slice(0, 10)) : "-")}</b></div><a href="#" data-details="${r.id}">View Details</a></div>`);
    const listView = rs => rs.length ? `<div class="rlist">${rs.map(card).join("")}</div>` : emptyBlock("emptyList", "", tab === 1 ? "No pending requests." : "No history yet.");

    el.innerHTML = `${segTabs(cfg.tabs, tab, cfg.dark ? "dark" : "")}${cfg.legend ? '<div class="legend-row"><a href="#" id="legend">Legend</a></div>' : ""}
      ${tab === 0 ? applyView : tab === 1 ? listView(pending) : listView(history)}`;

    wireSeg(el, i => { tab = i; draw(); });
    wireRcards(el);
    el.querySelectorAll("[data-details]").forEach(a => a.onclick = e => { e.preventDefault(); const r = list.find(x => String(x.id) === a.dataset.details); if (r) openDialog("Request details", `<table class="kv"><tr><th>Date</th><td>${longDate(r.date)}</td></tr><tr><th>From - To</th><td>${esc(r.in_time || "-")} - ${esc(r.out_time || "-")}</td></tr><tr><th>Reason</th><td>${esc(r.reason || "-")}</td></tr><tr><th>Approver</th><td>${esc(r.approver_name || "-")}</td></tr><tr><th>Status</th><td>${badge(r.status)}</td></tr></table>`); });
    const lg = $("#legend"); if (lg) lg.onclick = e => { e.preventDefault(); openDialog("Legend", `<ul class="legend-list"><li><i class="lg gap"></i> Day with no attendance (gap day)</li><li><i class="lg today"></i> Today</li><li><i class="lg picked"></i> Day you have selected</li><li><i class="lg future"></i> Future day (cannot be selected)</li></ul>`); };
    if (tab !== 0) return;

    const keep = () => { remarks = ($("#rg-remarks") || { value: remarks }).value; el.querySelectorAll(".rg-day").forEach(box => { const d = box.dataset.day; box.querySelectorAll("[data-f]").forEach(i => { rows[d][i.dataset.f] = i.value; }); }); };
    $("#mc-prev").onclick = () => { keep(); ym = addMonths(ym, -1); draw(); };
    $("#mc-next").onclick = () => { keep(); ym = addMonths(ym, 1); draw(); };
    el.querySelectorAll(".mc-d:not([disabled])").forEach(b => b.onclick = () => { keep(); const d = b.dataset.d; picked = picked.includes(d) ? picked.filter(x => x !== d) : [...picked, d].sort(); draw(); });
    const qa = $("#quick-add"); if (qa) qa.onclick = () => { keep(); picked = [...new Set([...picked, ...[...gap].filter(d => d <= today)])].sort(); draw(); };
    el.querySelectorAll("[data-jump]").forEach(a => a.onclick = e => { e.preventDefault(); const box = el.querySelector(`.rg-day[data-day="${a.dataset.jump}"]`); if (box) box.scrollIntoView({ behavior: "smooth", block: "center" }); });
    el.querySelectorAll("[data-remove]").forEach(b => b.onclick = () => { keep(); picked = picked.filter(x => x !== b.dataset.remove); draw(); });
    const ap = $("#rg-appr"); if (ap) ap.onchange = () => { keep(); approver = ap.value; draw(); };
    const cancel = $("#rg-cancel"); if (cancel) cancel.onclick = () => { picked = []; rows = {}; remarks = ""; draw(); };
    const submit = $("#rg-submit"); if (submit) submit.onclick = async () => {
      keep(); submit.disabled = true;
      let done = 0;
      for (const d of [...picked]) {
        const r = rows[d], reason = (r.reason || remarks || "").trim();
        if (!reason) { toast(`Please enter a reason for ${longDate(d)}`); break; }
        try {
          await api("regularization", "POST", { kind, date: d, in_time: r.in || null, out_time: r.out || null, reason, approver_id: approver ? +approver : undefined });
          picked = picked.filter(x => x !== d); delete rows[d]; done++;
        } catch (er) { toast(`${longDate(d)}: ${er.message}`); break; }
      }
      if (done) { toast(done === 1 ? "Request submitted" : `${done} requests submitted`); refreshMe(); if (!picked.length) { remarks = ""; tab = 1; } }
      draw();
    };
  };
  await draw();
}

P["my-regularizations"] = el => regulPage(el, {
  kind: "regularize", crumb: ["Attendance Info", "My Regularizations"], tabs: ["Apply", "Pending", "History"], miniCal: "upper",
  emptyTitle: "", emptyMsg: "Select date to start regularizing", noun: "regularise", byLabel: "Regularized by", onLabel: "Regularized on",
  noteHtml: d => `You can regularise for any exception day(s) on or before <b>${d}</b>.`,
});
P.regularization = el => regulPage(el, {
  kind: "permission", tabs: ["Apply", "Pending", "History"], dark: true, legend: true, miniCal: "plain",
  emptyTitle: "Get Going!", emptyMsg: "Select date(s) to apply for permission.", noun: "ask for permission on", byLabel: "Permission by", onLabel: "Applied on",
  noteHtml: () => "",
});
