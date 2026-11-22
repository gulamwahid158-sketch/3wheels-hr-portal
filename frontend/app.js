"use strict";
const $ = (s, r = document) => r.querySelector(s);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = n => "₹" + Number(n || 0).toLocaleString("en-IN");
const fdate = s => s ? new Date(s.length === 10 ? s + "T00:00" : s.replace(" ", "T")).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "-";
let ME = null;
let MAINT = false, _maintTimer = null;

async function api(path, method = "GET", data) {
  const r = await fetch("/api/" + path, { method, headers: { "Content-Type": "application/json" }, body: data ? JSON.stringify(data) : undefined });
  // 502/503/504 = server or database temporarily unavailable -> maintenance screen
  if ([502, 503, 504].includes(r.status)) { MAINT = true; render(); throw new Error("The portal is under maintenance"); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "login") { ME = null; render(); throw new Error("Please log in"); }
  if (!r.ok) throw new Error(j.error || "Request failed");
  return j;
}
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
    let inp = f.type === "select" ? `<select ${c}>${opts}</select>`
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

// ---------------- pages ----------------
const P = {};
P.home = async el => {
  const h = await api("home");
  el.innerHTML = `<div class="home-hero"><h1>Hi ${esc(ME.name.split(" ")[0])} 👋</h1><p class="mute">Here's your day at a glance.</p></div>
  <div class="grid">
   <div class="card home-card accent-teal"><h2>🌿 Leave balance</h2>${h.balances.filter(b => b.code !== "LOP").map(b => `<p><span class="stat">${b.balance}</span> <span class="mute">${esc(b.name)} · ${b.consumed} of ${b.granted} used</span></p>`).join("")}<a href="#/leave-apply">Apply Leave →</a></div>
   <div class="card home-card accent-blue"><h2>📅 Upcoming holidays</h2>${h.holidays.map(x => `<p><b>${fdate(x.date)}</b> ${esc(x.name)} ${x.restricted ? '<span class="badge">optional</span>' : ""}</p>`).join("") || '<p class="mute">None</p>'}</div>
   <div class="card home-card accent-amber"><h2>✅ Review</h2>${h.pending_reviews ? `<p><span class="stat">${h.pending_reviews}</span> waiting for you</p><a href="#/review">Open →</a>` : '<p class="mute">Hurrah! Nothing to review.</p>'}</div>
   <div class="card home-card accent-green"><h2>💰 Latest payslip</h2><button class="btn" id="reqPayslip">Request Payslip</button></div>
   <div class="card home-card accent-purple"><h2>📝 My tasks</h2>${h.tasks.map(t => `<p>• ${esc(t.title)} <span class="mute">${fdate(t.due_date)}</span></p>`).join("") || '<p class="mute">All clear.</p>'}</div>
   <div class="card home-card accent-rose"><h2>📌 Track</h2>${h.tracking.map(t => `<p>${esc(t.kind)} ${badge(t.status)}</p>`).join("") || '<p class="mute">Nothing new.</p>'}</div>
  </div>
  ${h.birthdays.length ? `<div class="card home-bday">🎂 Birthday today: ${h.birthdays.map(b => esc(b.name)).join(", ")}</div>` : ""}`;
  $("#reqPayslip").onclick = () => { location.hash = "#/payslips"; render(); };
};

