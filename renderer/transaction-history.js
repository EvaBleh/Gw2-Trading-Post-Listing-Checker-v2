/**
 * transaction-history.js — Renderer for completed Trading Post transactions.
 *
 * History is fetched once per refresh. The selected Buy or Sell side is then
 * grouped by item, with expandable canvas charts showing daily quantities.
 */

const bodyEl = document.getElementById("history-body");
const totalEl = document.getElementById("history-total");
const statusEl = document.getElementById("status-text");
const refreshBtn = document.getElementById("btn-refresh");
const clearBtn = document.getElementById("btn-clear");
const rawBtn = document.getElementById("btn-raw");
const typeInputs = document.querySelectorAll('input[name="history-type"]');
const searchEl = document.getElementById("history-search");

/** @type {Array<object>} Raw completed transactions from both API history endpoints. */
let transactions = [];

/** @type {Record<number, string>} Item names resolved by the main process. */
let itemNames = {};

/** @type {Record<string, Array<object>>} Aggregated groups, built once per fetch. */
let groupedTransactions = { Buy: [], Sell: [] };

/** Format a copper amount as gold, silver, and copper for display. */
function copperToGold(copper) {
  if (copper == null) return "N/A";
  const gold = Math.floor(copper / 10000);
  const silver = Math.floor((copper % 10000) / 100);
  const copperRemainder = copper % 100;
  return `${gold}g ${silver}s ${copperRemainder}c`;
}

// The main process sends progress while the authenticated history request runs.
window.api.on("transaction-history-status", (message) => {
  statusEl.textContent = message;
});

/** Aggregate transactions by type, item, and day once per fetch. */
function groupTransactions() {
  groupedTransactions = { Buy: [], Sell: [] };
  const groupsByType = { Buy: new Map(), Sell: new Map() };

  for (const transaction of transactions) {
    const groups = groupsByType[transaction.type];
    if (!groups) continue;
    const group = groups.get(transaction.item_id) || {
      itemId: transaction.item_id,
      quantity: 0,
      totalValue: 0,
      daily: new Map(),
    };
    const quantity = Number(transaction.quantity) || 0;
    const price = Number(transaction.price) || 0;
    const day = transaction.created ? transaction.created.slice(0, 10) : "Unknown";
    group.quantity += quantity;
    group.totalValue += quantity * price;
    const dailyEntry = group.daily.get(day) || { quantity: 0, totalValue: 0 };
    dailyEntry.quantity += quantity;
    dailyEntry.totalValue += quantity * price;
    group.daily.set(day, dailyEntry);
    groups.set(transaction.item_id, group);
  }

  for (const type of ["Buy", "Sell"]) {
    groupedTransactions[type] = [...groupsByType[type].values()];
  }
}

/**
 * Filter the selected transaction type, update totals, and render item rows.
 * Each group's totalValue is calculated in copper before formatting.
 *
 * @returns {Promise<void>}
 */
async function render() {
  statusEl.textContent = "Combining transactions by item…";
  const selectedType = document.querySelector('input[name="history-type"]:checked').value;
  const searchTerm = searchEl.value.trim().toLocaleLowerCase();
  const allItems = groupedTransactions[selectedType];
  const fullTotal = allItems.reduce((total, item) => total + item.totalValue, 0);
  const items = allItems.filter((item) => {
    const name = itemNames[item.itemId] || `Item ${item.itemId}`;
    return !searchTerm || name.toLocaleLowerCase().includes(searchTerm);
  }).sort((a, b) => b.totalValue - a.totalValue);
  const itemCount = items.length;
  totalEl.textContent = copperToGold(fullTotal);

  const itemsByName = items.sort((a, b) => {
    const nameA = itemNames[a.itemId] || `Item ${a.itemId}`;
    const nameB = itemNames[b.itemId] || `Item ${b.itemId}`;
    return b.totalValue - a.totalValue || nameA.localeCompare(nameB);
  });
  statusEl.textContent = `${itemCount} item${itemCount === 1 ? "" : "s"} shown`;
  bodyEl.innerHTML = "";

  if (!items.length) {
    bodyEl.innerHTML = '<div class="history__empty">No transaction history for this account.</div>';
    return;
  }

  for (const item of itemsByName) {
    const name = itemNames[item.itemId] || `Item ${item.itemId}`;
    const row = document.createElement("section");
    row.className = "history-item";
    row.innerHTML = `<button class="history-item__header" type="button" aria-expanded="false">
      <span class="history-item__name"><span class="history-item__chevron">›</span>${escHtml(name)}</span>
      <span class="history-item__stats"><span>${item.quantity.toLocaleString()} units</span><strong>${copperToGold(item.totalValue)}</strong></span>
    </button>
    <div class="history-item__details" hidden>
      <div class="history-item__chart-heading">${selectedType === "Sell" ? "Sold" : "Bought"} per day</div>
      <canvas class="history-chart" width="760" height="210" aria-label="${escHtml(name)} daily transaction chart"></canvas>
      <div class="history-chart-tooltip" hidden></div>
    </div>`;
    const header = row.querySelector(".history-item__header");
    const details = row.querySelector(".history-item__details");
    header.addEventListener("click", () => {
      const expanded = !details.hidden;
      details.hidden = expanded;
      header.setAttribute("aria-expanded", String(!expanded));
      header.querySelector(".history-item__chevron").classList.toggle("is-open", !expanded);
      if (!expanded) drawChart(row.querySelector("canvas"), fillMissingDays(item.daily), selectedType);
    });
    bodyEl.appendChild(row);
  }
}

