/**
 * current-orders.js — Renderer for the Current Orders window.
 *
 * The main process retrieves the account's active buy and sell listings.
 * This renderer filters one side at a time, combines listings by item, and
 * displays a quantity-weighted unit price for each combined row.
 */

const summaryEl = document.getElementById("orders-summary");
const tbodyEl = document.getElementById("orders-body");
const statusEl = document.getElementById("status-text");
const refreshBtn = document.getElementById("btn-refresh");
const typeInputs = document.querySelectorAll('input[name="order-type"]');

/** @type {Array<object>} Raw current buy and sell listings from the API. */
let transactions = [];

/** @type {Record<number, string>} Item names resolved by the main process. */
let itemNames = {};

/**
 * Filter, combine, sort, and render the currently selected order type.
 * Listings for the same item remain separate between Buy and Sell views.
 *
 * @returns {Promise<void>}
 */
async function render() {
  const selectedType = document.querySelector('input[name="order-type"]:checked').value;
  const grouped = new Map();

  // Combine same-item listings and retain the latest listing date for sorting.
  for (const transaction of transactions) {
    if (transaction.type !== selectedType) continue;

    const existing = grouped.get(transaction.item_id) || {
      ...transaction,
      quantity: 0,
      totalValue: 0,
      latestCreated: transaction.created || "",
    };
    existing.quantity += Number(transaction.quantity) || 0;
    existing.totalValue += (Number(transaction.price) || 0) * (Number(transaction.quantity) || 0);
    if (transaction.created && transaction.created > existing.latestCreated) {
      existing.latestCreated = transaction.created;
    }
    grouped.set(transaction.item_id, existing);
  }

  // The displayed price is the quantity-weighted average of the source prices.
  const visibleTransactions = [...grouped.values()]
    .map((transaction) => ({
      ...transaction,
      price: transaction.quantity ? Math.round(transaction.totalValue / transaction.quantity) : 0,
    }))
    .sort((a, b) => new Date(b.latestCreated || 0) - new Date(a.latestCreated || 0));

  const combinedTotal = visibleTransactions.reduce((total, transaction) => total + transaction.totalValue, 0);
  const combinedTotalText = await window.api.copperToGold(combinedTotal);
  summaryEl.textContent = `${visibleTransactions.length} ${selectedType.toLowerCase()} order${visibleTransactions.length === 1 ? "" : "s"} | Total: ${combinedTotalText}`;
  tbodyEl.innerHTML = "";

  if (!visibleTransactions.length) {
    tbodyEl.innerHTML = '<tr><td colspan="6" class="orders__empty">No current orders.</td></tr>';
    return;
  }

  for (const transaction of visibleTransactions) {
    const row = document.createElement("tr");
    const name = itemNames[transaction.item_id] || `Item ${transaction.item_id}`;
    const created = transaction.latestCreated ? new Date(transaction.latestCreated).toLocaleString() : "N/A";
    row.innerHTML = `<td><span class="order-type order-type--${transaction.type.toLowerCase()}">${transaction.type}</span></td>
      <td>${escHtml(name)}</td>
      <td class="right qty-cell">${Number(transaction.quantity).toLocaleString()}</td>
      <td class="right price-cell">${await window.api.copperToGold(transaction.price)}</td>
      <td class="right price-cell">${await window.api.copperToGold(transaction.totalValue)}</td>
      <td class="text-secondary">${escHtml(created)}</td>`;
    tbodyEl.appendChild(row);
  }
}

/** Fetch the latest active listings and render the selected side. */
async function load() {
  tbodyEl.innerHTML = '<tr><td colspan="6"><div class="loading-state"><span class="spinner"></span><span>Loading…</span></div></td></tr>';
  statusEl.textContent = "";

  try {
    ({ transactions, itemNames } = await window.api.fetchCurrentTransactions());
    await render();
    statusEl.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    summaryEl.textContent = "Unable to load current orders";
    tbodyEl.innerHTML = `<tr><td colspan="6" class="text-danger orders__error">Error: ${escHtml(err.message)}</td></tr>`;
    statusEl.textContent = "Failed to load current orders.";
  }
}

/** Escape API-provided text before inserting it into table markup. */
function escHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Refresh fetches new API data; changing the radio only re-renders cached data.
refreshBtn.addEventListener("click", load);
typeInputs.forEach((input) => input.addEventListener("change", () => {
  if (transactions.length) render();
}));
load();