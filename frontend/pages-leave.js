"use strict";
// Leave pages in the greytHR style: Leave Apply, Leave Balances, Leave Calendar, Holiday Calendar

const LEAVE_CATEGORY = { leave: "Leave", rh: "Restricted Holiday", cancel: "Leave Cancel", compoff_grant: "Leave Grant" };
const GENERAL_DOT = "#d6a9ea", RESTRICTED_DOT = "#e6c232";

// ------------------------------------------------------------------ Leave Apply
P["leave-apply"] = async el => {
  let tab = 0, sub = 0, hideNote = false;
  const [types, bal, hol, info] = await Promise.all([api("leave/types"), api("leave/balances"), api("holidays"), api("approval-info")]);
  const approvers = approverList(info);
  const F = { code: "", from: "", fs: "1", to: "", ts: "2", contact: "", reason: "", approver: approvers[0] ? String(approvers[0].id) : "", date: "", cancelId: "" };
  const publicHol = new Set(hol.filter(h => !h.restricted).map(h => h.date));
  const typeName = c => (types.find(t => t.code === c) || {}).name || (c === "RH" ? "Restricted Holiday" : c);
  const balOf = c => { const b = bal.find(x => x.code === c); return b ? b.balance : null; };

  // working days between two dates, the way the server counts them (no Sundays, no public holidays, halves for sessions)
  const countDays = (from, to, fs, ts) => {
    if (!from || !to || to < from) return 0;
    let n = 0;
    for (let d = new Date(from + "T00:00"); dateIso(d) <= to; d.setDate(d.getDate() + 1)) if (d.getDay() !== 0 && !publicHol.has(dateIso(d))) n += 1;
    if (n && +fs === 2) n -= 0.5;
    if (n && +ts === 1) n -= 0.5;
    return Math.max(n, 0);
  };
  const sessionOpts = sel => [["1", "Session 1"], ["2", "Session 2"]].map(o => `<option value="${o[0]}" ${String(sel) === o[0] ? "selected" : ""}>${o[1]}</option>`).join("");
  const apprChip = () => `<div class="la-appr"><span class="avatar">${esc((approvers.find(a => String(a.id) === F.approver) || { name: "?" }).name[0])}</span><div><label for="la-appr">Applying to<span class="req">*</span></label><select id="la-appr" ${approvers.length ? "" : "disabled"}>${approvers.map(a => `<option value="${a.id}" ${String(a.id) === F.approver ? "selected" : ""}>${esc(a.name)} (${esc(a.label)})</option>`).join("")}</select></div></div>`;
  const NOTES = [
    "Leave is earned by an employee and granted by the employer to take time off work. The employee is free to avail this leave in accordance with the company policy.",
    "Restricted holidays are optional holidays. You can take up to 2 of them.",
    "Leave Cancel enables you to apply for cancellation of approved leave applications. Please select a leave to get started.",
    "Compensatory Off is additional leave granted as a compensation for working overtime or on an off day.",
  ];
  const TITLES_BY_SUB = ["Applying for Leave", "Applying for Restricted Holiday", "Applying for Leave Cancel", "Applying for Comp. Off Grant"];

  const draw = async () => {
    const reqs = await api("leave/requests");
    const pend = reqs.filter(r => r.status === "pending"), done = reqs.filter(r => r.status !== "pending");
    const card = r => {
      const dur = r.kind === "rh" || r.from_date === r.to_date && r.kind !== "leave"
        ? longDate(r.from_date) : `${longDate(r.from_date)}(Session ${r.from_session || 1}) to ${longDate(r.to_date)}(Session ${r.to_session || 2})`;
      return rcard(r.id, [["Category", LEAVE_CATEGORY[r.kind] || r.kind], ["Leave Type", typeName(r.code)], ["No. of days", r.days ?? "-"]], rcStatus(r.status),
        `<div class="rc-line"><span>Duration :</span> <b>${esc(dur)}</b></div><div class="rc-line"><span>Reason :</span> <b>${esc(r.reason || "-")}</b></div>
         <div class="rc-foot"><div><small>Applied on</small><b>${esc(fmtComma(r.created_at))}</b></div><div class="rc-acts">${r.status === "pending" && ["leave", "rh"].includes(r.kind) ? `<a href="#" data-withdraw="${r.id}">Withdraw</a>` : ""}<a href="#" data-details="${r.id}">View Details</a></div></div>`);
    };
    const listView = rs => rs.length ? `<div class="rlist">${rs.map(card).join("")}</div>` : emptyBlock("emptyList", "", tab === 1 ? "No pending requests." : "No history yet.");

    let apply = "";
    if (tab === 0) {
      const note = hideNote ? "" : `<div class="la-note"><span>${NOTES[sub]}</span><a href="#" id="hide-note">Hide</a></div>`;
      let fields = "";
      if (sub === 0) {
        fields = `<div class="la-grid"><div>
          <label for="la-type">Leave type<span class="req">*</span></label><select id="la-type"><option value="">Select type</option>${types.map(t => `<option value="${esc(t.code)}" ${F.code === t.code ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select>
          <div class="la-row"><div><label for="la-from">From date<span class="req">*</span></label><input type="date" id="la-from" value="${F.from}"></div><div><label for="la-fs">Session</label><select id="la-fs">${sessionOpts(F.fs)}</select></div></div>
          <div class="la-row"><div><label for="la-to">To date<span class="req">*</span></label><input type="date" id="la-to" value="${F.to}"></div><div><label for="la-ts">Session</label><select id="la-ts">${sessionOpts(F.ts)}</select></div></div>
          </div><div class="la-bal"><div>Leave Balance: <b id="la-balv">${F.code && balOf(F.code) != null ? balOf(F.code) : ""}</b></div><div>Applying For: <b id="la-days">${countDays(F.from, F.to, F.fs, F.ts) || ""}</b></div></div></div>
          ${apprChip()}
          <label for="la-contact">Contact details</label><input type="text" id="la-contact" value="${esc(F.contact)}" style="max-width:240px">`;
      } else if (sub === 1) {
        const rh = hol.filter(h => h.restricted);
        fields = `<label for="la-date">Restricted holiday<span class="req">*</span></label><select id="la-date" style="max-width:340px"><option value="">Select holiday</option>${rh.map(h => `<option value="${h.date}" ${F.date === h.date ? "selected" : ""}>${esc(h.name)} (${longDate(h.date)})</option>`).join("")}</select>${apprChip()}`;
      } else if (sub === 2) {
        const can = reqs.filter(r => ["leave", "rh"].includes(r.kind) && ["approved", "pending"].includes(r.status));
        fields = can.length ? `<div class="tablewrap"><table class="la-cancel"><thead><tr><th></th><th>Leave Type</th><th>From Date</th><th>To Date</th><th>Days</th><th>Reason</th></tr></thead><tbody>
          ${can.map(r => `<tr><td><input type="radio" name="la-cancel" value="${r.id}" ${String(r.id) === F.cancelId ? "checked" : ""}></td><td>${esc(typeName(r.code))}<small>Applied: ${esc(fmtComma(r.created_at))}</small></td><td>${longDate(r.from_date)}<small>Session ${r.from_session || 1}</small></td><td>${longDate(r.to_date)}<small>Session ${r.to_session || 2}</small></td><td>${r.days}</td><td>${esc(r.reason || "-")}</td></tr>`).join("")}</tbody></table></div>${apprChip()}`
          : `<p class="mute">No approved or pending leave to cancel.</p>`;
      } else {
        fields = `<div class="la-grid"><div>
          <label for="la-type">Leave type<span class="req">*</span></label><select id="la-type"><option value="CO" selected>${esc(typeName("CO"))}</option></select>
          <div class="la-row"><div><label for="la-from">From date<span class="req">*</span></label><input type="date" id="la-from" value="${F.from}"></div><div><label for="la-fs">Session</label><select id="la-fs">${sessionOpts(F.fs)}</select></div></div>
          <div class="la-row"><div><label for="la-to">To date<span class="req">*</span></label><input type="date" id="la-to" value="${F.to}"></div><div><label for="la-ts">Session</label><select id="la-ts">${sessionOpts(F.ts)}</select></div></div>
          </div><div class="la-sel"><b>Selected Days</b><div><span id="la-days">0</span> Day(s)</div></div></div>${apprChip()}`;
      }
      apply = `<div class="la"><nav class="la-nav">${["Leave", "Restricted Holiday", "Leave Cancel", "Comp Off Grant"].map((n, i) => `<a href="#" data-sub="${i}" class="${i === sub ? "on" : ""}">${n}</a>`).join("")}</nav>
        <div class="la-card">${note}<h3 class="la-title">${TITLES_BY_SUB[sub]}</h3>${fields}
          <label for="la-reason">Reason</label><textarea id="la-reason" rows="2" placeholder="Enter a reason">${esc(F.reason)}</textarea>
          <div class="la-actions"><button class="btn" type="button" id="la-submit">Submit</button><button class="btn sec" type="button" id="la-clear">Cancel</button></div></div></div>`;
    }
    el.innerHTML = `${segTabs(["Apply", "Pending", "History"], tab)}${tab === 0 ? apply : tab === 1 ? listView(pend) : listView(done)}`;

    wireSeg(el, i => { tab = i; draw(); });
    wireRcards(el);
    el.querySelectorAll("[data-details]").forEach(a => a.onclick = e => { e.preventDefault(); const r = reqs.find(x => String(x.id) === a.dataset.details); if (!r) return;
      openDialog("Request details", `<table class="kv"><tr><th>Category</th><td>${esc(LEAVE_CATEGORY[r.kind] || r.kind)}</td></tr><tr><th>Leave type</th><td>${esc(typeName(r.code))}</td></tr><tr><th>From - To</th><td>${longDate(r.from_date)} - ${longDate(r.to_date)}</td></tr><tr><th>Days</th><td>${r.days}</td></tr><tr><th>Reason</th><td>${esc(r.reason || "-")}</td></tr>${r.contact ? `<tr><th>Contact</th><td>${esc(r.contact)}</td></tr>` : ""}<tr><th>Status</th><td>${badge(r.status)}</td></tr>${r.remark ? `<tr><th>Remark</th><td>${esc(r.remark)}</td></tr>` : ""}</table>`); });
    el.querySelectorAll("[data-withdraw]").forEach(a => a.onclick = async e => { e.preventDefault();
      if (!confirm("Withdraw this request?")) return;
      try { await api("leave/cancel", "POST", { request_id: +a.dataset.withdraw, reason: "Withdrawn by employee" }); toast("Request withdrawn"); refreshMe(); draw(); } catch (er) { toast(er.message); } });
    if (tab !== 0) return;

    el.querySelectorAll("[data-sub]").forEach(a => a.onclick = e => { e.preventDefault(); sub = +a.dataset.sub; draw(); });
    const hide = $("#hide-note"); if (hide) hide.onclick = e => { e.preventDefault(); hideNote = true; draw(); };
    const bind = (id, key, after) => { const n = $(id); if (n) n.oninput = n.onchange = () => { F[key] = n.value; if (after) after(); }; };
    const refreshNums = () => { const d = $("#la-days"), b = $("#la-balv"); const n = countDays(F.from, F.to, F.fs, F.ts); if (d) d.textContent = sub === 3 ? (F.from && F.to && F.to >= F.from ? Math.round((new Date(F.to) - new Date(F.from)) / 86400000) + 1 : 0) : (n || ""); if (b) b.textContent = F.code && balOf(F.code) != null ? balOf(F.code) : ""; };
    bind("#la-type", "code", refreshNums); bind("#la-from", "from", refreshNums); bind("#la-to", "to", refreshNums); bind("#la-fs", "fs", refreshNums); bind("#la-ts", "ts", refreshNums);
    bind("#la-contact", "contact"); bind("#la-reason", "reason"); bind("#la-date", "date"); bind("#la-appr", "approver");
    el.querySelectorAll('input[name="la-cancel"]').forEach(r => r.onchange = () => { F.cancelId = r.value; });
    $("#la-clear").onclick = () => { Object.assign(F, { code: "", from: "", fs: "1", to: "", ts: "2", contact: "", reason: "", date: "", cancelId: "" }); draw(); };
    $("#la-submit").onclick = async () => {
      const reason = F.reason.trim(), btn = $("#la-submit"), appr = F.approver ? +F.approver : undefined;
      const fail = m => toast(m);
      try {
        if (sub === 0) {
          if (!F.code) return fail("Select a leave type");
          if (!F.from || !F.to) return fail("Select the from and to dates");
          if (!reason) return fail("Please enter a reason");
          btn.disabled = true;
          await api("leave/apply", "POST", { code: F.code, from_date: F.from, to_date: F.to, from_session: +F.fs, to_session: +F.ts, reason, approver_id: appr, contact: F.contact });
        } else if (sub === 1) {
          if (!F.date) return fail("Select a restricted holiday");
          if (!reason) return fail("Please enter a reason");
          btn.disabled = true;
          await api("leave/rh", "POST", { date: F.date, reason, approver_id: appr });
        } else if (sub === 2) {
          if (!F.cancelId) return fail("Select the leave to cancel");
          if (!reason) return fail("Please enter a reason");
          btn.disabled = true;
          await api("leave/cancel", "POST", { request_id: +F.cancelId, reason, approver_id: appr });
        } else {
          if (!F.from || !F.to || F.to < F.from) return fail("Select the dates you worked");
          if (!reason) return fail("Please enter a reason");
          btn.disabled = true;
          for (let d = new Date(F.from + "T00:00"); dateIso(d) <= F.to; d.setDate(d.getDate() + 1)) await api("leave/compoff", "POST", { date: dateIso(d), reason, approver_id: appr });
        }
        toast("Request submitted"); refreshMe();
        Object.assign(F, { code: "", from: "", fs: "1", to: "", ts: "2", contact: "", reason: "", date: "", cancelId: "" });
        tab = 1; draw();
      } catch (er) { toast(er.message); btn.disabled = false; }
    };
  };
  await draw();
};

// ------------------------------------------------------------------ Leave Balances
P["leave-balances"] = async el => {
  const [bal, reqs, types] = await Promise.all([api("leave/balances"), api("leave/requests"), api("leave/types")]);
  const fy = fyStart(todayIso());
  const card = b => {
    const pct = b.granted ? Math.min(100, b.consumed / b.granted * 100) : 0;
    return `<div class="lb-card"><div class="lb-top"><span>${esc(b.name)}</span><span>Granted: <b>${b.granted}</b></span></div>
      <div class="lb-mid"><div class="lb-num">${b.balance < 10 && b.balance % 1 === 0 && b.balance > 0 ? pad2(b.balance) : b.balance}</div><small>Balance</small>${b.granted || b.consumed ? `<a href="#" data-lb="${esc(b.code)}">View Details</a>` : ""}</div>
      ${b.granted ? `<div class="lb-foot"><small>${b.consumed} of ${b.granted} Consumed</small><div class="lb-bar"><i style="width:${pct}%"></i></div></div>` : ""}</div>`;
  };
  el.innerHTML = `<div class="lb-tools"><button class="btn sec" type="button" id="lb-apply">Apply</button><button class="btn" type="button" id="lb-dl" aria-label="Download" title="Download">${downloadIcon()}</button><select id="lb-fy" aria-label="Financial year"><option>${fyLabel(fy)}</option></select></div>
    <div class="lb-grid">${bal.map(card).join("") || emptyBlock("emptyList", "", "No leave types are set up yet.")}</div>`;
  $("#lb-apply").onclick = () => { location.hash = "#/leave-apply"; };
  $("#lb-dl").onclick = () => downloadCsv(`Leave_Balances_${fyLabel(fy).replace(/ /g, "")}.csv`, [["Leave type", "Granted", "Consumed", "Balance"], ...bal.map(b => [b.name, b.granted, b.consumed, b.balance])]);
  el.querySelectorAll("[data-lb]").forEach(a => a.onclick = e => { e.preventDefault();
    const code = a.dataset.lb, name = (types.find(t => t.code === code) || {}).name || code, rows = reqs.filter(r => r.code === code && ["leave", "rh", "compoff_grant"].includes(r.kind));
    openDialog(`${name} - transactions`, rows.length ? table([["Category", r => LEAVE_CATEGORY[r.kind] || r.kind], ["From", r => longDate(r.from_date)], ["To", r => longDate(r.to_date)], ["Days", r => r.days], ["Status", r => badge(r.status), 1]], rows) : '<p class="mute">No transactions for this leave type yet.</p>', { wide: true }); });
};
const downloadIcon = () => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>`;

// ------------------------------------------------------------------ Leave Calendar
P["leave-calendar"] = async el => {
  let ym = localYm(), filter = "me", q = "", day = "";
  const draw = async () => {
    const c = await api("leave/calendar?month=" + ym);
    const entries = (filter === "me" ? c.mine : c.team).map(e => ({ ...e }));
    const holBy = Object.fromEntries(c.holidays.map(h => [h.date, h]));
    const today = todayIso(), covers = (e, iso) => e.from_date <= iso && e.to_date >= iso;
    const cell = x => {
      const n = entries.filter(e => covers(e, x.iso)).length, h = holBy[x.iso];
      return `<div class="lc ${x.out ? "out" : ""} ${x.iso === today ? "today" : ""} ${x.iso === day ? "sel" : ""} ${new Date(x.iso + "T00:00").getDay() === 0 || new Date(x.iso + "T00:00").getDay() === 6 ? "wknd" : ""}" data-d="${x.iso}">
        <span class="lc-n">${pad2(x.day)}</span>${h && !x.out ? `<i class="lc-dot" style="background:${h.restricted ? RESTRICTED_DOT : GENERAL_DOT}" title="${esc(h.name)}"></i>` : ""}${n && !x.out ? `<b class="lc-cnt" title="On leave">${n}</b>` : ""}</div>`;
    };
    const needle = q.trim().toLowerCase();
    const tx = entries.filter(e => (!day || covers(e, day)) && (!needle || String(e.name).toLowerCase().includes(needle)));
    const teamCount = c.team.filter(e => covers(e, today)).length;
    el.innerHTML = `<div class="lcal-top"><div><label for="lc-filter">Filter Type</label><select id="lc-filter"><option value="me" ${filter === "me" ? "selected" : ""}>Me</option><option value="team" ${filter === "team" ? "selected" : ""}>My Team</option></select></div>
        <button class="btn" type="button" id="lc-dl" aria-label="Download" title="Download">${downloadIcon()}</button></div>
      <div class="lcal"><section><div class="cal-nav"><button type="button" id="lc-prev">‹ Prev</button><b>${monthTitle(ym)}</b><button type="button" id="lc-next">Next ›</button></div>
        <div class="ac-head">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(x => `<div>${x}</div>`).join("")}</div><div class="lc-grid">${monthGrid(ym).map(cell).join("")}</div>
        <div class="lc-legend"><span>Team on Leave <b class="pillc">${teamCount}</b></span><span>Restricted Holiday <i style="background:${RESTRICTED_DOT}"></i></span><span>General Holiday <i style="background:${GENERAL_DOT}"></i></span></div></section>
        <div class="lc-side"><div class="lc-search"><input type="search" id="lc-q" placeholder="Search Employee" value="${esc(q)}" aria-label="Search employee"></div>
          <div class="lc-tx"><div class="lc-tx-h"><b>Leave Transactions (${tx.length})</b>${day ? `<a href="#" id="lc-clear">Clear ${dayNum(day)} ${monthName(day.slice(0, 7), "short")}</a>` : ""}</div>
            ${tx.length ? `<div class="tablewrap"><table><thead><tr><th>Employee</th><th>Number of days</th><th>From-To</th></tr></thead><tbody>${tx.map(e => `<tr><td>${esc(e.name)}</td><td>${e.days}</td><td>${longDate(e.from_date)} - ${longDate(e.to_date)}</td></tr>`).join("")}</tbody></table></div>` : emptyBlock("emptyList", "", "No Employees are on leave")}</div></div></div>`;
    $("#lc-filter").onchange = e => { filter = e.target.value; draw(); };
    $("#lc-prev").onclick = () => { ym = addMonths(ym, -1); day = ""; draw(); };
    $("#lc-next").onclick = () => { ym = addMonths(ym, 1); day = ""; draw(); };
    el.querySelectorAll(".lc:not(.out)").forEach(x => x.onclick = () => { day = day === x.dataset.d ? "" : x.dataset.d; draw(); });
    $("#lc-q").oninput = e => { q = e.target.value; const pos = e.target.selectionStart; draw().then(() => { const n = $("#lc-q"); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }); };
    const cl = $("#lc-clear"); if (cl) cl.onclick = e => { e.preventDefault(); day = ""; draw(); };
    $("#lc-dl").onclick = () => downloadCsv(`Leave_Calendar_${ym}.csv`, [["Employee", "Leave type", "Days", "From", "To"], ...tx.map(e => [e.name, e.code, e.days, e.from_date, e.to_date])]);
  };
  await draw();
};

// ------------------------------------------------------------------ Holiday Calendar
P.holidays = async el => {
  const hols = await api("holidays");
  const years = [...new Set([fyStart(todayIso()), ...hols.map(h => fyStart(h.date))])].sort((a, b) => b - a);
  let fy = fyStart(todayIso());
  const draw = () => {
    const months = Array.from({ length: 12 }, (_, i) => { const m = ((3 + i) % 12) + 1, y = m >= 4 ? fy : fy + 1; return `${y}-${pad2(m)}`; });
    el.innerHTML = `<div class="hc-top"><select id="hc-fy" aria-label="Financial year">${years.map(y => `<option value="${y}" ${y === fy ? "selected" : ""}>${fyLabel(y)}</option>`).join("")}</select></div>
      <div class="hc-grid">${months.map(ym => { const list = hols.filter(h => h.date.slice(0, 7) === ym);
        return `<div class="hc-card"><div class="hc-h">${monthName(ym, "short").toUpperCase()} ${ym.slice(0, 4)}</div>${list.length ? list.map(h => `<div class="hc-row"><div class="hc-d"><b>${pad2(dayNum(h.date))}</b><small>${weekdayOf(h.date)}</small></div><div class="hc-n">${esc(h.name)}${h.restricted ? ' <span class="badge">optional</span>' : ""}</div></div>`).join("") : '<div class="hc-none">No Holidays</div>'}</div>`; }).join("")}</div>`;
    $("#hc-fy").onchange = e => { fy = +e.target.value; draw(); };
  };
  draw();
};
