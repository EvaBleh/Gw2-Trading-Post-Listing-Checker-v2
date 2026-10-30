/**
 * raw-transaction-history.js — Renderer for the uncollapsed transaction archive.
 *
 * Displays each saved transaction as formatted JSON so every original API
 * field remains visible instead of being grouped into summary rows.
 */

const dataEl = document.getElementById("raw-history-data");
const statusEl = document.getElementById("status-text");
const progressEl = document.getElementById("history-progress");
const refreshBtn = document.getElementById("btn-refresh");
const importBtn = document.getElementById("btn-import");

/** Render the saved archive without waiting for network requests. */
async function loadSaved() {
  try {
    const { transactions } = await window.api.getTransactionHistory();
    dataEl.textContent = transactions.length
      ? JSON.stringify(transactions, null, 2)
      : "No transaction history has been saved.";
    statusEl.textContent = `${transactions.length.toLocaleString()} transaction${transactions.length === 1 ? "" : "s"}`;
  } catch (error) {
    dataEl.textContent = `Unable to load saved transaction history.\n\n${error.message}`;
    statusEl.textContent = "Failed to load saved history.";
  }
}

/** Refresh the archive incrementally, then render the persisted result. */
async function load() {
  statusEl.textContent = "Refreshing transaction history…";
  try {
    await window.api.fetchTransactionHistory(false);
    await loadSaved();
  } catch (error) {
    statusEl.textContent = `Refresh failed; showing saved history: ${error.message}`;
  }
}

async function importHistory() {
  statusEl.textContent = "Select a transaction JSON file to import…";
  try {
    const result = await window.api.importTransactionHistory();
    if (result.canceled) {
      await loadSaved();
      return;
    }
    await loadSaved();
    statusEl.textContent = `Imported ${result.importedCount.toLocaleString()} records; archive now contains ${result.archiveCount.toLocaleString()}.`;
  } catch (error) {
    statusEl.textContent = `Import failed: ${error.message}`;
  }
}

window.api.on("transaction-history-progress", ({ message, active }) => {
  progressEl.textContent = message;
  progressEl.hidden = !active;
});
window.api.getTransactionHistoryProgress().then(({ message, active }) => {
  progressEl.textContent = message;
  progressEl.hidden = !active;
});
window.api.on("transaction-history-updated", loadSaved);
importBtn.addEventListener("click", importHistory);
refreshBtn.addEventListener("click", load);
load();