P.engage = async el => {
  const draw = async () => {
    const [feed, people] = [await api("feed"), await api("people")];
    const today = new Date();
    const md = d => (d.getMonth()+1).toString().padStart(2,"0")+"-"+d.getDate().toString().padStart(2,"0");
    const todayMd = md(today);
    const bdays = people.filter(p => p.dob).map(p => ({ name: p.name, dob: p.dob }));
    const todayB = bdays.filter(b => b.dob === todayMd);
    const upcoming = bdays.filter(b => {
      if (b.dob === todayMd) return false;
      const [m, dd] = b.dob.split("-").map(Number);
      const d = new Date(today.getFullYear(), m-1, dd);
      if (d < today) d.setFullYear(today.getFullYear()+1);
      const diff = (d - today) / 86400000;
      return diff > 0 && diff <= 7;
    });
    const completed = bdays.filter(b => {
      const [m, dd] = b.dob.split("-").map(Number);
      const d = new Date(today.getFullYear(), m-1, dd);
      if (d > today) return false;
      const diff = (today - d) / 86400000;
      return diff > 0 && diff <= 7;
    });
    const canPost = ["hr","ceo","coo","cpo"].includes(ME.role);
    el.innerHTML = `<div class="engage-hero"><h1>Engage</h1><p class="mute">Share updates, kudos & polls with your team.</p></div>
${todayB.length ? `<div class="bday-celebrate">🎂🎉 Happy Birthday ${todayB.map(b=>esc(b.name)).join(", ")}! 🎉🎂</div>` : ""}
    <div class="bday-bar">
      <div class="bday-col"><h3>🎂 Today's Birthday</h3>${todayB.length ? todayB.map(b=>`<span class="bday-chip today">${esc(b.name)}</span>`).join("") : '<span class="mute">None</span>'}</div>
      <div class="bday-col"><h3>🎉 Upcoming Birthday</h3>${upcoming.length ? upcoming.map(b=>`<span class="bday-chip up">${esc(b.name)}</span>`).join("") : '<span class="mute">None</span>'}</div>
    </div>
    ${canPost ? `<div class="card engage-compose"><h2>✍️ Create post</h2><form id="pf"><textarea name="body" rows="3" required aria-label="Post text" placeholder="What's on your mind?"></textarea>
      <label>Poll options (comma separated, leave empty for a normal post)</label><input name="opts" aria-label="Poll options" placeholder="Option 1, Option 2"><p class="err" id="pf-err"></p><button class="btn">Post</button></form></div>` : ""}
    ${feed.map(p => `<div class="card engage-post"><div class="post-head"><div class="avatar sm">${esc(p.author[0])}</div><div><b>${esc(p.author)}</b><br><span class="mute">${fdate(p.created_at)}</span></div></div><p class="post-body">${esc(p.body)}</p>
      ${p.type === "poll" ? `<div class="poll">${p.options.split("|").map(o => { const c = p.results[o] || 0, tot = Object.values(p.results).reduce((a, b) => a + b, 0) || 1; return `<div class="poll-opt"><button class="btn sec sm" data-vote="${p.id}" data-o="${esc(o)}">${p.my_vote === o ? "✓ " : ""}${esc(o)}</button> <span class="mute">${c} vote(s)</span><div class="bar"><i style="width:${c / tot * 100}%"></i></div></div>`; }).join("")}</div>` : ""}</div>`).join("")}`;
    if (canPost) {
      $("#pf").onsubmit = async e => {
        e.preventDefault(); const f = new FormData(e.target), opts = (f.get("opts") || "").split(",").map(s => s.trim()).filter(Boolean);
        try { await api("feed", "POST", { body: f.get("body"), type: opts.length ? "poll" : "post", options: opts }); draw(); } catch (er) { $("#pf-err").textContent = er.message; }
      };
    }
    el.querySelectorAll("[data-vote]").forEach(b => b.onclick = async () => { await api(`feed/${b.dataset.vote}/vote`, "POST", { option: b.dataset.o }); draw(); });
  };
  draw();
};

async function peopleOpts() { return (await api("people")).filter(p => p.id !== ME.id).map(p => [p.id, p.name]); }
P.kudos = async el => {
  const draw = async () => {
    const [k, ppl] = [await api("kudos"), await peopleOpts()];
    el.innerHTML = `<h1>Kudos</h1><div class="card"><h2>Give kudos</h2>${form("kf", [{ n: "to_id", label: "To", type: "select", opts: ppl }, { n: "value", label: "Value", type: "select", opts: ["Ownership", "Teamwork", "Innovation", "Customer focus"].map(x => [x, x]) }, { n: "message", label: "Message", type: "textarea" }], "Give")}</div>
    <div class="card">${table([["From", r => r.from_name], ["To", r => r.to_name], ["Value", r => r.value], ["Message", r => r.message], ["Date", r => fdate(r.created_at)]], k)}</div>`;
    wire("kf", "kudos", draw);
  };
  draw();
};
P.feedback = async el => {
  const draw = async () => {
    const [f, ppl] = [await api("feedback"), await peopleOpts()];
    el.innerHTML = `<h1>Feedback</h1><div class="card"><h2>Give feedback</h2>${form("ff", [{ n: "to_id", label: "To", type: "select", opts: ppl }, { n: "message", label: "Feedback", type: "textarea" }])}</div>
    <div class="card"><h2>Received <span class="mute">(sender is anonymous)</span></h2>${table([["Feedback", r => r.message], ["Date", r => fdate(r.created_at)]], f.received)}</div>
    <div class="card"><h2>Given</h2>${table([["To", r => r.to_name], ["Feedback", r => r.message], ["Date", r => fdate(r.created_at)]], f.given)}</div>`;
    wire("ff", "feedback", draw);
  };
  draw();
};

