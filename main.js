/**
 * main.js — Electron main process
 *
 * Responsibilities:
 *  - Create and manage all BrowserWindows (launcher, category, delivery, settings)
 *  - Read / write config.json from the user's app-data directory
 *  - Perform all GW2 API calls (network access is only allowed in the main
 *    process; renderer processes communicate via IPC)
 *  - Expose a clean IPC surface so renderer code never touches Node APIs directly
 */

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path  = require("path");
const fs = require("fs");
const https = require("https");
const http  = require("http");

if (require("electron-squirrel-startup")) return;
const { updateElectronApp } = require("update-electron-app");
updateElectronApp();
// ---------------------------------------------------------------------------
// Main-process modules
// ---------------------------------------------------------------------------
const { createStorage } = require("./src/main/storage");
const { createWindowManager } = require("./src/main/windows");

const storage = createStorage(app.getPath("userData"));
const {
  loadConfig, saveConfig, loadTransactionHistory, saveTransactionHistory,
  loadInvestments, saveInvestments, loadSoldInvestments, saveSoldInvestments,
  loadItemDatabase, saveItemDatabase, mergeTransactionHistory,
} = storage;

const windows = createWindowManager({ mainDir: __dirname, loadConfig });

// ---------------------------------------------------------------------------
// GW2 API helpers
// ---------------------------------------------------------------------------

const API_BASE  = "https://api.guildwars2.com/v2";
const PAGE_SIZE = 200;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_CONCURRENCY = 4;
const HISTORY_REFRESH_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_FULL_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const HISTORY_SYNC_RETRY_MS = 30 * 60 * 1000;

/**
 * Minimal promise-based HTTP GET that works with both http and https.
 * Returns parsed JSON or throws on non-2xx status.
 *
 * @param {string} url
 * @param {string|null} bearerToken  Authorization header value (without "Bearer ")
 * @returns {Promise<{data: any, headers: object}>}
 */
function httpGet(url, bearerToken = null, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod     = url.startsWith("https") ? https : http;
    const options = { headers: {} };
    if (bearerToken) options.headers["Authorization"] = `Bearer ${bearerToken}`;

    const req = mod.get(url, options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }
        try {
          resolve({ data: JSON.parse(raw), headers: res.headers });
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error("Request timeout")); });
  });
}

