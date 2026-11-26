"use strict";
// My Team: what a reporting manager sees about the people under them (attendance and pending requests, work details only)
P["my-team"] = async el => {
  let scope = "direct", ym = localYm(), q = "";
  const draw = async () => {
    const d = await api(`team?scope=${scope}&month=${ym}`);
    const m = d.members;
    if (!m.length) { el.innerHTML = '<h1>My Team</h1><div class="card"><p class="mute">Nobody reports to you.</p></div>'; return; }
    const onLeave = x => x.today && ["CL", "CO", "LOP"].includes(x.today.status);
    const isIn = x => x.today && x.today.first_in;
    const tile = (label, value, color) => `<div class="card" style="border-top:3px solid ${color}"><span class="mute">${label}</span><div class="stat">${value}</div></div>`;
    const todayCell = x => isIn(x) ? `<b style="color:#2f7a3f">In ${esc(x.today.first_in)}</b>${x.today.last_out && x.today.last_out !== x.today.first_in ? ` <span class="mute">· last ${esc(x.today.last_out)}</span>` : ""}`
      : onLeave(x) ? `<span class="badge">${esc(x.today.status)}</span>` : x.today && x.today.status === "H" ? '<span class="mute">Holiday</span>' : '<span style="color:#c62828">Not punched yet</span>';
    const needle = q.trim().toLowerCase();
    const list = m.filter(x => !needle || x.name.toLowerCase().includes(needle) || String(x.emp_no).toLowerCase().includes(needle));
    const cols = [["Name", x => `<a href="#" class="emp-att" data-team="${x.id}" title="Attendance of ${esc(x.name)}"><b>${esc(x.name)}</b></a><br><small class="mute">${esc(x.emp_no)} · ${esc(x.designation || "-")}</small>`, 1],
      ...(scope === "all" ? [["Reports to", x => x.manager_name || "-"]] : []),
      ["Today", todayCell, 1], ["Present", x => x.present], ["Half Day", x => x.half_day], ["Absent", x => x.absent], ["Leave", x => x.leave], ["Hours", x => hhmm(x.minutes)]];
    el.innerHTML = `<h1>My Team</h1>
      <div class="card" style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">
        <div role="group" aria-label="Who to show"><button type="button" class="btn ${scope === "direct" ? "" : "sec"}" data-scope="direct">Direct reports</button> <button type="button" class="btn ${scope === "all" ? "" : "sec"}" data-scope="all">Everyone under me</button></div>
        <label style="display:flex;gap:8px;align-items:center">Month <input type="month" id="tm-month" value="${ym}" style="width:170px"></label>
        <input type="search" id="tm-q" placeholder="Search name or ID" value="${esc(q)}" style="max-width:220px" aria-label="Search the team">
      </div>
      <div class="grid">${tile("Team members", m.length, "#1f4e78")}${tile("Punched in today", m.filter(isIn).length, "#388e3c")}${tile("Not punched yet", m.filter(x => !isIn(x) && !onLeave(x) && !(x.today && x.today.status === "H")).length, "#c62828")}${tile("On leave today", m.filter(onLeave).length, "#1565c0")}${tile("Requests pending", d.pending.length, "#b8860b")}</div>
      <div class="card"><h2>Team - ${monthTitle(ym)}</h2><p class="mute">Click a name to see that person's calendar and in / out times.</p>${table(cols, list, "No one matches your search.")}</div>
      <div class="card"><h2>Pending requests from your team (${d.pending.length})</h2>${table([["Employee", r => r.name], ["Request", r => r.type], ["Details", r => r.detail], ["Reason", r => r.reason || "-"]], d.pending, "Nothing is waiting.")}${d.pending.length ? '<p><a href="#/review">Open Review to approve the ones sent to you</a></p>' : ""}</div>`;
    el.querySelectorAll("[data-scope]").forEach(b => b.onclick = () => { scope = b.dataset.scope; draw(); });
    $("#tm-month").onchange = e => { if (e.target.value) { ym = e.target.value; draw(); } };
    $("#tm-q").onchange = e => { q = e.target.value; draw(); };
    el.querySelectorAll("[data-team]").forEach(a => a.onclick = e => {
      e.preventDefault();
      const x = m.find(y => y.id === +a.dataset.team);
      if (x) showEmpAttendance(x, month => `team/${x.id}/attendance?month=${month}`);
    });
  };
  await draw();
};