P.tasks = async el => {
  const draw = async () => {
    const t = await api("tasks");
    el.innerHTML = `<h1>Tasks</h1><div class="card">${form("tf", [{ n: "title", label: "Task" }, { n: "priority", label: "Priority", type: "select", opts: [["low", "Low"], ["medium", "Medium"], ["high", "High"]] }, { n: "due_date", label: "Due", type: "date", req: false }], "Add task")}</div>
    <div class="card">${table([["", r => `<input type="checkbox" style="width:auto" data-done="${r.id}" ${r.done ? "checked" : ""} aria-label="Done">`, 1], ["Task", r => r.done ? `<s>${esc(r.title)}</s>` : esc(r.title), 1], ["Priority", r => r.priority], ["Due", r => fdate(r.due_date)], ["", r => `<button class="btn sec sm" data-del="${r.id}">Delete</button>`, 1]], t)}</div>`;
    wire("tf", "tasks", draw);
    el.querySelectorAll("[data-done]").forEach(c => c.onchange = async () => { await api("tasks/" + c.dataset.done, "PATCH", { done: c.checked }); draw(); });
    el.querySelectorAll("[data-del]").forEach(c => c.onclick = async () => { await api("tasks/" + c.dataset.del, "DELETE"); draw(); });
  };
  draw();
};

const desc = r => r.type === "request" ? `${r.kind === "cancel" ? "Cancel " : ""}${r.kind} ${r.code} ${r.from_date}→${r.to_date} (${r.days}d): ${r.reason || ""}`
  : r.type === "regularization" ? `${r.kind} ${r.date} ${r.in_time || ""}-${r.out_time || ""}: ${r.reason}`
  : r.type === "reimbursement" ? `${r.category} ${inr(r.amount)} (${r.bill_date})` : `Loan ${inr(r.amount)} for ${r.tenure_months} months`;
