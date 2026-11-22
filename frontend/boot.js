"use strict";
// Start-up, loaded last so every page file has registered itself in P first.
window.addEventListener("hashchange", () => ME && render());
checkHealth().then(bootMe).then(render);

// Sign out after 5 minutes without any activity
let _idle;
function _resetIdle() { clearTimeout(_idle); _idle = setTimeout(() => { api("logout", "POST").finally(() => { ME = null; render(); }); }, 300000); }
["click", "mousemove", "keydown", "scroll", "touchstart"].forEach(e => document.addEventListener(e, _resetIdle, { passive: true }));
_resetIdle();
