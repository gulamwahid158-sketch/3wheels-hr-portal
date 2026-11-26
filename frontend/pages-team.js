"use strict";
// My Team: what a reporting manager sees about the people under them (attendance and pending requests, work details only)
P["my-team"] = async el => {
  let scope = "direct", ym = localYm(), q = "";
  const holidays = await api("holidays");
  const draw = async () => {
    const d = await api(`team?scope=${scope}&month=${ym}`);
    const m = d.members;
    if (!m.length) { el.innerHTML = '<h1>My Team</h1><div class="card"><p class="mute">Nobody reports to you.</p></div>'; return; }
    const onLeave = x => x.today && ["CL", "CO", "LOP"].includes(x.today.status);
    const isIn = x => x.today && x.today.first_in;
    const tile = (label, value, color) => `<div class="card" style="border-top:3px solid ${color}"><span class="mute">${label}</span><div class="stat">${value}</div></div>`;
    const todayCell = x => isIn(x) ? `<b style="color:#2f7a3f">In ${esc(x.today.first_in)}</b>${x.today.last_out && x.today.last_out !== x.today.first_in ? ` <span class="mute">· last ${esc(x.today.last_out)}</span>` : ""}`
      : onLeave(x) ? `<span class="badge">${esc(x.today.status)}</span>` : x.today && x.today.status === "H" ? '<span class="mute">Holiday</span>' : '<span style="color:#c62828">Not punched yet</span>';
    // attendance of a person this month: present days count fully, half days half
    const rate = x => { const n = x.present + x.half_day + x.absent; return n ? Math.round((x.present + x.half_day / 2) / n * 100) : null; };
    const bar = v => v == null ? '<span class="mute">-</span>' : `<div style="display:flex;align-items:center;gap:8px;min-width:120px"><div style="flex:1;height:8px;border-radius:6px;background:var(--line);overflow:hidden"><i style="display:block;height:100%;width:${v}%;background:${v >= 75 ? "#388e3c" : v >= 50 ? "#b8860b" : "#c62828"}"></i></div><b style="font-size:12px">${v}%</b></div>`;
    const ranked = m.filter(x => rate(x) != null).sort((a, b) => rate(b) - rate(a) || b.minutes - a.minutes);
    const arrived = m.filter(isIn).sort((a, b) => a.today.first_in.localeCompare(b.today.first_in));
    const teamRate = (() => { const t = m.reduce((a, x) => ({ p: a.p + x.present, h: a.h + x.half_day, a: a.a + x.absent }), { p: 0, h: 0, a: 0 }); const n = t.p + t.h + t.a; return n ? Math.round((t.p + t.h / 2) / n * 100) : null; })();
    const dayChart = () => {
      const off = new Set(holidays.filter(h => !h.restricted).map(h => h.date));
      const days = d.daily.filter(x => !off.has(x.date) && x.present + x.half_day + x.absent + x.leave);
      if (!days.length) return '<p class="mute">No working day recorded this month.</p>';
      const H = 130, part = (n, color) => n ? `<i style="display:block;height:${n / m.length * H}px;background:${color}"></i>` : "";
      return `<div style="display:flex;align-items:flex-end;gap:4px;overflow-x:auto;padding-bottom:4px">${days.map(x => `<div style="flex:1;min-width:18px;text-align:center" title="${longDate(x.date)}: ${x.present} present, ${x.half_day} half day, ${x.absent} absent, ${x.leave} leave">
        <div style="height:${H}px;display:flex;flex-direction:column;justify-content:flex-end;border-radius:4px;overflow:hidden">${part(x.leave, "#1565c0")}${part(x.absent, "#e57373")}${part(x.half_day, "#e0b040")}${part(x.present, "#4caf50")}</div><small class="mute">${dayNum(x.date)}</small></div>`).join("")}</div>
        <p class="mute" style="font-size:12px;margin-top:8px"><b style="color:#4caf50">■</b> Present &nbsp; <b style="color:#e0b040">■</b> Half day &nbsp; <b style="color:#e57373">■</b> Absent &nbsp; <b style="color:#1565c0">■</b> Leave</p>`;
    };
    const t0 = new Date(d.today + "T00:00");
    const birthdays = m.filter(x => /^\d{2}-\d{2}$/.test(x.birthday)).map(x => { const next = new Date(t0.getFullYear(), +x.birthday.slice(0, 2) - 1, +x.birthday.slice(3)); if (next < t0) next.setFullYear(next.getFullYear() + 1); return { ...x, next, days: Math.round((next - t0) / 86400000) }; }).filter(x => x.days <= 30).sort((a, b) => a.days - b.days);
    const joiners = m.filter(x => x.join_date && x.join_date <= d.today && (t0 - new Date(x.join_date + "T00:00")) / 86400000 <= 30).sort((a, b) => b.join_date.localeCompare(a.join_date));
    const coming = holidays.filter(h => h.date >= d.today && !/^Sunday/.test(h.name)).slice(0, 5);
    const scroll = html => `<div style="max-height:300px;overflow:auto">${html}</div>`;
    const two = 'class="grid" style="grid-template-columns:repeat(auto-fit,minmax(360px,1fr))"';
    const three = 'class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr))"';
    const needle = q.trim().toLowerCase();
    const list = m.filter(x => !needle || x.name.toLowerCase().includes(needle) || String(x.emp_no).toLowerCase().includes(needle));
    const cols = [["Name", x => `<a href="#" class="emp-att" data-team="${x.id}" title="Attendance of ${esc(x.name)}"><b>${esc(x.name)}</b></a><br><small class="mute">${esc(x.emp_no)} · ${esc(x.designation || "-")}</small>`, 1],
      ...(scope === "all" ? [["Reports to", x => x.manager_name || "-"]] : []),
      ["Today", todayCell, 1], ["Present", x => x.present], ["Half Day", x => x.half_day], ["Absent", x => x.absent], ["Leave", x => x.leave], ["Hours", x => hhmm(x.minutes)], ["Attendance", x => bar(rate(x)), 1]];
    el.innerHTML = `<h1>My Team</h1>
      <div class="card" style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">
        <div role="group" aria-label="Who to show"><button type="button" class="btn ${scope === "direct" ? "" : "sec"}" data-scope="direct">Direct reports</button> <button type="button" class="btn ${scope === "all" ? "" : "sec"}" data-scope="all">Everyone under me</button></div>
        <label style="display:flex;gap:8px;align-items:center">Month <input type="month" id="tm-month" value="${ym}" style="width:170px"></label>
        <input type="search" id="tm-q" placeholder="Search name or ID" value="${esc(q)}" style="max-width:220px" aria-label="Search the team">
      </div>
      <div class="grid">${tile("Team members", m.length, "#1f4e78")}${tile("Punched in today", m.filter(isIn).length, "#388e3c")}${tile("Not punched yet", m.filter(x => !isIn(x) && !onLeave(x) && !(x.today && x.today.status === "H")).length, "#c62828")}${tile("On leave today", m.filter(onLeave).length, "#1565c0")}${tile("Requests pending", d.pending.length, "#b8860b")}${tile("Team attendance (month)", teamRate == null ? "-" : teamRate + "%", "#6a1b9a")}</div>
      <div ${two}>
        <div class="card"><h2>Arrived today (${arrived.length})</h2>${scroll(table([["Name", x => x.name], ["First in", x => x.today.first_in], ["Last punch", x => x.today.last_out && x.today.last_out !== x.today.first_in ? x.today.last_out : "-"]], arrived, "No one from the team has punched in yet."))}</div>
        <div class="card"><h2>Day by day - ${monthTitle(ym)}</h2>${dayChart()}</div>
      </div>
      <div ${two}>
        <div class="card"><h2>Best attendance</h2>${table([["Name", x => x.name], ["Attendance", x => bar(rate(x)), 1], ["Hours", x => hhmm(x.minutes)]], ranked.slice(0, 5), "No attendance recorded yet.")}</div>
        <div class="card"><h2>Needs attention</h2>${table([["Name", x => x.name], ["Absent", x => x.absent], ["Half day", x => x.half_day], ["Attendance", x => bar(rate(x)), 1]], ranked.filter(x => rate(x) < 75).slice().reverse().slice(0, 5), "Everyone is at 75% or more.")}</div>
      </div>
      <div class="card"><h2>Team - ${monthTitle(ym)}</h2><p class="mute">Click a name to see that person's calendar and in / out times.</p>${table(cols, list, "No one matches your search.")}</div>
      <div class="card"><h2>Pending requests from your team (${d.pending.length})</h2>${table([["Employee", r => r.name], ["Request", r => r.type], ["Details", r => r.detail], ["Reason", r => r.reason || "-"]], d.pending, "Nothing is waiting.")}${d.pending.length ? '<p><a href="#/review">Open Review to approve the ones sent to you</a></p>' : ""}</div>
      <div ${three}>
        <div class="card"><h2>Upcoming leave</h2>${scroll(table([["Name", r => r.name], ["Type", r => r.code], ["From", r => fdate(r.from_date)], ["To", r => fdate(r.to_date)]], d.upcoming_leave, "No approved leave coming up."))}</div>
        <div class="card"><h2>Birthdays (30 days)</h2>${scroll(table([["Name", x => x.name], ["Date", x => x.next.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })], ["In", x => x.days === 0 ? "Today 🎂" : `${x.days} day(s)`]], birthdays, "No birthdays in the next 30 days."))}</div>
        <div class="card"><h2>New in the team (30 days)</h2>${scroll(table([["Name", x => x.name], ["Designation", x => x.designation || "-"], ["Joined", x => fdate(x.join_date)]], joiners, "No one joined in the last 30 days."))}</div>
        <div class="card"><h2>Upcoming holidays</h2>${table([["Date", h => fdate(h.date)], ["Holiday", h => h.name]], coming, "No holidays listed.")}</div>
      </div>`;
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