P.review = async el => {
  const draw = async () => {
    const r = await api("review");
    el.innerHTML = `<h1>Review</h1><div class="card">${table([["Employee", x => x.emp_name], ["Type", x => x.type], ["Details", x => desc(x)], ["", x => `<button class="btn sm" data-a="approve" data-t="${x.type}" data-i="${x.id}">Approve</button> <button class="btn bad sm" data-a="reject" data-t="${x.type}" data-i="${x.id}">Reject</button>`, 1]], r, "Hurrah! You've nothing to review.")}</div>`;
    el.querySelectorAll("[data-a]").forEach(b => b.onclick = async () => { try { await api(`review/${b.dataset.t}/${b.dataset.i}`, "POST", { action: b.dataset.a }); toast("Done"); refreshMe(); draw(); } catch (e) { toast(e.message); } });
  };
  draw();
};

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
// ---- leave
function approvalBanner(info) {
  const backups = (info.backups || []).map(b => `<b>${esc(b.name)}</b> <span class="badge ${esc(b.role)}">${esc(titleCase(b.role))}</span>`).join(", ") || '<span class="mute">—</span>';
  return `<div class="card" style="border-left:4px solid var(--brand)">
    <b>Who approves this</b>
    <p class="mute" style="margin:6px 0 0">
      ${info.manager
      ? `Goes first to your reporting manager, <b>${esc(info.manager.name)}</b> (${esc(info.manager.designation || "Manager")}).`
      : `<b>No reporting manager is assigned to you</b> — your request goes straight to HR/Executive approval.`}
      <br>Backup approvers who can also approve or reject it anytime (e.g. if your manager is unavailable or you have none assigned): ${backups}
    </p>
  </div>`;
}
P["leave-apply"] = async el => {
  let tab = 0;
  const draw = async () => {
    const [types, reqs, bal, hol, approvers] = await Promise.all([api("leave/types"), api("leave/requests"), api("leave/balances"), api("holidays"), api("approval-info")]);
    const mine = k => reqs.filter(r => (Array.isArray(k) ? k : [k]).includes(r.kind));
    const sess = [["1", "Session 1"], ["2", "Session 2"]];
    const hist = (rows, cols) => `<div class="card"><h2>History</h2>${table(cols, rows)}</div>`;
    let inner = "";
    const approverOpts = [];
if (approvers.manager) approverOpts.push([approvers.manager.id, approvers.manager.name + " (Manager)"]);
approvers.backups.forEach(b => approverOpts.push([b.id, b.name + " (" + b.role.toUpperCase() + ")"]));
// ...
inner = "";
if (tab === 0) inner = `<div class="card"><p class="mute">${bal.map(b => `${esc(b.name)}: <b>${b.balance}</b>`).join(" · ")}</p>${form("lf", [{ n: "code", label: "Leave type", type: "select", opts: types.map(t => [t.code, t.name]) }, { n: "approver_id", label: "Approver", type: "select", opts: approverOpts }, { n: "from_date", label: "From", type: "date" }, { n: "from_session", label: "Session", type: "select", opts: sess }, { n: "to_date", label: "To", type: "date" }, { n: "to_session", label: "Session", type: "select", opts: sess.slice().reverse() }, { n: "reason", label: "Reason", type: "textarea" }], "Apply")}</div>` + hist(mine("leave"), [["Type", r => r.code], ["From", r => fdate(r.from_date)], ["To", r => fdate(r.to_date)], ["Days", r => r.days], ["Reason", r => r.reason], ["Status", r => badge(r.status), 1]]);
    if (tab === 1) inner = `<div class="card">${form("rf", [{ n: "date", label: "Restricted holiday", type: "select", opts: hol.filter(h => h.restricted).map(h => [h.date, h.name + " (" + fdate(h.date) + ")"]) }, { n: "reason", label: "Reason", type: "textarea" }], "Apply")}</div>` + hist(mine("rh"), [["Date", r => fdate(r.from_date)], ["Reason", r => r.reason], ["Status", r => badge(r.status), 1]]);
    if (tab === 2) {
      const cancellable = mine(["leave", "rh"]).filter(r => ["approved", "pending"].includes(r.status));
      inner = `<div class="card">${cancellable.length ? form("cf2", [{ n: "request_id", label: "Leave to cancel", type: "select", opts: cancellable.map(r => [r.id, `${r.code} ${fdate(r.from_date)}→${fdate(r.to_date)} (${r.status})`]) }, { n: "reason", label: "Reason", type: "textarea" }], "Request cancellation") : '<p class="mute">No cancellable leave.</p>'}</div>` + hist(mine("cancel"), [["Leave", r => `${r.code} ${fdate(r.from_date)}→${fdate(r.to_date)}`], ["Reason", r => r.reason], ["Status", r => badge(r.status), 1]]);
    }
    if (tab === 3) inner = `<div class="card"><p class="mute">Claim a comp-off for a day you worked on an off day or holiday.</p>${form("of", [{ n: "date", label: "Worked on", type: "date" }, { n: "reason", label: "Reason", type: "textarea" }], "Request grant")}</div>` + hist(mine("compoff_grant"), [["Worked on", r => fdate(r.from_date)], ["Reason", r => r.reason], ["Status", r => badge(r.status), 1]]);
    el.innerHTML = `<h1>Leave Apply</h1>${approvalBanner(approvers)}${tabs(["Leave", "Restricted Holiday", "Leave Cancel", "Comp Off Grant"], tab)}${inner}`;
    wireTabs(i => { tab = i; draw(); });
    wire("lf", "leave/apply", draw, d => ({ ...d, approver_id: d.approver_id ? +d.approver_id : undefined })); wire("rf", "leave/rh", draw); wire("cf2", "leave/cancel", draw, d => ({ ...d, request_id: +d.request_id })); wire("of", "leave/compoff", draw);
  };
  draw();
};
P["leave-balances"] = async el => {
  const b = await api("leave/balances");
  el.innerHTML = `<h1>Leave Balances</h1><div class="grid">${b.map(x => `<div class="card"><h2>${esc(x.name)}</h2><div class="stat">${x.balance}</div><p class="mute">Granted ${x.granted} · ${x.consumed} of ${x.granted} consumed</p><div class="bar"><i style="width:${x.granted ? x.consumed / x.granted * 100 : 0}%"></i></div></div>`).join("")}</div>`;
};
function calendar(month, cell) {
  const [y, m] = month.split("-").map(Number), first = new Date(y, m - 1, 1), n = new Date(y, m, 0).getDate();
  let h = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => `<div class="h">${d}</div>`).join("") + '<div></div>'.repeat(first.getDay());
  for (let d = 1; d <= n; d++) { const iso = `${month}-${String(d).padStart(2, "0")}`; const [cls, txt] = cell(iso); h += `<div class="d ${esc(cls)}"><b>${d}</b><small>${esc(txt)}</small></div>`; }
  return `<div class="cal">${h}</div>`;
}
const monthPicker = (id, v) => `<label for="${id}">Month</label><input id="${id}" type="month" value="${v}" style="max-width:200px">`;
const thisMonth = () => new Date().toISOString().slice(0, 7);
P["leave-calendar"] = async el => {
  const draw = async mo => {
    const c = await api("leave/calendar?month=" + mo);
    const on = (rows, iso) => rows.filter(r => r.from_date <= iso && r.to_date >= iso);
    el.innerHTML = `<h1>Leave Calendar</h1><div class="card">${monthPicker("mo", mo)}<br><br>${calendar(mo, iso => {
      const mine = on(c.mine, iso), team = on(c.team, iso), h = c.holidays.find(x => x.date === iso);
      return [mine.length ? "CL" : h ? "H" : "", [mine.length ? "Me: " + mine[0].code : "", h ? h.name : "", ...team.map(t => t.name.split(" ")[0])].filter(Boolean).join(" · ")];
    })}</div>`;
    $("#mo").onchange = e => e.target.value && draw(e.target.value);
  };
  draw(thisMonth());
};
P.holidays = async el => {
  const h = await api("holidays");
  el.innerHTML = `<h1>Holiday Calendar</h1><div class="card">${table([["Date", r => fdate(r.date)], ["Holiday", r => r.name], ["Type", r => r.restricted ? "Restricted (optional)" : "Public"]], h)}</div>`;
};

