"use strict";
// To do pages in the greytHR style: Tasks and Review

// ------------------------------------------------------------------ Tasks
P.tasks = async el => {
  const PRIORITY = { high: "High", medium: "Medium", low: "Low" };
  const draw = async () => {
    const tasks = await api("tasks");
    const row = t => `<div class="tk ${t.done ? "done" : ""}"><input type="checkbox" data-done="${t.id}" ${t.done ? "checked" : ""} aria-label="Mark ${esc(t.title)} done">
      <div class="tk-main"><b>${esc(t.title)}</b>${t.description ? `<p>${esc(t.description)}</p>` : ""}</div>
      <span class="tk-pri ${esc(t.priority)}">${esc(PRIORITY[t.priority] || t.priority)}</span><span class="tk-due">${t.due_date ? esc(fmtComma(t.due_date)) : "No due date"}</span>
      <button class="tk-del" type="button" data-del="${t.id}" aria-label="Delete task" title="Delete">×</button></div>`;
    el.innerHTML = tasks.length
      ? `<div class="tk-top"><button class="btn" type="button" id="t-add">Add new task</button></div><div class="card tk-list">${tasks.map(row).join("")}</div>`
      : `<div class="card tk-empty">${emptyBlock("tasksBoard", "", "You haven't added any tasks yet! Start by creating new tasks or configuring checklists.", "Add new task", "t-add")}</div>`;
    $("#t-add").onclick = () => {
      openDialog("Add new task", form("tf", [{ n: "title", label: "Task" }, { n: "description", label: "Description", type: "textarea", req: false }, { n: "priority", label: "Priority", type: "select", opts: [["medium", "Medium"], ["high", "High"], ["low", "Low"]] }, { n: "due_date", label: "Due date", type: "date", req: false }], "Add task"));
      wire("tf", "tasks", () => { closeDialog(); draw(); }, d => ({ ...d, due_date: d.due_date || null }));
      const f = $("#tf-title"); if (f) f.focus();
    };
    el.querySelectorAll("[data-done]").forEach(c => c.onchange = async () => { try { await api("tasks/" + c.dataset.done, "PATCH", { done: c.checked }); draw(); } catch (e) { toast(e.message); } });
    el.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => { if (!confirm("Delete this task?")) return; try { await api("tasks/" + b.dataset.del, "DELETE"); draw(); } catch (e) { toast(e.message); } });
  };
  await draw();
};

// ------------------------------------------------------------------ Review
const REVIEW_SECTIONS = [
  ["ATTENDANCE", [["att-reg", "Attendance Regularization"], ["att-perm", "Regularization & Permission"]]],
  ["CUSTOM WORKFLOWS", [["hub", "Request Hub"]]],
  ["EMPINFO", [["resign", "Resignations"], ["helpdesk", "Helpdesk"]]],
  ["LEAVE", [["leave", "Leave"], ["leave-cancel", "Leave Cancel"], ["leave-co", "Leave Comp Off"], ["leave-rh", "Restricted Holiday"]]],
  ["LETTER", [["letter", "Letter Signature Approval"]]],
];
const REVIEW_EMPTY = {
  "att-reg": "Hey, you have no regularization records to view",
  "att-perm": "No Review Items for Permission",
  hub: "Hey, you have no workflows to show",
  resign: "Hey, you have no resignation records to show",
  helpdesk: "No helpdesk review items",
  leave: "It's empty here! Your pending leave reviews will appear here.",
  "leave-cancel": "It's empty here! Your pending leave reviews will appear here.",
  "leave-co": "It's empty here! Your pending leave reviews will appear here.",
  "leave-rh": "No Review Items for Restricted Holiday",
  letter: "You have no active requests to review.",
};
const reviewSection = it =>
  it.type === "regularization" ? (it.kind === "permission" ? "att-perm" : "att-reg")
  : it.type === "request" ? ({ leave: "leave", cancel: "leave-cancel", compoff_grant: "leave-co", rh: "leave-rh" }[it.kind] || "leave")
  : ["reimbursement", "loan"].includes(it.type) ? "hub" : it.type === "resignation" ? "resign" : it.type === "ticket" ? "helpdesk" : "";
const reviewDate = it => String(it.from_date || it.date || it.bill_date || it.last_day || it.created_at || "").slice(0, 10);