/** Add zero-value entries so the chart represents every calendar day. */
function fillMissingDays(daily) {
  const datedEntries = [...daily.keys()].filter((day) => day !== "Unknown").sort();
  if (datedEntries.length < 2) return daily;

  const complete = new Map(daily);
  const start = new Date(`${datedEntries[0]}T00:00:00Z`);
  const end = new Date(`${datedEntries[datedEntries.length - 1]}T00:00:00Z`);
  for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    const day = date.toISOString().slice(0, 10);
    if (!complete.has(day)) complete.set(day, { quantity: 0, totalValue: 0 });
  }
  return complete;
}

/**
 * Draw a bar chart of daily quantities for one expanded item row.
 *
 * @param {HTMLCanvasElement} canvas Chart surface.
 * @param {Map<string, {quantity: number, totalValue: number}>} daily Daily quantities and copper totals.
 * @param {string} selectedType Buy or Sell, used to choose the bar color.
 */
function drawChart(canvas, daily, selectedType) {
  canvas.chartData = { daily, selectedType };
  const context = canvas.getContext("2d");
  const entries = [...daily.entries()].sort(([a], [b]) => a.localeCompare(b));
  const displayWidth = Math.max(canvas.clientWidth, 320);
  const displayHeight = 210;
  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = displayWidth * pixelRatio;
  canvas.height = displayHeight * pixelRatio;
  const width = displayWidth;
  const height = displayHeight;
  const left = 52;
  const bottom = 34;
  const chartHeight = height - bottom - 12;
  const max = Math.max(...entries.map(([, value]) => value.quantity), 1);
  const step = (width - left - 12) / entries.length;
  const barWidth = Math.max(1, step - 2);
  const labelInterval = Math.max(1, Math.ceil(entries.length / 12));
  context.scale(pixelRatio, pixelRatio);
  const details = canvas.closest(".history-item__details");
  const tooltip = details.querySelector(".history-chart-tooltip");
  context.clearRect(0, 0, width, height);
  context.font = "12px Segoe UI";
  context.fillStyle = "#9ab3d5";
  context.strokeStyle = "#2a4a7f";
  context.beginPath();
  context.moveTo(left, 8);
  context.lineTo(left, height - bottom);
  context.lineTo(width - 8, height - bottom);
  context.stroke();
  entries.forEach(([day, value], index) => {
    const x = left + 8 + index * ((width - left - 12) / entries.length);
    const barHeight = (value.quantity / max) * chartHeight;
    context.fillStyle = selectedType === "Sell" ? "#4caf80" : "#5aabdb";
    context.fillRect(x, height - bottom - barHeight, barWidth, barHeight);
    context.fillStyle = "#9ab3d5";
    context.textAlign = "center";
    if (index % labelInterval === 0 || index === entries.length - 1) {
      context.fillText(day === "Unknown" ? "?" : day.slice(5), x + barWidth / 2, height - 12);
    }
    if (entries.length <= 14) {
      context.fillText(value.quantity.toLocaleString(), x + barWidth / 2, height - bottom - barHeight - 5);
    }
  });

  canvas.onmousemove = async (event) => {
    const bounds = canvas.getBoundingClientRect();
    const canvasX = (event.clientX - bounds.left) * (width / bounds.width);
    const index = Math.floor((canvasX - left - 8) / ((width - left - 12) / entries.length));
    if (index < 0 || index >= entries.length) {
      tooltip.hidden = true;
      return;
    }
    const [day, value] = entries[index];
    const gold = copperToGold(value.totalValue);
    tooltip.textContent = `${day === "Unknown" ? "Unknown date" : new Date(`${day}T00:00:00`).toLocaleDateString()}: ${value.quantity.toLocaleString()} ${selectedType === "Sell" ? "sold" : "bought"} · ${gold}`;
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(event.clientX - details.getBoundingClientRect().left + 12, details.clientWidth - tooltip.offsetWidth - 8)}px`;
    tooltip.style.top = `${event.clientY - details.getBoundingClientRect().top - tooltip.offsetHeight - 8}px`;
  };
  canvas.onmouseleave = () => { tooltip.hidden = true; };
}

/** Escape API-provided text before inserting it into row markup. */
function escHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Fetch the latest completed transactions and render the selected side. */
async function load(forceRefresh = false) {
  bodyEl.innerHTML = '<div class="loading-state"><span class="spinner"></span><span>Loading…</span></div>';
  statusEl.textContent = "Starting transaction history refresh…";
  try {
    ({ transactions, itemNames } = await window.api.fetchTransactionHistory(forceRefresh));
    groupTransactions();
    await render();
    statusEl.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    totalEl.textContent = "N/A";
    bodyEl.innerHTML = `<div class="history__empty text-danger">Error: ${escHtml(error.message)}</div>`;
    statusEl.textContent = "Failed to load transaction history.";
  }
}

// Refresh fetches new API data; changing the radio only re-renders cached data.
refreshBtn.addEventListener("click", () => load(true));
rawBtn.addEventListener("click", () => window.api.openRawTransactionHistoryWindow());
clearBtn.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Clear all saved transaction history? This cannot be undone and will remove history older than the GW2 API limit too."
  );
  if (!confirmed) return;
  await window.api.clearTransactionHistory();
  transactions = [];
  itemNames = {};
  groupedTransactions = { Buy: [], Sell: [] };
  totalEl.textContent = "0g 0s 0c";
  await render();
  statusEl.textContent = "Transaction history cleared.";
});
typeInputs.forEach((input) => input.addEventListener("change", () => {
  if (transactions.length) render();
}));
searchEl.addEventListener("input", () => {
  if (transactions.length) render();
});
window.addEventListener("resize", () => {
  document.querySelectorAll(".history-chart").forEach((canvas) => {
    if (!canvas.closest(".history-item__details").hidden && canvas.chartData) {
      drawChart(canvas, fillMissingDays(canvas.chartData.daily), canvas.chartData.selectedType);
    }
  });
});
load();