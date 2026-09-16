/**
 * raw-transaction-history.js — Renderer for the uncollapsed transaction archive.
 *
 * Displays each saved transaction as formatted JSON so every original API
 * field remains visible instead of being grouped into summary rows.
 */

const dataEl = document.getElementById("raw-history-data");
const statusEl = document.getElementById("status-text");
const refreshBtn = document.getElementById("btn-refresh");

/** Fetch the latest incremental archive and render every raw transaction. */
async function load() {
  dataEl.textContent = "Loading raw transaction history…";
  statusEl.textContent = "Loading…";

  try {
    const { transactions } = await window.api.fetchTransactionHistory(true);
    dataEl.textContent = transactions.length
      ? JSON.stringify(transactions, null, 2)
      : "No transaction history has been saved.";
    statusEl.textContent = `${transactions.length.toLocaleString()} transaction${transactions.length === 1 ? "" : "s"}`;
  } catch (error) {
    dataEl.textContent = `Unable to load transaction history.\n\n${error.message}`;
    statusEl.textContent = "Failed to load transaction history.";
  }
}

refreshBtn.addEventListener("click", load);
load();
