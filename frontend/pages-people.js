"use strict";
// People in the greytHR style: Directory (starred / everyone, detail panel) and Org Chart

const SILHOUETTE = `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="21" r="12"/><path d="M6 63c2-17 14-23 26-23s24 6 26 23z"/></svg>`;
const starredIds = () => { try { return new Set(JSON.parse(localStorage.getItem("starred_people") || "[]")); } catch { return new Set(); } };
const saveStarred = s => { try { localStorage.setItem("starred_people", JSON.stringify([...s])); } catch { } };
const dobLabel = d => { const m = /^(\d{2})-(\d{2})$/.exec(String(d || "")); return m ? `${m[2]} ${new Date(2000, +m[1] - 1, 1).toLocaleDateString("en-GB", { month: "short" })}` : "-"; };

P.people = async el => {
  let top = 0, sub = 1, q = "", sel = null, filt = { dept: "", loc: "" }, showFilter = false;
  const [people, org] = await Promise.all([api("people"), api("orgchart")]);
  const stars = starredIds();
  people.sort((a, b) => a.name.localeCompare(b.name));

  // ---- directory
  const depts = [...new Set(people.map(p => p.department).filter(Boolean))].sort(), locs = [...new Set(people.map(p => p.location).filter(Boolean))].sort();
  const directory = () => {
    const needle = q.trim().toLowerCase();
    const list = people.filter(p => (sub === 1 || stars.has(p.id)) && (!filt.dept || p.department === filt.dept) && (!filt.loc || p.location === filt.loc) && (!needle || p.name.toLowerCase().includes(needle) || String(p.emp_no).toLowerCase().includes(needle) || String(p.biometric_id || "") === needle));
    if (!list.some(p => p.id === sel)) sel = list.length ? list[0].id : null;
    const cur = people.find(p => p.id === sel);
    const row = p => `<button type="button" class="pd-row ${p.id === sel ? "on" : ""}" data-p="${p.id}"><span class="pd-av">${SILHOUETTE}</span><span><b>${esc(p.name)}</b> <small>(#${esc(p.emp_no)})</small></span></button>`;
    const kv = (k, v) => `<div class="pd-kv"><span>${k}</span><b>${v ? esc(v) : "-"}</b></div>`;
    const detail = cur ? `<div class="pd-top"><div class="pd-big">${SILHOUETTE}</div><div><h2>${esc(cur.name)} <button type="button" class="pd-star ${stars.has(cur.id) ? "on" : ""}" data-star="${cur.id}" aria-label="${stars.has(cur.id) ? "Remove from starred" : "Add to starred"}">${stars.has(cur.id) ? "★" : "☆"}</button></h2><div class="mute">#${esc(cur.emp_no)}${cur.biometric_id ? ` · Machine ID ${esc(cur.biometric_id)}` : ""}</div>
        <div class="pd-sec"><span>CONTACT DETAILS</span></div>${kv("Email", cur.email)}
        <div class="pd-sec"><span>CATEGORY</span></div>${kv("Location", cur.location)}${kv("Department", cur.department)}${kv("Designation", cur.designation)}${kv("Reports to", cur.manager_name)}
        <div class="pd-sec"><span>OTHER INFORMATION</span></div>${kv("Joining Date", cur.join_date ? longDate(cur.join_date).replace(/ (\d{4})$/, ", $1") : "")}${kv("Date Of Birth", dobLabel(cur.dob))}</div></div>`
      : `<div class="empty"><div class="e-art">${ART.emptyList}</div><p>${sub === 0 ? "No starred people yet. Click the star on someone's profile." : "No employees match your search."}</p></div>`;
    return `<div class="pd-tabs"><button type="button" data-sub="0" class="${sub === 0 ? "on" : ""}">Starred</button><button type="button" data-sub="1" class="${sub === 1 ? "on" : ""}">Everyone</button></div>
      <div class="pd"><div class="pd-left"><div class="pd-search"><input type="search" id="pd-q" placeholder="Enter Emp. Name or ID" value="${esc(q)}" aria-label="Search people"><button type="button" id="pd-filt" class="pd-fbtn ${filt.dept || filt.loc ? "on" : ""}" aria-label="Filter">${funnelIcon()}</button></div>
        ${showFilter ? `<div class="pd-filters"><label>Department<select id="pd-dept"><option value="">All</option>${depts.map(d => `<option ${d === filt.dept ? "selected" : ""}>${esc(d)}</option>`).join("")}</select></label><label>Location<select id="pd-loc"><option value="">All</option>${locs.map(d => `<option ${d === filt.loc ? "selected" : ""}>${esc(d)}</option>`).join("")}</select></label></div>` : ""}
        <div class="pd-list">${list.map(row).join("") || '<p class="mute pd-none">No results</p>'}</div></div><div class="pd-right">${detail}</div></div>`;
  };

  // ---- org chart
  const byMgr = {}; org.forEach(e => { (byMgr[e.manager_id || 0] = byMgr[e.manager_id || 0] || []).push(e); });
  const ids = new Set(org.map(e => e.id));
  const roots = org.filter(e => !e.manager_id || !ids.has(e.manager_id));
  const kids = id => (byMgr[id] || []).sort((a, b) => a.name.localeCompare(b.name));
  const open = new Set(roots.map(r => r.id)), hit = new Set();
  let scale = 1, oq = "";
  const parentOf = Object.fromEntries(org.map(e => [e.id, e.manager_id]));
  const node = (e, depth) => {
    const ks = kids(e.id), isOpen = open.has(e.id);
    return `<li><div class="oc-node ${depth === 0 ? "root" : ""} ${hit.has(e.id) ? "hit" : ""}" data-oc="${e.id}" tabindex="0"><span class="oc-av">${SILHOUETTE}</span><span class="oc-t"><b>${esc(e.name)}</b><small>${esc(e.designation || "")}</small><small>Emp ID - ${esc(e.emp_no)}</small></span></div>
      ${ks.length ? `<button type="button" class="oc-count" data-oc="${e.id}" aria-label="${isOpen ? "Collapse" : "Expand"} ${ks.length} reports">${isOpen ? "−" : ks.length}</button>` : ""}
      ${ks.length && isOpen ? `<ul>${ks.map(k => node(k, depth + 1)).join("")}</ul>` : ""}</li>`;
  };
  const chart = () => `<div class="oc"><div class="oc-bar"><input type="search" id="oc-q" placeholder="Search" value="${esc(oq)}" aria-label="Search the org chart"></div>
    <div class="oc-view" id="oc-view"><div class="oc-tree" id="oc-tree" style="transform:scale(${scale})"><ul class="oc-roots">${roots.sort((a, b) => a.name.localeCompare(b.name)).map(r => node(r, 0)).join("")}</ul></div></div>
    <div class="oc-zoom"><button type="button" data-z="fit" aria-label="Fit to screen" title="Fit">⤢</button><button type="button" data-z="in" aria-label="Zoom in">+</button><button type="button" data-z="out" aria-label="Zoom out">−</button></div></div>`;

  const draw = () => {
    el.innerHTML = `${segTabs(["Directory", "Org Chart"], top, "dark")}${top === 0 ? directory() : chart()}`;
    wireSeg(el, i => { top = i; draw(); });
    if (top === 0) {
      el.querySelectorAll("[data-sub]").forEach(b => b.onclick = () => { sub = +b.dataset.sub; draw(); });
      el.querySelectorAll("[data-p]").forEach(b => b.onclick = () => { sel = +b.dataset.p; draw(); });
      el.querySelectorAll("[data-star]").forEach(b => b.onclick = () => { const id = +b.dataset.star; stars.has(id) ? stars.delete(id) : stars.add(id); saveStarred(stars); draw(); });
      $("#pd-q").oninput = e => { q = e.target.value; const pos = e.target.selectionStart; draw(); const n = $("#pd-q"); n.focus(); n.setSelectionRange(pos, pos); };
      $("#pd-filt").onclick = () => { showFilter = !showFilter; draw(); };
      const d = $("#pd-dept"), l = $("#pd-loc"); if (d) d.onchange = () => { filt.dept = d.value; draw(); }; if (l) l.onchange = () => { filt.loc = l.value; draw(); };
    } else {
      el.querySelectorAll("[data-oc]").forEach(n => n.onclick = () => { const id = +n.dataset.oc; if (!kids(id).length) return; open.has(id) ? open.delete(id) : open.add(id); draw(); });
      el.querySelectorAll("[data-z]").forEach(b => b.onclick = () => { scale = b.dataset.z === "in" ? Math.min(scale + 0.15, 1.6) : b.dataset.z === "out" ? Math.max(scale - 0.15, 0.4) : fit(); $("#oc-tree").style.transform = `scale(${scale})`; });
      $("#oc-q").oninput = e => {
        oq = e.target.value.trim().toLowerCase(); hit.clear();
        if (oq) { org.filter(x => x.name.toLowerCase().includes(oq) || String(x.emp_no).toLowerCase().includes(oq)).forEach(x => { hit.add(x.id); for (let p = parentOf[x.id]; p; p = parentOf[p]) open.add(p); }); }
        const pos = e.target.selectionStart; draw(); const n = $("#oc-q"); n.focus(); n.setSelectionRange(pos, pos);
        const first = el.querySelector(".oc-node.hit"); if (first) first.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
      };
    }
  };
  const fit = () => { const v = $("#oc-view"), t = $("#oc-tree"); if (!v || !t) return 1; t.style.transform = "scale(1)"; return Math.max(0.4, Math.min(1, (v.clientWidth - 20) / t.scrollWidth)); };
  draw();
};
const funnelIcon = () => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16l-6 8v6l-4-2v-4z"/></svg>`;
