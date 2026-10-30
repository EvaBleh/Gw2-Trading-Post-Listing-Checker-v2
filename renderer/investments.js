const listEl = document.getElementById("investments-list");
const activePanel = document.getElementById("active-investments");
const soldPanel = document.getElementById("sold-investments");
const summaryEl = document.getElementById("investments-summary");
const newButton = document.getElementById("btn-new-investment");
const dialog = document.getElementById("investment-dialog");
const form = document.getElementById("investment-form");
const dialogTitle = document.getElementById("investment-dialog-title");
const searchSection = document.getElementById("item-search-section");
const searchInput = document.getElementById("item-search");
const searchResults = document.getElementById("item-search-results");
const selectedItemEl = document.getElementById("selected-item");
const amountInput = document.getElementById("investment-amount");
const goldInput = document.getElementById("price-gold");
const silverInput = document.getElementById("price-silver");
const copperInput = document.getElementById("price-copper");
const cancelButton = document.getElementById("investment-cancel");
const refreshItemsButton = document.getElementById("btn-refresh-items");
const refreshPricesButton = document.getElementById("btn-refresh-prices");
let investments = [];
let activeCategory = "";
let selectedItem = null;
let searchTimer = null;
let orderBooks = {};
let editingTransaction = null;
let saleTarget = null;
let activeTab = "active";
const expanded = new Set();
const soldExpanded = new Set();

function escHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function entryCategories(entry) {
  if (Array.isArray(entry?.categories)) return entry.categories.map(String);
  return [];
}

function groupHasCategory(group, categoryName) {
  if (Array.isArray(group?.categories) && group.categories.map(String).includes(categoryName)) return true;
  return (group?.entries || []).some((entry) => entryCategories(entry).includes(categoryName));
}

function filteredInvestments() {
  if (!activeCategory) return investments;
  return investments.filter((group) => groupHasCategory(group, activeCategory));
}

function filteredSold(sold) {
  if (!activeCategory) return sold;
  return sold.filter((sale) => entryCategories(sale).includes(activeCategory));
}

function highestBuyPrice(book) {
  return Number(book?.buys?.[0]?.unit_price ?? book?.buys?.[0]?.price ?? 0);
}

function lowestSellPrice(book) {
  return Number(book?.sells?.[0]?.unit_price ?? book?.sells?.[0]?.price ?? 0);
}

function afterTax(price) {
  return Math.floor((Number(price) || 0) * 85 / 100);
}

function profitPercent(profit, cost) {
  if (!Number.isFinite(profit) || !Number.isFinite(cost) || cost <= 0) return "0.0";
  return ((profit / cost) * 100).toFixed(1);
}

function signedCopperClass(value) {
  return Number(value) < 0 ? "profit--negative" : Number(value) > 0 ? "profit--positive" : "profit--neutral";
}

function resetDialog() {
  selectedItem = null;
  editingTransaction = null;
  saleTarget = null;
  searchInput.value = "";
  searchResults.innerHTML = "";
  selectedItemEl.hidden = true;
  selectedItemEl.textContent = "";
  searchSection.hidden = false;
  amountInput.value = "";
  goldInput.value = "0";
  silverInput.value = "0";
  copperInput.value = "0";
}

function openDialog(group = null) {
  resetDialog();
  if (group) {
    selectedItem = { id: group.itemId, name: group.name };
    searchSection.hidden = true;
    selectedItemEl.hidden = false;
    selectedItemEl.textContent = group.name;
    dialogTitle.textContent = `Add more ${group.name}`;
  } else {
    dialogTitle.textContent = "Add investment";
  }
  dialog.hidden = false;
  if (!group) searchInput.focus(); else amountInput.focus();
}

function openTransactionDialog(group, entry) {
  resetDialog();
  editingTransaction = { itemId: group.itemId, entryId: entry.id };
  selectedItem = { id: group.itemId, name: group.name };
  searchSection.hidden = true;
  selectedItemEl.hidden = false;
  selectedItemEl.textContent = group.name;
  dialogTitle.textContent = "Edit investment transaction";
  amountInput.value = String(entry.amount);
  const price = Number(entry.unitPrice) || 0;
  goldInput.value = String(Math.floor(price / 10000));
  silverInput.value = String(Math.floor((price % 10000) / 100));
  copperInput.value = String(price % 100);
  dialog.hidden = false;
  amountInput.focus();
}

