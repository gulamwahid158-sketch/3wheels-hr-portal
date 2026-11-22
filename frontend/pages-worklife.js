"use strict";
// My Worklife in the greytHR style: Kudos and Feedback

// Employee search box: type a name or code, pick from the list. onPick(person|null)
function wireEmployeePicker(box, people, onPick, preset) {
  const input = box.querySelector("input"), list = box.querySelector(".ep-list");
  const show = () => {
    const n = input.value.trim().toLowerCase();
    const hits = people.filter(p => !n || p.name.toLowerCase().includes(n) || String(p.emp_no).toLowerCase().includes(n)).slice(0, 8);
    list.innerHTML = hits.map(p => `<button type="button" data-id="${p.id}">${esc(p.name)} <small>(#${esc(p.emp_no)})</small></button>`).join("") || '<p class="mute">No match</p>';
    list.hidden = false;
  };
  input.oninput = () => { onPick(null); show(); };
  input.onfocus = show;
  list.onclick = e => { const b = e.target.closest("[data-id]"); if (!b) return; const p = people.find(x => x.id === +b.dataset.id); input.value = p.name; list.hidden = true; onPick(p); };
  box.addEventListener("focusout", () => setTimeout(() => { if (!box.contains(document.activeElement)) list.hidden = true; }, 120));
  if (preset) { input.value = preset.name; onPick(preset); }
}
const epHtml = () => `<div class="ep"><span class="ep-av">${typeof SILHOUETTE === "string" ? SILHOUETTE : ""}</span><input type="text" placeholder="Search by Emp No. / Name" autocomplete="off" aria-label="Search employee"><div class="ep-list" hidden></div></div>`;

// ------------------------------------------------------------------ Kudos
P.kudos = async el => {
  let tab = 0;
  const all = await api("kudos");
  const draw = () => {
    const rows = all.filter(k => tab === 0 ? k.to_id === ME.id : k.from_id === ME.id);
    const card = k => `<div class="kd"><div class="kd-art">${ART.kudos}</div><div><p class="kd-t"><b>${esc(k.from_name)}</b> gave kudos to <b>${esc(k.to_name)}</b></p><span class="badge">${esc(k.value)}</span><p class="kd-m">${esc(k.message)}</p><small class="mute">${esc(fmtComma(k.created_at))}</small></div></div>`;
    el.innerHTML = `${underlineTabs(["Received", "Given"], tab)}${rows.length ? `<div class="kd-list">${rows.map(card).join("")}</div>` : emptyBlock("thumb", "Get going!", tab === 0 ? "All the Kudos you have received will appear here." : "All the Kudos you have given will appear here.", "Go to Engage", "k-go")}`;
    wireUt(el, i => { tab = i; draw(); });
    const go = $("#k-go"); if (go) go.onclick = () => { location.hash = "#/engage"; };
  };
  draw();
};

// ------------------------------------------------------------------ Feedback
const DRAFT_KEY = "feedback_drafts";
const loadDrafts = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "[]"); } catch { return []; } };
const saveDrafts = d => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { } };

