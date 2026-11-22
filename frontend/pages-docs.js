"use strict";
// Document Center in the greytHR style: tiles for documents, payslips, policies, forms and letters

const DOC_ART = `<svg viewBox="0 0 220 170" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="96" y="18" width="92" height="12" rx="2"/><path d="M104 26h30"/><circle cx="64" cy="58" r="12" fill="var(--card)"/><path d="M52 72c-8 8-10 36-8 62M76 72c8 8 12 36 10 62M52 72h24l-2 30H54z" fill="var(--accent)" fill-opacity=".35"/><path d="M48 134v22M80 134v22"/><rect x="88" y="62" width="22" height="30" rx="3" fill="var(--card)"/><path d="M92 70h14M92 78h14M92 86h8"/><path d="M130 150h40M134 134l16 16 16-16" opacity=".5"/></svg>`;
const LETTER_TYPES = ["Experience letter", "Salary certificate", "Address proof letter", "Employment verification", "Relieving letter", "Other"];

P.documents = async el => {
  let view = window.__dcView || "home"; window.__dcView = null;   // set after a letter request so we land back on Letters
  const [docs, tickets] = await Promise.all([api("documents"), api("tickets")]);
  const letterReq = tickets.filter(t => String(t.subject).startsWith("Letter request"));
  const pending = letterReq.filter(t => ["open", "in_progress"].includes(t.status)).length;
  const letterDocs = docs.filter(d => d.category === "Letters");
  const closed = letterReq.filter(t => ["resolved", "closed"].includes(t.status)).length;
  const policies = docs.filter(d => d.category === "Policies");
  const personal = docs.filter(d => !["Policies", "Letters"].includes(d.category));

  const tile = (key, title, ico, count = "") => `<div class="dc-tile"><span class="dc-ico ${key}">${ico}</span><span class="dc-t">${esc(title)}</span><a href="#" data-go="${key}">View All</a>${count}</div>`;
  const ICO = {
    docs: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/></svg>',
    pay: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="9" r="3.5"/><path d="M5 20c1-4 4-6 7-6s6 2 7 6"/></svg>',
    form: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="6" y="3" width="12" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>',
    pol: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 9l2 2 4-4M9 15h6"/></svg>',
    mail: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 8l9 6 9-6"/></svg>',
  };
  const NAMES = { docs: "Documents", pay: "Payslips", f16: "Form 16", pol: "Company Policies", forms: "Forms", letters: "Letters" };

  const home = () => `<div class="dc-hero card"><div><h2>We've got it sorted for you!</h2><p>All Documents are now in one place..</p><p>You can now request a new letter if you don't find the one you were looking for..</p></div><div class="dc-art">${DOC_ART}</div></div>
    <h3 class="dc-h">Documents</h3><div class="dc-tiles">${tile("docs", "Documents", ICO.docs)}${tile("pay", "Payslips", ICO.pay)}${tile("f16", "Form 16", ICO.form)}${tile("pol", "Company Policies", ICO.pol)}${tile("forms", "Forms", ICO.form)}</div>
    <h3 class="dc-h">Request</h3><div class="dc-tiles">${tile("letters", "Letters", ICO.mail, `<div class="dc-sub"><span>Pending: <b>${pending}</b></span><span>Closed: <b>${closed + letterDocs.length}</b></span></div>`)}</div>`;

  const list = (rows, emptyMsg) => rows.length
    ? `<div class="card">${table([["Title", r => r.title], ["Category", r => r.category], ["Content", r => r.body], ["Added", r => fmtComma(r.created_at)]], rows)}</div>` : `<div class="card">${emptyBlock("emptyList", "", emptyMsg)}</div>`;
  const letters = () => `<div class="dc-actions"><button class="btn" type="button" id="dc-req">Request a letter</button></div>
    ${letterDocs.length ? `<div class="card"><h3 class="dc-h">Issued letters</h3>${table([["Title", r => r.title], ["Content", r => r.body], ["Issued", r => fmtComma(r.created_at)]], letterDocs)}</div>` : ""}
    <div class="card"><h3 class="dc-h">My letter requests</h3>${letterReq.length ? table([["Request", r => String(r.subject).replace("Letter request: ", "")], ["Details", r => r.body], ["Raised", r => fmtComma(r.created_at)], ["Status", r => badge(r.status), 1]], letterReq) : emptyBlock("emptyList", "", "You have not requested any letters yet.")}</div>`;

  const draw = () => {
    if (view === "home") setCrumb(["Document Center"]); else setCrumb(["Document Center", NAMES[view]]);
    const body = view === "home" ? home() : view === "docs" ? list(personal, "No documents have been shared with you yet.") : view === "pol" ? list(policies, "No company policies have been published yet.")
      : view === "letters" ? letters() : list([], `No ${NAMES[view]} documents yet.`);
    el.innerHTML = `${view === "home" ? "" : '<div class="dc-back"><a href="#" id="dc-back">‹ Document Center</a></div>'}${body}`;
    el.querySelectorAll("[data-go]").forEach(a => a.onclick = e => { e.preventDefault(); if (a.dataset.go === "pay") { location.hash = "#/payslips"; return; } view = a.dataset.go; draw(); });
    const back = $("#dc-back"); if (back) back.onclick = e => { e.preventDefault(); view = "home"; draw(); };
    const req = $("#dc-req"); if (req) req.onclick = () => {
      openDialog("Request a letter", form("lf", [{ n: "kind", label: "Letter", type: "select", opts: LETTER_TYPES.map(x => [x, x]) }, { n: "note", label: "Anything HR should know", type: "textarea", req: false }], "Send request"));
      wire("lf", "tickets", () => { closeDialog(); window.__dcView = "letters"; P.documents(el); },
        d => ({ category: "HR", subject: "Letter request: " + d.kind, body: d.note || "Please issue this letter." }));
    };
  };
  draw();
};