async function httpGetRetry(url, bearerToken = null, maxAttempts = 3, timeoutMs = REQUEST_TIMEOUT_MS) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await httpGet(url, bearerToken, timeoutMs);
    } catch (error) {
      lastError = error;
      const retryable = /Request timeout|HTTP (429|502|503|504)|ECONNRESET|ENOTFOUND|ETIMEDOUT|ECONNREFUSED/.test(error.message || "");
      if (!retryable || attempt === maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

/**
 * Fetch a single GW2 API endpoint (no pagination).
 *
 * @param {string} path     e.g. "/commerce/delivery"
 * @param {boolean} useKey  Whether to attach the stored API key
 * @returns {Promise<any>}
 */
async function apiGet(path, useKey = true, maxAttempts = 3, timeoutMs = REQUEST_TIMEOUT_MS) {
  const cfg = loadConfig();
  const token = useKey ? cfg.api_key : null;
  const { data } = await httpGetRetry(`${API_BASE}${path}`, token, maxAttempts, timeoutMs);
  return data;
}

/**
 * Fetch all pages of a paginated GW2 endpoint using page_size=PAGE_SIZE.
 * The GW2 API returns X-Page-Total in response headers.
 *
 * @param {string} path    e.g. "/commerce/transactions/current/sells"
 * @param {boolean} useKey
 * @returns {Promise<any[]>}
 */
async function apiGetAllPages(path, useKey = true, onPage = null) {
  const cfg   = loadConfig();
  const token = useKey ? cfg.api_key : null;
  const sep   = path.includes("?") ? "&" : "?";

  const { data: firstPage, headers } = await httpGetRetry(
    `${API_BASE}${path}${sep}page=0&page_size=${PAGE_SIZE}`,
    token
  );

  const totalPages = parseInt(headers["x-page-total"] || "1", 10);
  const all        = Array.isArray(firstPage) ? [...firstPage] : [];
  onPage?.(1, totalPages);

  // Fetch a few pages at a time so large accounts do not overwhelm the API.
  for (let start = 1; start < totalPages; start += PAGE_CONCURRENCY) {
    const pageRequests = Array.from(
      { length: Math.min(PAGE_CONCURRENCY, totalPages - start) },
      (_, offset) => {
        const page = start + offset;
        return httpGetRetry(
          `${API_BASE}${path}${sep}page=${page}&page_size=${PAGE_SIZE}`,
          token
        ).then(({ data }) => {
          onPage?.(page + 1, totalPages);
          return data;
        });
      }
    );
    const pages = await Promise.all(pageRequests);
    for (const page of pages) {
      if (Array.isArray(page)) all.push(...page);
    }
  }

  return all;
}

/** Fetch recent history pages, stopping once the page is older than the cutoff. */
async function apiGetHistorySince(path, cutoff, useKey = true, onPage = null) {
  if (!cutoff) return apiGetAllPages(path, useKey, onPage);

  const cfg = loadConfig();
  const token = useKey ? cfg.api_key : null;
  const sep = path.includes("?") ? "&" : "?";
  const all = [];
  let page = 0;
  let totalPages = 1;

  while (page < totalPages) {
    const { data, headers } = await httpGetRetry(
      `${API_BASE}${path}${sep}page=${page}&page_size=${PAGE_SIZE}`,
      token
    );
    totalPages = parseInt(headers["x-page-total"] || "1", 10);
    const entries = Array.isArray(data) ? data : [];
    onPage?.(page + 1, totalPages);

    for (const transaction of entries) {
      if (transaction.created && transaction.created > cutoff) all.push(transaction);
    }

    if (!entries.length || entries.every((transaction) =>
      !transaction.created || transaction.created <= cutoff
    )) break;
    page += 1;
  }

  return all;
}

/** Find each side's newest archived order timestamp, with a refresh overlap. */
function getHistoryCutoffs(history) {
  const cutoffs = { Buy: null, Sell: null };
  for (const transaction of history?.transactions || []) {
    if (transaction.type in cutoffs && transaction.created &&
        (!cutoffs[transaction.type] || transaction.created > cutoffs[transaction.type])) {
      cutoffs[transaction.type] = transaction.created;
    }
  }
  for (const type of Object.keys(cutoffs)) {
    if (cutoffs[type]) {
      cutoffs[type] = new Date(
        new Date(cutoffs[type]).getTime() - HISTORY_REFRESH_OVERLAP_MS
      ).toISOString();
    }
  }
  return cutoffs;
}

/**
 * Fetch item names for a batch of item IDs from /v2/items.
 * Returns a map of { id: name }.
 *
 * @param {number[]} ids
 * @returns {Promise<Record<number, string>>}
 */
async function fetchItemNames(ids) {
  if (!ids.length) return {};
  const chunks = [];
  // GW2 API allows up to 200 IDs per request
  for (let i = 0; i < ids.length; i += 200) {
    chunks.push(ids.slice(i, i + 200));
  }
  const results = await Promise.all(
    chunks.map((chunk) =>
      apiGet(`/items?ids=${chunk.join(",")}`, false).catch(() => [])
    )
  );
  const map = {};
  for (const page of results) {
    for (const item of page) {
      map[item.id] = item.name || `Item ${item.id}`;
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// In-process caches (live for the duration of the app session)
// ---------------------------------------------------------------------------

/** @type {Record<number, string>} */
const itemNameCache = {};

/** @type {Array<{id:number,name:string}>} */
let itemCatalogCache = loadItemDatabase().items;

let itemCatalogRefreshPromise = null;

/** @type {{transactions: object[], itemNames: Record<number, string>}|null} */
let transactionHistoryCache = loadTransactionHistory();
let transactionHistorySyncQueue = Promise.resolve();
let transactionHistoryProgress = { message: "", active: false };
let currentOrdersCache = null;

/** @type {Record<number, object|null>} */
const recipeCache = {};

/**
 * Resolve names for an array of item IDs, using the in-process cache.
 * Missing IDs are batch-fetched from the API.
 *
 * @param {number[]} ids
 * @returns {Promise<Record<number, string>>}
 */
async function resolveItemNames(ids) {
  const missing = ids.filter((id) => !(id in itemNameCache));
  if (missing.length) {
    const fetched = await fetchItemNames(missing);
    for (const [id, name] of Object.entries(fetched)) {
      itemNameCache[Number(id)] = name;
    }
    // Fill any IDs that had no API result
    for (const id of missing) {
      if (!(id in itemNameCache)) itemNameCache[id] = `Item ${id}`;
    }
  }
  return Object.fromEntries(ids.map((id) => [id, itemNameCache[id] || `Item ${id}`]));
}

/**
 * Fetch the recipe that produces a given item_id.
 * Returns null if the item has no discoverable recipe.
 * Results are cached for the session.
 *
 * @param {number} itemId
 * @returns {Promise<object|null>}
 */
async function fetchRecipe(itemId) {
  if (itemId in recipeCache) return recipeCache[itemId];

  try {
    const ids = await apiGet(`/recipes/search?output=${itemId}`, false);
    if (!ids || !ids.length) { recipeCache[itemId] = null; return null; }
    const recipe = await apiGet(`/recipes/${ids[0]}`, false);
    recipeCache[itemId] = recipe;
    return recipe;
  } catch {
    recipeCache[itemId] = null;
    return null;
  }
}

/**
 * Recursively build a crafting tree for an item.
 *
 * @param {number} itemId
 * @param {number} depth
 * @param {number} maxDepth
 * @returns {Promise<object>} Tree node: { itemId, name, quantity, ingredients[] }
 */
async function buildRecipeTree(itemId, depth = 0, maxDepth = 12) {
  const names = await resolveItemNames([itemId]);
  const node  = { itemId, name: names[itemId], ingredients: [] };

  if (depth >= maxDepth) return node;

  const recipe = await fetchRecipe(itemId);
  if (!recipe) return node;

  // Resolve all ingredient names in one batch
  const ingIds = recipe.ingredients.map((i) => i.item_id);
  await resolveItemNames(ingIds);

  for (const ing of recipe.ingredients) {
    const child = await buildRecipeTree(ing.item_id, depth + 1, maxDepth);
    child.quantity = ing.count || 1;
    node.ingredients.push(child);
  }

  return node;
}

/**
 * Convert a copper value to a "Xg Xs Xc" display string.
 *
 * @param {number|null} copper
 * @returns {string}
 */
function copperToGoldStr(copper) {
  if (copper == null) return "N/A";
  const value = Math.trunc(Number(copper)) || 0;
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  const g = Math.floor(absolute / 10000);
  const s = Math.floor((absolute % 10000) / 100);
  const c = absolute % 100;
  return `${sign}${g}g ${s}s ${c}c`;
}

// ---------------------------------------------------------------------------
// IPC handlers — all GW2 API calls and config I/O go through here
// ---------------------------------------------------------------------------

/**
 * ipc: "get-config"
 * Returns the full parsed config object.
 */
ipcMain.handle("get-config", () => loadConfig());

/**
 * ipc: "save-config"
 * Saves a full config object to disk.
 * @param {object} cfg
 */
ipcMain.handle("save-config", (_evt, cfg) => {
  saveConfig(cfg);
  return { ok: true };
});

/** Refresh the local GW2 item-name/id database from the API. */
async function refreshItemDatabase() {
  if (itemCatalogRefreshPromise) return itemCatalogRefreshPromise;
  itemCatalogRefreshPromise = (async () => {
    const rawItems = await apiGetAllPages("/items", false);
    let items;

    if (rawItems.length && typeof rawItems[0] === "object") {
      items = rawItems
        .filter((item) => Number.isInteger(item?.id) && typeof item.name === "string")
        .map((item) => ({ id: item.id, name: item.name }));
    } else {
      const ids = [...new Set(rawItems.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      const names = await resolveItemNames(ids);
      items = ids
        .filter((id) => names[id])
        .map((id) => ({ id, name: names[id] }));
    }

    if (!items.length) throw new Error("The GW2 API returned no item data.");
    items.sort((a, b) => a.name.localeCompare(b.name));
    itemCatalogCache = items;
    saveItemDatabase(items);
    return { count: items.length, updatedAt: loadItemDatabase().updatedAt };
  })();

  try {
    return await itemCatalogRefreshPromise;
  } finally {
    itemCatalogRefreshPromise = null;
  }
}

/** Search only the local GW2 item-name/id database. */
ipcMain.handle("search-investment-items", (_evt, query) => {
  const term = String(query || "").trim().toLowerCase();
  if (!term || !itemCatalogCache.length) return [];

  return itemCatalogCache
    .filter((item) => item.name.toLowerCase().includes(term))
    .slice(0, 20)
    .map((item) => ({ id: item.id, name: item.name }));
});

ipcMain.handle("get-item-database-status", () => ({
  count: itemCatalogCache.length,
  updatedAt: loadItemDatabase().updatedAt,
}));

ipcMain.handle("refresh-item-database", () => refreshItemDatabase());

/** Get all manually tracked investments. */
ipcMain.handle("get-investments", () => loadInvestments());
ipcMain.handle("get-sold-investments", () => loadSoldInvestments());

/** Add a new investment entry, grouped by item ID. */
ipcMain.handle("add-investment", (_evt, investment) => {
  const itemId = Number(investment?.itemId);
  const amount = Number(investment?.amount);
  const unitPrice = Number(investment?.unitPrice);
  const categoryName = typeof investment?.categoryName === "string" ? investment.categoryName.trim() : "";
  if (!Number.isInteger(itemId) || itemId <= 0) throw new Error("Invalid item.");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be greater than zero.");
  if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error("Price must be zero or greater.");

  const investments = loadInvestments();
  let group = investments.find((entry) => Number(entry.itemId) === itemId);
  if (!group) {
    group = {
      itemId,
      name: String(investment.name || `Item ${itemId}`),
      categories: [],
      entries: [],
    };
    investments.unshift(group);
  }
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    amount,
    unitPrice: Math.round(unitPrice),
    created: new Date().toISOString(),
    categories: categoryName ? [categoryName] : [],
  };
  group.entries.push(entry);
  if (categoryName) {
    if (!Array.isArray(group.categories)) group.categories = [];
    if (!group.categories.includes(categoryName)) group.categories.push(categoryName);
  }
  saveInvestments(investments);
  return investments;
});

/** Record an item as sold, preserving the original per-entry invested cost and sale price. */
ipcMain.handle("mark-investment-sold", (_evt, sale) => {
  const itemId = Number(sale?.itemId);
  const amount = Number(sale?.amount);
  const soldPrice = Number(sale?.soldPrice);
  const entryId = String(sale?.entryId || "");
  if (!Number.isInteger(itemId) || itemId <= 0) throw new Error("Invalid item.");
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("Amount sold must be greater than zero.");
  if (!Number.isFinite(soldPrice) || soldPrice < 0) throw new Error("Sold price must be zero or greater.");
  if (!entryId) throw new Error("Investment entry is required.");

  const investments = loadInvestments();
  const group = investments.find((entry) => Number(entry.itemId) === itemId);
  if (!group) throw new Error("Investment item not found.");
  const entry = group.entries?.find((item) => String(item.id) === entryId);
  if (!entry) throw new Error("Investment entry not found.");
  if (amount > Number(entry.amount)) throw new Error("Amount sold cannot exceed the investment amount.");

  const soldItems = loadSoldInvestments();
  soldItems.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    itemId,
    itemName: group.name,
    investedAmount: Number(entry.amount),
    investedUnitPrice: Number(entry.unitPrice),
    soldAmount: amount,
    soldPrice: Math.round(soldPrice),
    soldAt: new Date().toISOString(),
    sourceEntryId: entryId,
    categories: Array.isArray(entry.categories) && entry.categories.length
      ? [...entry.categories]
      : Array.isArray(group.categories) ? [...group.categories] : [],
  });
  saveSoldInvestments(soldItems);

  if (amount === Number(entry.amount)) {
    group.entries = (group.entries || []).filter((item) => String(item.id) !== entryId);
    if (!group.entries.length) investments.splice(investments.indexOf(group), 1);
  } else {
    entry.amount = Number(entry.amount) - amount;
    entry.created = new Date().toISOString();
  }
  saveInvestments(investments);
  return { investments, soldItems };
});

/** Update an individual investment entry. */
ipcMain.handle("update-investment-entry", (_evt, update) => {
  const itemId = Number(update?.itemId);
  const entryId = String(update?.entryId || "");
  const amount = Number(update?.amount);
  const unitPrice = Number(update?.unitPrice);
  if (!Number.isInteger(itemId) || itemId <= 0) throw new Error("Invalid item.");
  if (!entryId) throw new Error("Invalid investment transaction.");
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("Amount must be a positive whole number.");
  if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error("Price must be zero or greater.");

  const investments = loadInvestments();
  const group = investments.find((entry) => Number(entry.itemId) === itemId);
  const transaction = group?.entries?.find((entry) => String(entry.id) === entryId);
  if (!transaction) throw new Error("Investment transaction not found.");
  transaction.amount = amount;
  transaction.unitPrice = Math.round(unitPrice);
  saveInvestments(investments);
  return investments;
});

/** Remove an individual investment entry. */
ipcMain.handle("remove-investment-entry", (_evt, removal) => {
  const itemId = Number(removal?.itemId);
  const entryId = String(removal?.entryId || "");
  const investments = loadInvestments();
  const group = investments.find((entry) => Number(entry.itemId) === itemId);
  if (!group) throw new Error("Investment item not found.");
  const previousLength = group.entries?.length || 0;
  group.entries = (group.entries || []).filter((entry) => String(entry.id) !== entryId);
  if (group.entries.length === previousLength) throw new Error("Investment transaction not found.");
  if (!group.entries.length) investments.splice(investments.indexOf(group), 1);
  saveInvestments(investments);
  return investments;
});

/** Remove an entire investment item and all of its transactions. */
ipcMain.handle("remove-investment-item", (_evt, itemIdValue) => {
  const itemId = Number(itemIdValue);
  if (!Number.isInteger(itemId) || itemId <= 0) throw new Error("Invalid item.");
  const investments = loadInvestments();
  const index = investments.findIndex((entry) => Number(entry.itemId) === itemId);
  if (index < 0) throw new Error("Investment item not found.");
  investments.splice(index, 1);
  saveInvestments(investments);
  return investments;
});

/**
 * ipc: "fetch-orders"
 * Fetches all current sell and buy orders for the authenticated account.
 * Merges duplicate item_ids (keeping lowest sell price / highest buy price).
 *
 * @returns {{ sells: Record<number,{price,quantity}>, buys: Record<number,{price,quantity}> }}
 */
ipcMain.handle("fetch-orders", async () => {
  let sellsRaw;
  let buysRaw;
  try {
    [sellsRaw, buysRaw] = await Promise.all([
      apiGetAllPages("/commerce/transactions/current/sells"),
      apiGetAllPages("/commerce/transactions/current/buys"),
    ]);
  } catch (error) {
    console.warn("Current orders refresh failed:", error.message);
    return currentOrdersCache || { sells: {}, buys: {} };
  }

  /** @type {Record<number,{price:number,quantity:number}>} */
  const sells = {};
  for (const e of sellsRaw) {
    if (!sells[e.item_id]) {
      sells[e.item_id] = { price: e.price, quantity: e.quantity };
    } else {
      sells[e.item_id].quantity += e.quantity;
      if (e.price < sells[e.item_id].price) sells[e.item_id].price = e.price;
    }
  }

  /** @type {Record<number,{price:number,quantity:number}>} */
  const buys = {};
  for (const e of buysRaw) {
    if (!buys[e.item_id]) {
      buys[e.item_id] = { price: e.price, quantity: e.quantity };
    } else {
      buys[e.item_id].quantity += e.quantity;
      if (e.price > buys[e.item_id].price) buys[e.item_id].price = e.price;
    }
  }

  currentOrdersCache = { sells, buys };
  return currentOrdersCache;
});

/**
 * ipc: "fetch-current-transactions"
 * Fetches every current buy and sell transaction without merging entries.
 *
 * @returns {Promise<Array<object>>}
 */
ipcMain.handle("fetch-current-transactions", async () => {
  const [sells, buys] = await Promise.all([
    apiGetAllPages("/commerce/transactions/current/sells"),
    apiGetAllPages("/commerce/transactions/current/buys"),
  ]);
  const transactions = [
    ...sells.map((transaction) => ({ ...transaction, type: "Sell" })),
    ...buys.map((transaction) => ({ ...transaction, type: "Buy" })),
  ];
  const itemNames = await resolveItemNames(
    [...new Set(transactions.map((transaction) => transaction.item_id))]
  );
  return { transactions, itemNames };
});

function sendTransactionHistoryStatus(sender, message) {
  if (sender && !sender.isDestroyed()) {
    sender.send("transaction-history-status", message);
    return;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("transaction-history-status", message);
  }
}

function sendTransactionHistoryProgress(sender, message, active) {
  const progress = { message, active };
  transactionHistoryProgress = progress;
  if (sender && !sender.isDestroyed()) {
    sender.send("transaction-history-progress", progress);
    return;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("transaction-history-progress", progress);
  }
}

function notifyTransactionHistoryUpdated() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("transaction-history-updated");
  }
}

/** Fetch and persist a history update, serializing it with other refreshes. */
function syncTransactionHistory(forceRefresh = false, sender = null) {
  const sync = transactionHistorySyncQueue.catch(() => {}).then(async () => {
    const cutoffs = forceRefresh
      ? { Buy: null, Sell: null }
      : getHistoryCutoffs(transactionHistoryCache);
    const reportPage = (side) => (page, totalPages) => {
      sendTransactionHistoryProgress(sender, `Updating history: ${side} page ${page}/${totalPages}`, true);
    };

    sendTransactionHistoryProgress(sender, "Updating transaction history…", true);
    sendTransactionHistoryStatus(sender, transactionHistoryCache
      ? (forceRefresh ? "Rescanning all available transaction history…" : "Refreshing recent transaction history…")
      : "Fetching buy and sell history…");
    try {
      const [sells, buys] = await Promise.all([
        apiGetHistorySince("/commerce/transactions/history/sells", cutoffs.Sell, true, reportPage("Sell")),
        apiGetHistorySince("/commerce/transactions/history/buys", cutoffs.Buy, true, reportPage("Buy")),
      ]);
      sendTransactionHistoryStatus(sender, "Resolving item names…");
      sendTransactionHistoryProgress(sender, "Resolving item names…", true);
      const transactions = [
        ...sells.map((transaction) => ({ ...transaction, type: "Sell" })),
        ...buys.map((transaction) => ({ ...transaction, type: "Buy" })),
      ];
      const itemNames = await resolveItemNames(
        [...new Set(transactions.map((transaction) => transaction.item_id))]
      );
      sendTransactionHistoryStatus(sender, "Saving transaction history…");
      sendTransactionHistoryProgress(sender, "Saving transaction history…", true);
      transactionHistoryCache = mergeTransactionHistory(transactionHistoryCache, { transactions, itemNames });
      saveTransactionHistory(transactionHistoryCache);
      notifyTransactionHistoryUpdated();
      sendTransactionHistoryProgress(sender, "", false);
      return transactionHistoryCache;
    } catch (error) {
      sendTransactionHistoryProgress(sender, "", false);
      throw error;
    }
  });

  transactionHistorySyncQueue = sync.then(() => undefined, () => undefined);
  return sync;
}

ipcMain.handle("get-transaction-history", () => transactionHistoryCache || {
  transactions: [],
  itemNames: {},
});

ipcMain.handle("get-transaction-history-progress", () => transactionHistoryProgress);

ipcMain.handle("import-transaction-history", async (event) => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    ...(BrowserWindow.fromWebContents(event.sender)
      ? { parent: BrowserWindow.fromWebContents(event.sender) }
      : {}),
    properties: ["openFile"],
    filters: [{ name: "JSON transaction data", extensions: ["json"] }],
  });
  if (canceled || !filePaths.length) return { canceled: true };

  const file = fs.readFileSync(filePaths[0], "utf8");
  const parsed = JSON.parse(file);
  const transactions = Array.isArray(parsed) ? parsed : parsed?.transactions;
  if (!Array.isArray(transactions) || !transactions.length) {
    throw new Error("The selected file must contain a non-empty transaction array.");
  }

  const valid = transactions.every((transaction) =>
    transaction &&
    (transaction.type === "Buy" || transaction.type === "Sell") &&
    Number.isInteger(Number(transaction.item_id)) && Number(transaction.item_id) > 0 &&
    Number.isFinite(Number(transaction.quantity)) && Number(transaction.quantity) > 0 &&
    Number.isFinite(Number(transaction.price)) && Number(transaction.price) >= 0 &&
    typeof transaction.created === "string" && !Number.isNaN(Date.parse(transaction.created))
  );
  if (!valid) {
    throw new Error("Every transaction must include type (Buy or Sell), item_id, quantity, price, and a valid created date.");
  }

  const importedNames = !Array.isArray(parsed) && parsed.itemNames && typeof parsed.itemNames === "object"
    ? parsed.itemNames
    : {};
  const itemIds = [...new Set(transactions.map((transaction) => Number(transaction.item_id)))];
  const itemNames = { ...importedNames };
  for (const itemId of itemIds) {
    if (!itemNames[itemId] && !transactionHistoryCache?.itemNames?.[itemId]) {
      itemNames[itemId] = `Item ${itemId}`;
    }
  }
  const importData = () => {
    transactionHistoryCache = mergeTransactionHistory(transactionHistoryCache, {
      transactions,
      itemNames,
    });
    saveTransactionHistory(transactionHistoryCache);
    notifyTransactionHistoryUpdated();
    return {
      canceled: false,
      importedCount: transactions.length,
      archiveCount: transactionHistoryCache.transactions.length,
    };
  };

  return importData();
});