// ---- attendance
P.attendance = async el => {
  const draw = async mo => {
    const a = await api("attendance?month=" + mo), by = Object.fromEntries(a.days.map(d => [d.date, d])), s = a.summary;
    el.innerHTML = `<h1>Attendance Info</h1><div class="grid">
      <div class="card"><span class="mute">Present</span><div class="stat">${s.present}</div></div><div class="card"><span class="mute">Absent</span><div class="stat">${s.absent}</div></div>
      <div class="card"><span class="mute">Leave</span><div class="stat">${s.leave}</div></div><div class="card"><span class="mute">Late in</span><div class="stat">${s.late_in}</div></div>
      <div class="card"><span class="mute">Avg first in / last out</span><div class="stat" style="font-size:20px">${s.avg_first_in} / ${s.avg_last_out}</div></div></div>
      ${a.exceptions.length ? `<div class="card"><b>${a.exceptions.length} exception day(s):</b> ${a.exceptions.map(fdate).join(", ")} · <a href="#/regularization">Regularize</a></div>` : ""}
      <div class="card">${monthPicker("mo", mo)} <span class="mute">Shift ${esc(a.shift)}</span><br><br>${calendar(mo, iso => { const d = by[iso]; return d ? [d.status, d.first_in ? `${d.first_in}–${d.last_out}` : d.status] : ["", ""]; })}</div>`;
    $("#mo").onchange = e => e.target.value && draw(e.target.value);
  };
  draw(thisMonth());
};
P.regularization = async el => {
  let tab = 0;
  const draw = async () => {
    const [r, approvers] = await Promise.all([api("regularization"), api("approval-info")]);
    const kind = tab === 0 ? "regularize" : "permission";
    const approverOpts2 = [];
if (approvers.manager) approverOpts2.push([approvers.manager.id, approvers.manager.name + " (Manager)"]);
approvers.backups.forEach(b => approverOpts2.push([b.id, b.name + " (" + b.role.toUpperCase() + ")"]));
el.innerHTML = `<h1>Regularization & Permission</h1>${approvalBanner(approvers)}${tabs(["Regularization", "Permission"], tab)}<div class="card">${form("gf", [{ n: "approver_id", label: "Approver", type: "select", opts: approverOpts2 }, { n: "date", label: "Date", type: "date" }, { n: "in_time", label: "In time", type: "time", req: tab === 0 }, { n: "out_time", label: "Out time", type: "time", req: tab === 0 }, { n: "reason", label: "Reason", type: "textarea" }], "Apply")}</div>
    <div class="card"><h2>History</h2>${table([["Type", x => x.kind], ["Date", x => fdate(x.date)], ["Time", x => `${x.in_time || ""}–${x.out_time || ""}`], ["Reason", x => x.reason], ["Status", x => badge(x.status), 1]], r)}</div>`;
    wireTabs(i => { tab = i; draw(); }); wire("gf", "regularization", draw, d => ({ ...d, kind, approver_id: d.approver_id ? +d.approver_id : undefined }));
  };
  draw();
};