function openSaleDialog(group, entry) {
  resetDialog();
  saleTarget = { itemId: group.itemId, entryId: entry.id, maxAmount: Number(entry.amount) || 0 };
  selectedItem = { id: group.itemId, name: group.name };
  searchSection.hidden = true;
  selectedItemEl.hidden = false;
  selectedItemEl.textContent = group.name;
  dialogTitle.textContent = "Mark investment sold";
  amountInput.value = String(saleTarget.maxAmount);
  const currentPrice = lowestSellPrice(orderBooks[group.itemId] || {});
  const price = Number(currentPrice) || 0;
  goldInput.value = String(Math.floor(price / 10000));
  silverInput.value = String(Math.floor((price % 10000) / 100));
  copperInput.value = String(price % 100);
  dialog.hidden = false;
  amountInput.focus();
}

function closeDialog() {
  dialog.hidden = true;
}

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  if (!query.length) {
    searchResults.innerHTML = "";
    selectedItem = null;
    searchSection.hidden = false;
    selectedItemEl.hidden = true;
    return;
  }

  searchResults.innerHTML = '<div class="investments__search-empty">Searching…</div>';
  searchTimer = setTimeout(async () => {
    try {
      const items = await window.api.searchInvestmentItems(query);
      searchResults.innerHTML = "";
      if (!items.length) {
        searchResults.innerHTML = '<div class="investments__search-empty">No items found.</div>';
        return;
      }
      for (const item of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "investments__search-result";
        button.textContent = item.name;
        button.addEventListener("click", () => {
          selectedItem = item;
          searchSection.hidden = true;
          selectedItemEl.hidden = false;
          selectedItemEl.textContent = item.name;
          amountInput.focus();
          searchResults.innerHTML = "";
        });
        searchResults.appendChild(button);
      }
    } catch (error) {
      searchResults.innerHTML = `<div class="investments__search-empty text-danger">${escHtml(error.message)}</div>`;
    }
  }, 250);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedItem) {
    searchInput.focus();
    return;
  }
  const amount = Number(amountInput.value);
  const gold = Number(goldInput.value) || 0;
  const silver = Number(silverInput.value) || 0;
  const copper = Number(copperInput.value) || 0;
  if (!Number.isInteger(amount) || amount <= 0) return;
  const unitPrice = gold * 10000 + silver * 100 + copper;

  try {
    if (saleTarget) {
      if (amount > saleTarget.maxAmount) throw new Error("Sold amount cannot exceed the original investment amount.");
      const result = await window.api.markInvestmentSold({
        itemId: saleTarget.itemId,
        entryId: saleTarget.entryId,
        amount,
        soldPrice: unitPrice,
      });
      investments = result.investments;
      expanded.add(String(saleTarget.itemId));
    } else if (editingTransaction) {
      investments = await window.api.updateInvestmentEntry({
        itemId: editingTransaction.itemId,
        entryId: editingTransaction.entryId,
        amount,
        unitPrice,
      });
      expanded.add(String(editingTransaction.itemId));
    } else {
      investments = await window.api.addInvestment({
        itemId: selectedItem.id,
        name: selectedItem.name,
        amount,
        unitPrice,
        categoryName: activeCategory || null,
      });
      expanded.add(String(selectedItem.id));
    }
    closeDialog();
    await refreshMarketPrices();
    await render();
  } catch (error) {
    alert(error.message);
  }
});

newButton.addEventListener("click", () => openDialog());
refreshItemsButton.addEventListener("click", async () => {
  refreshItemsButton.disabled = true;
  refreshItemsButton.textContent = "Refreshing…";
  try {
    const status = await window.api.refreshItemDatabase();
    searchResults.innerHTML = `<div class="investments__search-empty text-success">Local item database updated: ${status.count.toLocaleString()} items.</div>`;
  } catch (error) {
    searchResults.innerHTML = `<div class="investments__search-empty text-danger">${escHtml(error.message)}</div>`;
  } finally {
    refreshItemsButton.disabled = false;
    refreshItemsButton.textContent = "↺ Items";
  }
});
cancelButton.addEventListener("click", closeDialog);
dialog.addEventListener("click", (event) => { if (event.target === dialog) closeDialog(); });

