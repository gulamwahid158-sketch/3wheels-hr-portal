"use strict";
// Start-up, loaded last so every page file has registered itself in P first.
window.addEventListener("hashchange", () => ME && render());
checkHealth().then(bootMe).then(render);

// Sign out after 5 minutes without any activity (10 minutes for HR, admin and leadership accounts)
let _idle;
const idleMs = () => ME && ADMIN_ROLES.includes(ME.role) ? 600000 : 300000;
function _resetIdle() { clearTimeout(_idle); _idle = setTimeout(() => { api("logout", "POST").finally(() => { ME = null; render(); }); }, idleMs()); }
["click", "mousemove", "keydown", "scroll", "touchstart"].forEach(e => document.addEventListener(e, _resetIdle, { passive: true }));
_resetIdle();