// ---- docs / people / hub
P.documents = async el => {
  const d = await api("documents");
  el.innerHTML = `<h1>Document Center</h1><div class="card">${table([["Title", r => r.title], ["Category", r => r.category], ["Content", r => r.body], ["Status", r => badge(r.status), 1]], d)}</div>`;
};
P.people = async el => {
  let tab = 0;
  let searchQ = "";
  const draw = async () => {
    const [p, org, teams] = await Promise.all([
      api("people?q=" + encodeURIComponent(searchQ)),
      api("orgchart"),
      api("people/teams")
    ]);
    const TAB_NAMES = ["Directory & Casual Leave", "Teams & Structure", "Org Chart"];
    let inner = "";

    if (tab === 0) {
      inner = `
      <div class="card">
        <label for="q">Search by name, department, title, or ID</label>
        <input id="q" value="${esc(searchQ)}" placeholder="Type to filter employees..." style="max-width:320px">
        <br><br>
        ${table([
          ["ID", r => r.emp_no],
          ["Employee", r => `<b>${esc(r.name)}</b> <span class="badge ${esc(r.role || "")}">${esc(titleCase(r.role))}</span>`, 1],
          ["Designation", r => esc(r.designation || "-")],
          ["Department", r => r.department],
          ["Reports To", r => r.manager_name || "— (Top Level)"],
          ["Team / Reportees", r => r.team_size ? `<span class="badge" title="${esc((r.team_members || []).join(', '))}">👥 ${r.team_size} ${r.team_size === 1 ? "member" : "members"}</span>` : '<span class="mute">—</span>', 1],
["Casual Leave", r => `<span class="badge CL" title="Available Casual Leave Balance" style="font-weight:700">${r.cl_balance} CL available</span>`, 1],
           ["Birthday", r => r.dob ? (r.dob === (new Date().getMonth()+1).toString().padStart(2,"0")+"-"+new Date().getDate().toString().padStart(2,"0") ? '🎂 Today' : '📅 ' + r.dob) : "—"],
           ["Location", r => r.location || "Remote"]
        ], p)}
      </div>`;
    }

    if (tab === 1) {
      inner = `
      <div class="card" style="border-left:4px solid var(--brand)">
        <h2>Team Structure & Direct Reports</h2>
        <p class="mute">See who leads which team, how many members they have, and who reports directly under them.</p>
      </div>
      <div class="grid">
        ${teams.map(t => `
          <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:start">
              <div>
                <h2 style="margin:0">${esc(t.name)}</h2>
                <span class="mute">${esc(t.designation)} · ${esc(t.department)}</span>
              </div>
              <span class="badge approved" style="font-size:13px">👥 ${t.team_size} ${t.team_size === 1 ? "member" : "members"}</span>
            </div>
            <p class="mute" style="font-size:12px;margin:6px 0">Official: ${esc(t.email)} · ${esc(t.location || "Lucknow")}</p>
            <div style="margin-top:12px">
              <b>Reporting Members Under ${esc(t.name.split(" ")[0])}:</b>
              <div style="margin-top:6px">
                ${table([
                  ["ID", m => m.emp_no],
                  ["Member", m => `<b>${esc(m.name)}</b>`, 1],
                  ["Designation", m => m.designation],
                  ["Location", m => m.location || "-"]
                ], t.members)}
              </div>
            </div>
          </div>
        `).join("")}
      </div>`;
    }

    if (tab === 2) {
      const kids = id => org.filter(o => o.manager_id === id);
      const node = o => `<li>
        <b>${esc(o.name)}</b> <span class="badge ${esc(o.role || "")}">${esc(o.designation)}</span>
        ${kids(o.id).length ? `<ul>${kids(o.id).map(node).join("")}</ul>` : ""}
      </li>`;

      // Top-level leaders (CEO, COO, CPO all equal at the top level)
      const topLeaders = org.filter(o => !o.manager_id);
      inner = `
      <div class="card org">
        <h2>Organization Chart</h2>
        <div class="card" style="background:var(--brand-l);margin-bottom:16px;border:1px solid var(--brand)">
          <b>Executive Leadership Trio (Co-Equal Tier):</b>
          <div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap">
            ${topLeaders.map(l => `<div class="card" style="margin:0;padding:8px 14px;background:var(--card)"><b>${esc(l.name)}</b><br><span class="badge ceo">${esc(l.designation)}</span></div>`).join("")}
          </div>
        </div>
        <ul>${topLeaders.map(node).join("")}</ul>
      </div>`;
    }

    el.innerHTML = `<h1>People & Teams</h1>${tabs(TAB_NAMES, tab)}${inner}`;
    wireTabs(i => { tab = i; draw(); });

    const inp = $("#q");
    if (inp) {
      inp.focus();
      inp.setSelectionRange(searchQ.length, searchQ.length);
      inp.oninput = e => { searchQ = e.target.value; draw(); };
    }
  };
  draw();
};
P["request-hub"] = async el => {
  const h = await api("request-hub");
  el.innerHTML = `<h1>Request Hub</h1><div class="card">${table([["Type", r => r.type], ["Details", r => r.summary], ["Status", r => badge(r.status), 1], ["Raised", r => fdate(r.created_at)]], h)}</div>`;
};