async function refreshMarketPrices() {
  const ids = [...new Set(investments.map((group) => Number(group.itemId)).filter((id) => id > 0))];
  if (!ids.length) {
    orderBooks = {};
    return;
  }
  const refreshedBooks = await window.api.fetchOrderBooks(ids);
  orderBooks = {
    ...orderBooks,
    ...Object.fromEntries(ids.map((id) => {
      const book = refreshedBooks[id];
      return book ? [id, book] : [id, orderBooks[id] || {}];
    }).filter(([, book]) => Object.keys(book).length)),
  };
}

function showInvestmentTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".investments__tab").forEach((button) => {
    button.classList.toggle("investments__tab--active", button.dataset.tab === tab);
  });
  activePanel.hidden = tab !== "active";
  soldPanel.hidden = tab !== "sold";
  if (tab === "sold") renderSoldInvestments();
  else render();
}

document.querySelectorAll(".investments__tab").forEach((button) => {
  button.addEventListener("click", () => showInvestmentTab(button.dataset.tab));
});

refreshPricesButton.addEventListener("click", async () => {
  refreshPricesButton.disabled = true;
  refreshPricesButton.textContent = "Loading…";
  try {
    await refreshMarketPrices();
    await render();
  } catch (error) {
    alert(error.message);
  } finally {
    refreshPricesButton.disabled = false;
    refreshPricesButton.textContent = "↺ Prices";
  }
});

async function renderSoldInvestments() {
  const sold = filteredSold(await window.api.getSoldInvestments());
  if (!sold.length) {
    soldPanel.innerHTML = '<div class="investments__empty">No sold investments yet.</div>';
    summaryEl.innerHTML = '<div class="investments__summary-row"><span>0 gold sold</span><span>0 gold profit</span><span>Avg profit: 0.0%</span></div>';
    return;
  }

  let totalSoldValue = 0;
  let totalProfit = 0;
  let totalInvestedCost = 0;
  const grouped = new Map();

  for (const sale of sold) {
    const soldAmount = Number(sale.soldAmount) || 0;
    const soldPrice = Number(sale.soldPrice) || 0;
    const investedUnit = Number(sale.investedUnitPrice) || 0;
    const soldValue = soldPrice * soldAmount;
    const investedCost = investedUnit * soldAmount;
    totalSoldValue += soldValue;
    totalInvestedCost += investedCost;
    totalProfit += (afterTax(soldPrice) - investedUnit) * soldAmount;

    const key = String(sale.itemId);
    if (!grouped.has(key)) grouped.set(key, { itemId: key, name: sale.itemName, sales: [] });
    grouped.get(key).sales.push(sale);
  }

  const averageProfit = totalInvestedCost > 0 ? (totalProfit / totalInvestedCost) * 100 : 0;
  summaryEl.innerHTML = `
    <div class="investments__summary-row">
      <span>${await window.api.copperToGold(totalSoldValue)} sold</span>
      <span class="${signedCopperClass(totalProfit)}">${await window.api.copperToGold(totalProfit)} profit</span>
      <span>Avg profit: ${averageProfit.toFixed(1)}%</span>
    </div>`;

  const cards = [];
  for (const group of grouped.values()) {
    const sales = group.sales;
    const soldAmount = sales.reduce((sum, sale) => sum + (Number(sale.soldAmount) || 0), 0);
    const soldValue = sales.reduce((sum, sale) => sum + (Number(sale.soldPrice) || 0) * (Number(sale.soldAmount) || 0), 0);
    const investedCost = sales.reduce((sum, sale) => sum + (Number(sale.investedUnitPrice) || 0) * (Number(sale.soldAmount) || 0), 0);
    const profit = sales.reduce((sum, sale) => sum + ((afterTax(Number(sale.soldPrice) || 0) - (Number(sale.investedUnitPrice) || 0)) * (Number(sale.soldAmount) || 0)), 0);
    const percent = profitPercent(profit, investedCost);
    const isOpen = soldExpanded.has(String(group.itemId));

    const rows = [];
    for (const sale of [...sales].reverse()) {
      const amount = Number(sale.soldAmount) || 0;
      const cost = amount * (Number(sale.investedUnitPrice) || 0);
      const saleProfit = (afterTax(Number(sale.soldPrice) || 0) - (Number(sale.investedUnitPrice) || 0)) * amount;
      rows.push(`<tr><td>${escHtml(new Date(sale.soldAt).toLocaleString())}</td><td class="right">${amount.toLocaleString()}</td><td class="right">${await window.api.copperToGold(sale.investedUnitPrice)}</td><td class="right">${await window.api.copperToGold(sale.soldPrice)}</td><td class="right ${signedCopperClass(saleProfit)}">${await window.api.copperToGold(saleProfit)} (${profitPercent(saleProfit, cost)}%)</td></tr>`);
    }

    cards.push(`
      <section class="investments__card sold-investments__card">
        <button type="button" class="sold-investments__group" data-item-id="${escHtml(group.itemId)}">
          <span class="${isOpen ? "sold-investments__chevron--open" : ""}">${isOpen ? "▼" : "▶"}</span>
          <strong>${escHtml(group.name)}</strong>
          <span>${soldAmount.toLocaleString()} sold</span>
          <span>${await window.api.copperToGold(soldValue)} sold</span>
          <span class="${signedCopperClass(profit)}">${await window.api.copperToGold(profit)} profit (${percent}%)</span>
        </button>
        <div class="sold-investments__transactions${isOpen ? "" : " sold-investments__transactions--hidden"}">
          <table class="investments__table"><thead><tr><th>Sold date</th><th class="right">Amount</th><th class="right">Invested/unit</th><th class="right">Sold/unit</th><th class="right">Profit</th></tr></thead><tbody>${rows.join("")}</tbody></table>
        </div>
      </section>`);
  }

  soldPanel.innerHTML = cards.join("");
  for (const button of soldPanel.querySelectorAll(".sold-investments__group")) {
    button.addEventListener("click", () => {
      const itemId = button.dataset.itemId;
      if (soldExpanded.has(itemId)) soldExpanded.delete(itemId);
      else soldExpanded.add(itemId);
      renderSoldInvestments();
    });
  }
}