P.review = async el => {
  let tab = 0, sec = "", from = "", to = "", q = "";
  const types = await api("leave/types");
  const typeName = c => (types.find(t => t.code === c) || {}).name || c;

  const label = it => it.type === "request" ? (it.kind === "rh" ? "Restricted Holiday" : it.kind === "compoff_grant" ? "Comp Off Grant" : it.kind === "cancel" ? `Cancel ${typeName(it.code)}` : typeName(it.code))
    : it.type === "regularization" ? (it.kind === "permission" ? "Permission" : "Regularization")
    : it.type === "reimbursement" ? `Reimbursement: ${it.category}` : it.type === "loan" ? "Loan request" : it.type === "resignation" ? "Resignation" : `Ticket #${it.id}`;
  const detail = it => it.type === "request" ? `${longDate(it.from_date)}${it.to_date !== it.from_date ? " - " + longDate(it.to_date) : ""}${it.days ? ` (${it.days} day${it.days === 1 ? "" : "s"})` : ""}`
    : it.type === "regularization" ? `${longDate(it.date)}${it.in_time ? ` · ${it.in_time} - ${it.out_time || ""}` : ""}`
    : it.type === "reimbursement" ? `${inr(it.amount)} · bill ${longDate(it.bill_date)}` : it.type === "loan" ? `${inr(it.amount)} for ${it.tenure_months} months`
    : it.type === "resignation" ? `Last day ${longDate(it.last_day)}` : esc(it.subject || "");
  const reasonOf = it => it.reason || it.description || it.body || it.message || "";

  const draw = async () => {
    const all = await api(tab === 0 ? "review" : "review?status=closed");
    const active = tab === 0 ? all : await api("review");
    const countBy = list => { const c = {}; list.forEach(i => { const s = reviewSection(i); c[s] = (c[s] || 0) + 1; }); return c; };
    const counts = countBy(active);                       // badges always show what is waiting
    if (!sec) { const here = countBy(all); sec = Object.keys(here).find(k => here[k]) || "att-reg"; }   // open on a section that has items in this tab
    const needle = q.trim().toLowerCase();
    const items = all.filter(i => reviewSection(i) === sec && (!from || reviewDate(i) >= from) && (!to || reviewDate(i) <= to) && (!needle || String(i.emp_name).toLowerCase().includes(needle)));

    const card = it => {
      const st = tab === 0 ? ["PENDING", "warn"] : it.status === "approved" ? ["APPROVED", "ok"] : it.status === "rejected" ? ["REJECTED", "bad"] : [String(it.status).toUpperCase(), "mute"];
      const actions = tab !== 0 ? "" : it.type === "ticket"
        ? `<label class="rv-ts">Status <select data-ticket="${it.id}">${["open", "in_progress", "resolved", "closed"].map(s => `<option value="${s}" ${s === it.status ? "selected" : ""}>${titleCase(s)}</option>`).join("")}</select></label>`
        : `<button class="btn sm" type="button" data-act="approve" data-t="${it.type}" data-i="${it.id}">Approve</button><button class="btn bad sm" type="button" data-act="reject" data-t="${it.type}" data-i="${it.id}">Reject</button>`;
      return rcard(`${it.type}-${it.id}`, [["Employee", it.emp_name], ["Request", label(it)], ["Details", detail(it)]], st,
        `<div class="rc-line"><span>Reason :</span> <b>${esc(reasonOf(it) || "-")}</b></div>${it.type === "ticket" ? `<div class="rc-line"><span>Category :</span> <b>${esc(it.category)}</b></div>` : ""}
         <div class="rc-foot"><div><small>Applied on</small><b>${esc(fmtComma(it.created_at))}</b></div><div class="rv-acts">${actions}</div></div>`);
    };
    const nav = REVIEW_SECTIONS.map(([h, links]) => `<div class="rv-grp"><small>${h}</small>${links.map(([k, n]) => `<a href="#" data-sec="${k}" class="${k === sec ? "on" : ""}">${n}${counts[k] ? `<i class="rv-n">${counts[k]}</i>` : ""}</a>`).join("")}</div>`).join("");

    el.innerHTML = `<div class="rv"><nav class="rv-nav">${nav}</nav>
      <section class="rv-main"><div class="seg-wrap"><div class="seg"><button type="button" data-seg="0" class="${tab === 0 ? "on" : ""}">Active</button><button type="button" data-seg="1" class="${tab === 1 ? "on" : ""}">Closed</button></div></div>
        <div class="rv-filters"><div class="rv-range"><input type="date" id="rv-from" value="${from}" aria-label="From date"><span>to</span><input type="date" id="rv-to" value="${to}" aria-label="To date"></div><input type="search" id="rv-q" placeholder="Search Employee" value="${esc(q)}" aria-label="Search employee"></div>
        <div class="rv-box">${items.length ? `<div class="rlist">${items.map(card).join("")}</div>` : emptyBlock("emptyList", "", REVIEW_EMPTY[sec] || "Nothing to review.")}</div></section></div>`;

    wireSeg(el, i => { tab = i; sec = ""; draw(); });
    wireRcards(el);
    el.querySelectorAll("[data-sec]").forEach(a => a.onclick = e => { e.preventDefault(); sec = a.dataset.sec; draw(); });
    $("#rv-from").onchange = e => { from = e.target.value; draw(); };
    $("#rv-to").onchange = e => { to = e.target.value; draw(); };
    $("#rv-q").oninput = e => { q = e.target.value; const pos = e.target.selectionStart; draw().then(() => { const n = $("#rv-q"); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }); };
    el.querySelectorAll("[data-act]").forEach(b => b.onclick = async e => {
      e.stopPropagation(); b.disabled = true;
      try {
        if (b.dataset.t === "resignation") await api(`admin/resignations/${b.dataset.i}`, "POST", { action: b.dataset.act });
        else await api(`review/${b.dataset.t}/${b.dataset.i}`, "POST", { action: b.dataset.act });
        toast(b.dataset.act === "approve" ? "Approved" : "Rejected"); refreshMe(); draw();
      } catch (er) { toast(er.message); b.disabled = false; }
    });
    el.querySelectorAll("[data-ticket]").forEach(s => s.onchange = async () => { try { await api("admin/tickets/" + s.dataset.ticket, "PATCH", { status: s.value }); toast("Ticket updated"); draw(); } catch (er) { toast(er.message); } });
  };
  await draw();
};