// ---------------- shell ----------------
// Sidebar mirrors the original: leaf items and collapsible groups. [route,label,icon] or [label,icon,[children]]
const NAV = [["home", "Home", "⌂"], ["engage", "Engage", "◉"],
  ["My Worklife", "▦", [["kudos", "Kudos"], ["feedback", "Feedback"]]],
  ["To do", "☑", [["tasks", "Tasks"], ["review", "Review"]]],
  ["Salary", "₹", [["payslips", "Payslips"], ["ytd", "YTD Reports"], ["it-statement", "IT Statement"], ["it-declaration", "IT Declaration"], ["loans", "Loans and Advances"], ["reimbursement", "Reimbursement"], ["poi", "Proof Of Investment"], ["salary-revision", "Salary Revision"]]],
  ["Leave", "▣", [["leave-apply", "Leave Apply"], ["leave-balances", "Leave Balances"], ["leave-calendar", "Leave Calendar"], ["holidays", "Holiday Calendar"]]],
  ["Attendance", "✓", [["attendance", "Attendance Info"], ["regularization", "Regularization & Permission"]]],
  ["documents", "Document Center", "▭"], ["people", "People", "☺"], ["helpdesk", "Helpdesk", "ⓘ"], ["request-hub", "Request Hub", "≋"], ["delegates", "Workflow Delegates", "⇄"]];