async function render() {
  listEl.innerHTML = "";
  if (activeTab === "sold") {
    await renderSoldInvestments();
    return;
  }
  const visibleInvestments = filteredInvestments();
  if (!visibleInvestments.length) {
    summaryEl.textContent = activeCategory
      ? `0 investments in ${activeCategory} | Total invested: ${await window.api.copperToGold(0)}`
      : "0 investments | Total invested: " + await window.api.copperToGold(0);
    listEl.innerHTML = '<div class="investments__empty">No investments yet. Add your first item above.</div>';
    return;
  }

  let totalAmount = 0;
  let totalCost = 0;
  for (const group of visibleInvestments) {
    for (const entry of group.entries || []) {
      totalAmount += Number(entry.amount) || 0;
      totalCost += (Number(entry.amount) || 0) * (Number(entry.unitPrice) || 0);
    }
  }
  let overallSellValue = 0;
  let overallSellProfit = 0;
  let overallBuyProfit = 0;
  for (const group of visibleInvestments) {
    const book = orderBooks[group.itemId] || {};
    const buyUnit = afterTax(highestBuyPrice(book));
    const sellUnit = lowestSellPrice(book);
    const amount = (group.entries || []).reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
    overallSellValue += sellUnit * amount;
    for (const entry of group.entries || []) {
      const entryAmount = Number(entry.amount) || 0;
      const investedUnit = Number(entry.unitPrice) || 0;
      overallBuyProfit += ((buyUnit ? buyUnit - investedUnit : 0) * entryAmount);
      overallSellProfit += ((sellUnit ? sellUnit - investedUnit : 0) * entryAmount);
    }
  }
  const profitSummary = [
    `<span class="profit-pill profit-pill--buy ${signedCopperClass(overallBuyProfit)}">Buy profit: ${await window.api.copperToGold(overallBuyProfit)} (${profitPercent(overallBuyProfit, totalCost)}%)</span>`,
    `<span class="profit-pill profit-pill--sell ${signedCopperClass(overallSellProfit)}">Sell profit: ${await window.api.copperToGold(overallSellProfit)} (${profitPercent(overallSellProfit, totalCost)}%)</span>`,
    `<span class="profit-pill profit-pill--value">Current sell value: ${await window.api.copperToGold(overallSellValue)}</span>`,
  ].join("");
  summaryEl.innerHTML = `<div class="investments__summary-row"><span>${visibleInvestments.length} item${visibleInvestments.length === 1 ? "" : "s"}</span><span>${totalAmount.toLocaleString()} units</span><span>Total invested: ${await window.api.copperToGold(totalCost)}</span>${profitSummary}</div>`;

  for (const group of visibleInvestments) {
    const entries = group.entries || [];
    const amount = entries.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
    const cost = entries.reduce((sum, entry) => sum + (Number(entry.amount) || 0) * (Number(entry.unitPrice) || 0), 0);
    const average = amount ? Math.round(cost / amount) : 0;
    const book = orderBooks[group.itemId] || {};
    const currentBuy = highestBuyPrice(book);
    const currentSell = lowestSellPrice(book);
    const buyUnitNet = afterTax(currentBuy);
    const itemBuyProfit = buyUnitNet ? entries.reduce((sum, entry) => sum + ((buyUnitNet - (Number(entry.unitPrice) || 0)) * (Number(entry.amount) || 0)), 0) : 0;
    const itemSellProfit = currentSell ? entries.reduce((sum, entry) => sum + ((currentSell - (Number(entry.unitPrice) || 0)) * (Number(entry.amount) || 0)), 0) : 0;
    const isOpen = expanded.has(String(group.itemId));

    const card = document.createElement("section");
    card.className = "investments__card";
    card.innerHTML = `
      <div class="investments__card-header">
        <button type="button" class="investments__toggle" aria-label="${isOpen ? "Collapse" : "Expand"}">${isOpen ? "▼" : "▶"}</button>
        <div class="investments__name">${escHtml(group.name)}</div>
        <div class="investments__summary-item">${amount.toLocaleString()} units</div>
        <div class="investments__summary-item">Avg: ${await window.api.copperToGold(average)}</div>
        <div class="investments__summary-item">Cost: ${await window.api.copperToGold(cost)}</div>
        <div class="investments__market-profit">
          <span>Buy: ${currentBuy ? await window.api.copperToGold(currentBuy) : "N/A"}</span>
          <span>Sell: ${currentSell ? await window.api.copperToGold(currentSell) : "N/A"}</span>
          <span class="${signedCopperClass(itemBuyProfit)}">Buy profit: ${currentBuy ? `${await window.api.copperToGold(itemBuyProfit)} (${profitPercent(itemBuyProfit, cost)}%)` : "N/A"}</span>
          <span class="${signedCopperClass(itemSellProfit)}">Sell profit: ${currentSell ? `${await window.api.copperToGold(itemSellProfit)} (${profitPercent(itemSellProfit, cost)}%)` : "N/A"}</span>
        </div>
        <div class="investments__item-actions">
          <button type="button" class="investments__action investments__remove-item" title="Remove item and all transactions">🗑</button>
          <button type="button" class="investments__plus" title="Add more">+</button>
        </div>
      </div>
      <div class="investments__entries${isOpen ? "" : " investments__entries--hidden"}"></div>`;

    const toggle = card.querySelector(".investments__toggle");
    const toggleGroup = () => {
      if (expanded.has(String(group.itemId))) expanded.delete(String(group.itemId));
      else expanded.add(String(group.itemId));
      render();
    };
    toggle.addEventListener("click", (event) => { event.stopPropagation(); toggleGroup(); });
    card.querySelector(".investments__card-header").addEventListener("click", (event) => {
      if (!event.target.closest("button")) toggleGroup();
    });
    card.querySelector(".investments__plus").addEventListener("click", () => openDialog(group));
    card.querySelector(".investments__remove-item").addEventListener("click", async () => {
      if (!window.confirm(`Remove "${group.name}" and all of its transactions?`)) return;
      try {
        investments = await window.api.removeInvestmentItem(group.itemId);
        expanded.delete(String(group.itemId));
        await refreshMarketPrices();
        await render();
      } catch (error) {
        alert(error.message);
      }
    });

    const entriesEl = card.querySelector(".investments__entries");
    if (isOpen) {
      const table = document.createElement("table");
      table.className = "investments__table";
      table.innerHTML = `<thead><tr><th>Date</th><th class="right">Amount</th><th class="right">Invested/unit</th><th class="right">Total Cost</th><th class="right">Buy Profit</th><th class="right">Sell Profit</th><th class="right">Actions</th></tr></thead>`;
      const tbody = document.createElement("tbody");
      for (const entry of [...entries].reverse()) {
        const row = document.createElement("tr");
        const date = new Date(entry.created).toLocaleString();
        const entryAmount = Number(entry.amount) || 0;
        const entryBuyProfit = buyUnitNet ? (buyUnitNet - (Number(entry.unitPrice) || 0)) * entryAmount : 0;
        const entrySellProfit = currentSell ? (currentSell - (Number(entry.unitPrice) || 0)) * entryAmount : 0;
        const entryCost = entryAmount * (Number(entry.unitPrice) || 0);
        const entryBuyText = currentBuy
          ? `${await window.api.copperToGold(entryBuyProfit)} (${profitPercent(entryBuyProfit, entryCost)}%)`
          : "N/A";
        const entrySellText = currentSell
          ? `${await window.api.copperToGold(entrySellProfit)} (${profitPercent(entrySellProfit, entryCost)}%)`
          : "N/A";
        row.innerHTML = `<td>${escHtml(date)}</td><td class="right">${entryAmount.toLocaleString()}</td><td class="right">${await window.api.copperToGold(entry.unitPrice)}</td><td class="right">${await window.api.copperToGold(entryCost)}</td><td class="right ${signedCopperClass(entryBuyProfit)}">${entryBuyText}</td><td class="right ${signedCopperClass(entrySellProfit)}">${entrySellText}</td><td class="right investments__row-actions"><button type="button" class="investments__action investments__edit-entry" title="Edit transaction">✎</button><button type="button" class="investments__action investments__mark-sold" title="Mark sold">✓</button><button type="button" class="investments__action investments__remove-entry" title="Remove transaction">🗑</button></td>`;
        row.querySelector(".investments__edit-entry").addEventListener("click", () => openTransactionDialog(group, entry));
        row.querySelector(".investments__mark-sold").addEventListener("click", () => openSaleDialog(group, entry));
        row.querySelector(".investments__remove-entry").addEventListener("click", async () => {
          if (!window.confirm("Remove this investment transaction?")) return;
          try {
            investments = await window.api.removeInvestmentEntry({ itemId: group.itemId, entryId: entry.id });
            await refreshMarketPrices();
            await render();
          } catch (error) {
            alert(error.message);
          }
        });
        tbody.appendChild(row);
      }
      table.appendChild(tbody);
      entriesEl.appendChild(table);
    }
    listEl.appendChild(card);
  }
}

async function load() {
  try {
    const queryCategory = new URLSearchParams(window.location.search).get("category") || "";
    activeCategory = queryCategory;
    if (activeCategory) document.title = `${activeCategory} Investments`;

    investments = await window.api.getInvestments();
    const catalogStatus = await window.api.getItemDatabaseStatus();
    if (catalogStatus.count) {
      refreshItemsButton.title = `Local database: ${catalogStatus.count.toLocaleString()} items${catalogStatus.updatedAt ? ` (updated ${new Date(catalogStatus.updatedAt).toLocaleDateString()})` : ""}`;
    } else {
      refreshItemsButton.title = "Local item database is empty; click to download it";
    }
    try {
      await refreshMarketPrices();
    } catch (error) {
      console.error("Unable to refresh investment market prices:", error);
    }
    await render();
  } catch (error) {
    summaryEl.textContent = "Unable to load investments";
    listEl.innerHTML = `<div class="text-danger investments__empty">${escHtml(error.message)}</div>`;
  }
}

load();