/** Fetch completed transactions, optionally rescanning every available API page. */
ipcMain.handle("fetch-transaction-history", (event, forceRefresh = false) =>
  syncTransactionHistory(forceRefresh, event.sender)
);

function scheduleTransactionHistorySync(delay = 0) {
  setTimeout(async () => {
    try {
      await syncTransactionHistory(true);
      scheduleTransactionHistorySync(HISTORY_FULL_SYNC_INTERVAL_MS);
    } catch (error) {
      console.error("Background transaction-history sync failed:", error.message);
      sendTransactionHistoryStatus(null, "Background history sync failed; will retry later.");
      scheduleTransactionHistorySync(HISTORY_SYNC_RETRY_MS);
    }
  }, delay);
}

/** Delete the persistent transaction archive and its in-memory copy. */
ipcMain.handle("clear-transaction-history", () => {
  const clear = transactionHistorySyncQueue.catch(() => {}).then(() => {
    transactionHistoryCache = null;
    try {
      require("fs").unlinkSync(storage.paths.transactionHistory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    notifyTransactionHistoryUpdated();
    return { ok: true };
  });
  transactionHistorySyncQueue = clear.then(() => undefined, () => undefined);
  return clear;
});

/**
 * ipc: "fetch-order-books"
 * Fetches the full depth order book for a list of item IDs from /commerce/listings.
 * Sells are sorted ascending (cheapest first); buys descending (highest first).
 *
 * @param {number[]} itemIds
 * @returns {Record<number,{sells:object[], buys:object[]}>}
 */
ipcMain.handle("fetch-order-books", async (_evt, itemIds) => {
  const ids = [...new Set((itemIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return {};

  const result = {};

  // A single listing can use the dedicated endpoint and avoid the batch endpoint entirely.
  if (ids.length === 1) {
    try {
      const single = await apiGet(`/commerce/listings/${ids[0]}`, false, 4, 45_000);
      return {
        [ids[0]]: {
          sells: Array.isArray(single?.sells) ? single.sells : [],
          buys: Array.isArray(single?.buys) ? single.buys : [],
        },
      };
    } catch (error) {
      return {};
    }
  }

  const chunkSize = 20;
  const chunks = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    chunks.push(ids.slice(i, i + chunkSize));
  }

  const processData = (data) => {
    for (const entry of data || []) {
      result[entry.id] = { sells: entry.sells || [], buys: entry.buys || [] };
    }
  };

  for (let start = 0; start < chunks.length; start += 3) {
    const batch = chunks.slice(start, start + 3);
    const responses = await Promise.allSettled(batch.map((chunk) =>
      apiGet(`/commerce/listings?ids=${chunk.join(",")}`, false, 3, 30_000)
    ));

    for (let index = 0; index < responses.length; index++) {
      const response = responses[index];
      if (response.status === "fulfilled") {
        processData(response.value);
        continue;
      }

      for (const itemId of batch[index]) {
        try {
          const single = await apiGet(`/commerce/listings/${itemId}`, false, 2, 20_000);
          result[itemId] = {
            sells: Array.isArray(single?.sells) ? single.sells : [],
            buys: Array.isArray(single?.buys) ? single.buys : [],
          };
        } catch (error) {
          console.error(`Order book failed for item ${itemId}:`, error?.message || error);
        }
      }
    }
  }
  return result;
});

/**
 * ipc: "fetch-stock"
 * Counts the requested items across shared inventory, bank, material storage,
 * Trading Post delivery, and every character inventory, retaining the source
 * of each quantity.
 *
 * @param {number[]} itemIds
 * @returns {Record<number,{total:number,locations:Array<{location:string,amount:number}>}>}
 */
ipcMain.handle("fetch-stock", async (_evt, itemIds) => {
  const wanted = new Set(itemIds.map(Number));
  const totals = Object.fromEntries(itemIds.map((id) => [id, { total: 0, locations: [] }]));

  const addEntries = (location, entries) => {
    if (!Array.isArray(entries)) return;
    const amounts = {};
    for (const entry of entries || []) {
      if (!entry || typeof entry !== "object") continue;
      const id = Number(entry.id);
      if (!wanted.has(id) || !entry.count) continue;
      amounts[id] = (amounts[id] || 0) + entry.count;
    }
    for (const [id, amount] of Object.entries(amounts)) {
      totals[id].total += amount;
      totals[id].locations.push({ location, amount });
    }
  };

  const settleAccountRequest = async (path, fallback) => {
    try { return await apiGet(path); }
    catch (error) { console.warn(`Stock source failed (${path}):`, error.message); return fallback; }
  };

  const [shared, bank, materials, delivery, characterNames] = await Promise.all([
    settleAccountRequest("/account/inventory", []),
    settleAccountRequest("/account/bank", []),
    settleAccountRequest("/account/materials", []),
    settleAccountRequest("/commerce/delivery", { items: [] }),
    settleAccountRequest("/characters", []),
  ]);

  addEntries("Shared Inventory", shared);
  addEntries("Bank", bank);
  addEntries("Material Storage", materials);
  addEntries("Trading Post Delivery", delivery?.items);

  const characterInventories = await Promise.all(
    (Array.isArray(characterNames) ? characterNames : []).map(async (name) => {
      try {
        const inventory = await apiGet(`/characters/${encodeURIComponent(name)}/inventory`);
        const bags = Array.isArray(inventory?.bags) ? inventory.bags : Array.isArray(inventory) ? inventory : [];
        return {
          name,
          inventoryItems: bags.flatMap((bag) => Array.isArray(bag?.inventory) ? bag.inventory : []),
        };
      } catch (error) {
        console.warn(`Character inventory failed (${name}):`, error.message);
        return { name, inventoryItems: [] };
      }
    })
  );
  for (const { name, inventoryItems } of characterInventories) {
    addEntries(name, inventoryItems);
  }

  return totals;
});

/**
 * ipc: "fetch-delivery"
 * Returns the contents of the TP delivery box.
 *
 * @returns {{ items: Record<number,number>, coins: number, itemNames: Record<number,string> }}
 */
ipcMain.handle("fetch-delivery", async () => {
  const data  = await apiGet("/commerce/delivery");
  const coins = data.coins || 0;

  /** @type {Record<number,number>} Stacked by item_id */
  const items = {};
  for (const e of data.items || []) {
    items[e.id] = (items[e.id] || 0) + e.count;
  }

  const itemNames = await resolveItemNames(Object.keys(items).map(Number));
  return { items, coins, itemNames };
});

/**
 * ipc: "fetch-recipe"
 * Returns the full recursive crafting tree for an item.
 *
 * @param {number} itemId
 * @returns {object} Tree node
 */
ipcMain.handle("fetch-recipe", async (_evt, itemId) => {
  return buildRecipeTree(itemId);
});

/**
 * ipc: "copper-to-gold"
 * Converts a copper integer to a display string.
 * (Exposed so renderer does not need to duplicate the logic.)
 *
 * @param {number} copper
 * @returns {string}
 */
ipcMain.handle("copper-to-gold", (_evt, copper) => copperToGoldStr(copper));

/**
 * ipc: "open-category-window"
 * Opens (or focuses) a category window for the given category name.
 *
 * @param {string} categoryName
 */
ipcMain.handle("open-category-window", (_evt, categoryName) => {
  windows.openCategoryWindow(categoryName);
});

/**
 * ipc: "open-delivery-window"
 * Opens (or focuses) the delivery box window.
 */
ipcMain.handle("open-delivery-window", () => windows.openDeliveryWindow());

/**
 * ipc: "open-recipe-window"
 * Opens a recipe popup for a specific item.
 */
ipcMain.handle("open-recipe-window", (_evt, name, itemId) => {
  windows.openRecipeWindow(name, itemId);
});

/**
 * ipc: "open-current-orders-window"
 * Opens (or focuses) the current orders window.
 */
ipcMain.handle("open-current-orders-window", () => windows.openCurrentOrdersWindow());

/**
 * ipc: "open-transaction-history-window"
 * Opens (or focuses) the transaction history window.
 */
ipcMain.handle("open-transaction-history-window", () => windows.openTransactionHistoryWindow());

/**
 * ipc: "open-raw-transaction-history-window"
 * Opens (or focuses) the uncollapsed raw transaction data window.
 */
ipcMain.handle("open-raw-transaction-history-window", () => windows.openRawTransactionHistoryWindow());

/** Open (or focus) the investment tracker window. */
ipcMain.handle("open-investments-window", () => windows.openInvestmentsWindow());

/**
 * ipc: "open-settings-window"
 * Opens (or focuses) the settings window.
 */
ipcMain.handle("open-settings-window", () => windows.openSettingsWindow());

/**
 * ipc: "reload-launcher"
 * Tells the launcher window to rebuild its category button list.
 * Sent by the settings window after applying changes.
 */
ipcMain.handle("reload-launcher", () => windows.reloadLauncher());

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  windows.createLauncherWindow();
  scheduleTransactionHistorySync();

  const itemDatabase = loadItemDatabase();
  const staleMs = 30 * 24 * 60 * 60 * 1000;
  const isStale = !itemDatabase.updatedAt || (Date.now() - Date.parse(itemDatabase.updatedAt) > staleMs);
  if (!itemDatabase.items.length || isStale) {
    refreshItemDatabase().catch((error) => {
      console.error("Background item database refresh failed:", error.message);
    });
  }

  // macOS: re-create window when dock icon is clicked and no windows are open
  app.on("activate", () => {
    if (windows.noLauncherWindows()) windows.createLauncherWindow();
  });
});

// Quit when all windows are closed (except on macOS)
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});