const openGroups = new Set();

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
  const isExec = ["ceo", "coo", "cpo", "superadmin"].includes(ME.role);
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
  const ADMINS = ["hr", "ceo", "coo", "cpo", "superadmin"];
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
      const isExec = ["ceo", "coo", "cpo", "superadmin"].includes(ME.role);
      const roleChoices = isExec
        ? [["employee", "Employee"], ["manager", "Manager"], ["hr", "HR"], ["cpo", "CPO"], ["coo", "COO"], ["ceo", "CEO"]]
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
              <select id="edit-desig-sel" style="min-width:320px">
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
              if (!isExec && ["ceo", "coo", "cpo"].includes(r.role)) return `<span class="badge ceo">Leadership</span>`;
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
          { n: "code", label: "Leave Type", type: "select", opts: [["", "— Select Leave Type —"], ["CL", "Casual Leave (CL)"]] },
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
            <input id="cl-bulk-days" type="number" step="0.5" min="0" max="365" style="max-width:170px" value="16" placeholder="e.g. 16">
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
    const g = b.dataset.g; if (openGroups.has(g)) { openGroups.delete(g); } else { openGroups.clear(); openGroups.add(g); }
    $("#side").innerHTML = sidebar(route); bindSide(route);
    const nb = $(`.grp[data-g="${g}"]`); if (nb) nb.focus();
  });
  if (!window.__sideCloseBound) {
    window.__sideCloseBound = true;
    document.addEventListener("click", e => {
      if (!e.target.closest(".grp") && !e.target.closest(".sub")) {
        if (openGroups.size) { openGroups.clear(); document.querySelectorAll(".sub.open").forEach(s=>s.classList.remove("open")); document.querySelectorAll(".grp").forEach(bb=>{bb.setAttribute("aria-expanded","false"); const c=bb.querySelector(".chev"); if(c) c.textContent="▼";}); }
      }
    });
  }
}
function sidebar(route) {
  const link = (r, l, ic) => `<a href="#/${r}" onclick="setTimeout(()=>render(),0)" class="${r === route ? "on" : ""}"><span class="ic" aria-hidden="true">${ic || ""}</span>${esc(l)}${r === "review" && ME.pending_reviews ? ` <span class="badge pending">${ME.pending_reviews}</span>` : ""}</a>`;
  const isExec = ["ceo", "coo", "cpo", "superadmin"].includes(ME.role);
  const isHR = ME.role === "hr" || ME.role === "superadmin";
  let navList = [...NAV];
  if (isExec) {
    if (ME.role === "superadmin") {
      navList = [["executive", "Superadmin Suite", "🏛"], ...navList];
    } else {
      navList = [["executive", `${ME.role.toUpperCase()} Suite`, "🏛"], ...navList, ["admin", "HR Admin", "★"], ["accounts", "Accounts Admin", "▤"]];
    }
  } else if (isHR) {
    navList = [...navList, ["admin", "HR Admin", "★"]];
  } else if (ME.role === "accounts" || ME.role === "superadmin") {
    navList = [...navList, ["accounts", "Accounts Admin", "▤"]];
  }
  return `<div class="logo"><img src="assets/logo.png" alt="" aria-hidden="true"><span>3Wheels AI</span></div>
  <div class="prof"><span class="avatar">${esc(ME.name[0])}</span><div><b>Hi ${esc(ME.name.split(" ")[0])}</b> <span class="badge ${esc(ME.role)}">${esc(ME.role.toUpperCase())}</span><br><a href="#/my-info">View My Info</a></div><a href="#/my-info" class="gear" aria-label="Settings">⚙</a></div>
  <nav>${navList.map(n => {
    if (typeof n[2] !== "object") return link(n[0], n[1], n[2]);
    const [label, ic, kids] = n, has = kids.some(k => k[0] === route), open = has || openGroups.has(label);
    return `<button class="grp" data-g="${esc(label)}" aria-expanded="${open}"><span class="ic" aria-hidden="true">${ic}</span>${esc(label)}<span class="chev">${open ? "▲" : "▼"}</span></button><div class="sub ${open ? "open" : ""}">${kids.map(k => link(k[0], k[1])).join("")}</div>`;
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
  checkHealth().then(refreshMe).then(render);  // a 503 here switches the maintenance screen straight back on
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
      try { await api("login", "POST", Object.fromEntries(new FormData(e.target))); await refreshMe(); location.hash = ["ceo", "coo", "cpo"].includes(ME.role) ? "#/executive" : "#/home"; render(); }
      catch (er) { $("#lg-err").textContent = er.message; btn.disabled = false; btn.textContent = "Sign in"; }
    };
    return;
  }
  const route = (location.hash.replace("#/", "") || (["ceo", "coo", "cpo"].includes(ME.role) ? "executive" : "home"));
  app.innerHTML = `<div class="shell"><aside id="side" aria-label="Main menu">${sidebar(route)}</aside>
  <div class="main"><header><button class="btn sec sm menu-btn" id="mb" aria-label="Menu">☰</button><span class="mute">${esc(ME.designation)} · ${esc(ME.department)}</span><span class="who">${themeBtn()}<button class="bell" id="bell" aria-label="Notifications">🔔<b id="bellcount">${ME.unread || ""}</b></button><span>${esc(ME.name)} <span class="badge ${esc(ME.role)}">${esc(ME.role.toUpperCase())}</span> <span class="mute">#${esc(ME.emp_no)}</span></span><button class="btn sec sm" id="out">Sign out</button></span></header><main id="page" tabindex="-1"></main></div></div>`;
  bindSide(route); bindTheme();
  $("#mb").onclick = () => $("#side").classList.toggle("open");
  $("#out").onclick = async () => { await api("logout", "POST"); ME = null; render(); };
  $("#bell").onclick = async () => { const n = await api("notifications"); $("#page").innerHTML = `<h1>Notifications</h1><div class="card">${table([["Message", r => r.text + (r.text.includes("requested payslip") ? ' <button class="btn sm" onclick="location.hash=\'#/accounts\';render();">Execute</button>' : r.text.includes("is ready") ? ' <button class="btn sm" onclick="location.hash=\'#/payslips\';render();">Download</button>' : ""), 1], ["Received at", r => r.created_at]], n, "No notifications.")}</div>`; $("#bellcount").textContent = ""; };
  const page = $("#page");
  (P[route] || P.home)(page).catch(e => { page.innerHTML = `<div class="card err">${esc(e.message)}</div>`; });
}
window.addEventListener("hashchange", () => ME && render());
checkHealth().then(refreshMe).then(render);


let _idle; function _resetIdle(){ clearTimeout(_idle); _idle=setTimeout(()=>{ api('logout','POST').finally(()=>{ ME=null; render(); }); }, 300000); } ['click','mousemove','keydown','scroll','touchstart'].forEach(e=>document.addEventListener(e,_resetIdle,{passive:true})); _resetIdle();
