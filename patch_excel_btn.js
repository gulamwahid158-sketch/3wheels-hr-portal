
// Script to patch line 769 in app.js to add the Excel download button
const fs = require('fs');
const path = 'frontend/app.js';
let content = fs.readFileSync(path, 'utf8');

const oldText = `          <span class="mute" style="font-size:13px">Showing <b>${overview.length}</b> active employee(s)</span>\n        </div>\n        <div class="tablewrap"><table>`;
const newText = `          <span class="mute" style="font-size:13px">Showing <b>\${overview.length}</b> active employee(s)</span>
          <button class="btn sm" id="ao-excel" style="background:#1d6f42;color:#fff;border-color:#1d6f42;margin-left:8px" title="Download attendance Excel (.xlsx)">📥 Download Excel</button>
        </div>
        <div class="tablewrap"><table>`;

// Use line-based approach
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('Showing <b>${overview.length}</b> active employee(s)</span>')) {
    // Insert the button after this line, before the closing </div>
    lines[i] = lines[i].replace(
      `Showing <b>\${overview.length}</b> active employee(s)</span>`,
      `Showing <b>\${overview.length}</b> active employee(s)</span>
          <button class="btn sm" id="ao-excel" style="background:#1d6f42;color:#fff;border-color:#1d6f42;margin-left:8px" title="Download attendance Excel (.xlsx) with Summary and per-employee sheets">📥 Download Excel</button>`
    );
    console.log('Patched line', i+1);
    break;
  }
}
fs.writeFileSync(path, lines.join('\n'), 'utf8');
console.log('Done');