P.feedback = async el => {
  setCrumb(["My Worklife", "Feedback"]);
  let tab = 0;
  const [fb, reqs, ppl] = await Promise.all([api("feedback"), api("feedback-requests"), api("people")]);
  const people = ppl.filter(p => p.id !== ME.id);

  // one dialog for both actions: mode "request" or "give"; preset: { person, requestId, text }
  const compose = (mode, preset = {}) => {
    let picked = preset.person || null, draftId = preset.draftId || null;
    const title = mode === "request" ? "Request Feedback" : "Give Feedback";
    openDialog(title, `<label>Search Employee<span class="req">*</span></label>${epHtml()}
      <label for="fb-msg" style="margin-top:18px">${mode === "request" ? "Include a personalised message" : "Your feedback"} <span class="req">*</span></label>
      <textarea id="fb-msg" rows="6" placeholder="Type your message here....">${esc(preset.text || "")}</textarea>
      <div class="fb-actions"><button type="button" class="link" id="fb-cancel">Cancel</button>${mode === "give" ? '<button type="button" class="btn sec" id="fb-draft">Save as draft</button>' : ""}<button type="button" class="btn" id="fb-send" disabled>Submit</button></div>`);
    const send = $("#fb-send"), msg = $("#fb-msg");
    const ready = () => { send.disabled = !(picked && msg.value.trim()); };
    wireEmployeePicker($("#dlg .ep"), people, p => { picked = p; ready(); }, picked);
    msg.oninput = ready; ready();
    $("#fb-cancel").onclick = closeDialog;
    const d = $("#fb-draft"); if (d) d.onclick = () => {
      if (!picked || !msg.value.trim()) { toast("Choose a person and write a message first"); return; }
      const list = loadDrafts().filter(x => x.id !== draftId);
      list.unshift({ id: draftId || String(Date.now()), to_id: picked.id, to_name: picked.name, text: msg.value.trim(), saved: new Date().toISOString() });
      saveDrafts(list); closeDialog(); toast("Saved to drafts"); tab = 3; draw();
    };
    send.onclick = async () => {
      send.disabled = true;
      try {
        if (mode === "request") await api("feedback-requests", "POST", { to_id: picked.id, message: msg.value.trim() });
        else { await api("feedback", "POST", { to_id: picked.id, message: msg.value.trim(), request_id: preset.requestId }); if (draftId) saveDrafts(loadDrafts().filter(x => x.id !== draftId)); }
        closeDialog(); toast(mode === "request" ? "Feedback requested" : "Feedback sent");
        const [f, r] = await Promise.all([api("feedback"), api("feedback-requests")]); Object.assign(fb, f); Object.assign(reqs, r);
        tab = mode === "request" ? 2 : 1; draw();
      } catch (er) { toast(er.message); send.disabled = false; }
    };
  };

  const draw = () => {
    const drafts = loadDrafts();
    const sentPending = reqs.sent.filter(r => r.status === "pending"), asked = reqs.received.filter(r => r.status === "pending");
    const receivedCard = f => `<div class="fb-card"><p>${esc(f.message)}</p><small class="mute">Anonymous · ${esc(fmtComma(f.created_at))}</small></div>`;
    const givenCard = f => `<div class="fb-card"><b>To ${esc(f.to_name)}</b><p>${esc(f.message)}</p><small class="mute">${esc(fmtComma(f.created_at))}</small></div>`;
    let body = "";
    if (tab === 0) body = fb.received.length ? `<div class="fb-list">${fb.received.map(receivedCard).join("")}</div>` : emptyBlock("feedbackMon", "Seeking Advice?", "Let's gather a new outlook from your coworkers.", "Request Feedback", "fb-empty-req");
    else if (tab === 1) body = fb.given.length ? `<div class="fb-list">${fb.given.map(givenCard).join("")}</div>` : emptyBlock("feedbackMon", "Share your thoughts", "Feedback you give to your coworkers will appear here.", "Give Feedback", "fb-empty-give");
    else if (tab === 2) body = sentPending.length || asked.length ? `<div class="fb-list">
        ${asked.length ? `<h3 class="dc-h">Asked of you</h3>${asked.map(r => `<div class="fb-card"><b>${esc(r.from_name)} wants your feedback</b><p>${esc(r.message)}</p><div class="fb-row"><small class="mute">${esc(fmtComma(r.created_at))}</small><button class="btn sm" type="button" data-answer="${r.id}">Give Feedback</button></div></div>`).join("")}` : ""}
        ${sentPending.length ? `<h3 class="dc-h">Requested by you</h3>${sentPending.map(r => `<div class="fb-card"><b>Waiting for ${esc(r.to_name)}</b><p>${esc(r.message)}</p><small class="mute">${esc(fmtComma(r.created_at))}</small></div>`).join("")}` : ""}</div>`
      : emptyBlock("emptyList", "", "No pending requests.");
    else body = drafts.length ? `<div class="fb-list">${drafts.map(d => `<div class="fb-card"><b>To ${esc(d.to_name)}</b><p>${esc(d.text)}</p><div class="fb-row"><small class="mute">Saved ${esc(fmtComma(d.saved))}</small><span><button class="btn sm" type="button" data-draft="${esc(d.id)}">Edit</button> <button class="btn sec sm" type="button" data-rmdraft="${esc(d.id)}">Delete</button></span></div></div>`).join("")}</div>` : emptyBlock("emptyList", "", "No drafts saved.");
    el.innerHTML = `<div class="fb-top"><button class="btn" type="button" id="fb-req">Request Feedback</button><button class="btn" type="button" id="fb-give">Give Feedback</button></div>${underlineTabs(["Received", "Given", "Pending Requests", "Drafts"], tab)}${body}`;
    wireUt(el, i => { tab = i; draw(); });
    $("#fb-req").onclick = () => compose("request");
    $("#fb-give").onclick = () => compose("give");
    const a = $("#fb-empty-req"); if (a) a.onclick = () => compose("request");
    const b = $("#fb-empty-give"); if (b) b.onclick = () => compose("give");
    el.querySelectorAll("[data-answer]").forEach(x => x.onclick = () => { const r = reqs.received.find(y => String(y.id) === x.dataset.answer); compose("give", { person: people.find(p => p.id === r.from_id), requestId: r.id }); });
    el.querySelectorAll("[data-draft]").forEach(x => x.onclick = () => { const d = loadDrafts().find(y => y.id === x.dataset.draft); compose("give", { person: people.find(p => p.id === d.to_id), text: d.text, draftId: d.id }); });
    el.querySelectorAll("[data-rmdraft]").forEach(x => x.onclick = () => { saveDrafts(loadDrafts().filter(y => y.id !== x.dataset.rmdraft)); draw(); });
  };
  draw();
};
