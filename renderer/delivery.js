/**
 * delivery.js — Renderer for the Delivery Box window.
 *
 * Fetches delivery box contents from the main process and renders them
 * as a sortable table.  Items are aggregated (multiple stacks of the same
 * item are summed) by the main process before being sent here.
 */

const coinsEl    = document.getElementById("coins-display");
const tbodyEl    = document.getElementById("delivery-body");
const statusEl   = document.getElementById("status-text");
const refreshBtn = document.getElementById("btn-refresh");

/**
 * Load delivery box data and update the UI.
 */
async function load() {
  tbodyEl.innerHTML =
    `<tr><td colspan="2">
       <div class="loading-state"><span class="spinner"></span><span>Loading…</span></div>
     </td></tr>`;
  statusEl.textContent = "";

  try {
    const { items, coins, itemNames } = await window.api.fetchDelivery();

    // ── Coins ────────────────────────────────────────────────────────────
    const coinsStr = await window.api.copperToGold(coins);
    coinsEl.innerHTML =
      `<span>💰</span>
       <span>Funds waiting: <strong class="text-accent">${coinsStr}</strong></span>`;

    // ── Items ────────────────────────────────────────────────────────────
    tbodyEl.innerHTML = "";

    const entries = Object.entries(items);
    if (!entries.length) {
      tbodyEl.innerHTML =
        `<tr><td colspan="2" class="delivery__empty">
           Delivery box is empty.
         </td></tr>`;
    } else {
      // Sort alphabetically by resolved name
      const sorted = entries
        .map(([id, qty]) => ({ name: itemNames[id] || `Item ${id}`, qty }))
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const { name, qty } of sorted) {
        const tr = document.createElement("tr");
        tr.innerHTML =
          `<td>${escHtml(name)}</td>
           <td class="right qty-cell">${qty.toLocaleString()}</td>`;
        tbodyEl.appendChild(tr);
      }
    }

    statusEl.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    coinsEl.textContent  = "Funds: N/A";
    tbodyEl.innerHTML    =
      `<tr><td colspan="2" class="text-danger" style="padding:16px">
         Error: ${escHtml(err.message)}
       </td></tr>`;
    statusEl.textContent = "Failed to load delivery box.";
  }
}

/**
 * Minimal HTML entity escaper — prevents XSS from item names.
 * @param {string} str
 * @returns {string}
 */
function escHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

refreshBtn.addEventListener("click", load);

// Load immediately on open
load();