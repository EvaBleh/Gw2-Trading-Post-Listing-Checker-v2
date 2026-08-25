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

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path  = require("path");
const fs    = require("fs");
const https = require("https");
const http  = require("http");

if (require("electron-squirrel-startup")) return;
const { updateElectronApp } = require("update-electron-app");
updateElectronApp();
// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Directory where the user's writable config.json is stored. */
const CONFIG_DIR  = app.getPath("userData");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

// ---------------------------------------------------------------------------
// Default config — written on first launch if no config.json exists
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  api_key: "",
  items: {
    Runes: {
      _default_order_type: "sell",
      "Superior Rune of the Scholar":      24836,
      "Superior Rune of the Dragonhunter": 77575,
    },
  },
};

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Load config.json, creating it with defaults if it does not exist.
 * @returns {object} Parsed config object.
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/**
 * Persist config object to disk.
 * @param {object} cfg
 */
function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// GW2 API helpers
// ---------------------------------------------------------------------------

const API_BASE  = "https://api.guildwars2.com/v2";
const PAGE_SIZE = 200;
const REQUEST_TIMEOUT_MS = 600_000;
const PAGE_CONCURRENCY = 4;

/**
 * Minimal promise-based HTTP GET that works with both http and https.
 * Returns parsed JSON or throws on non-2xx status.
 *
 * @param {string} url
 * @param {string|null} bearerToken  Authorization header value (without "Bearer ")
 * @returns {Promise<{data: any, headers: object}>}
 */
function httpGet(url, bearerToken = null) {
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
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(new Error("Request timeout")); });
  });
}

/**
 * Fetch a single GW2 API endpoint (no pagination).
 *
 * @param {string} path     e.g. "/commerce/delivery"
 * @param {boolean} useKey  Whether to attach the stored API key
 * @returns {Promise<any>}
 */
async function apiGet(path, useKey = true) {
  const cfg   = loadConfig();
  const token = useKey ? cfg.api_key : null;
  const { data } = await httpGet(`${API_BASE}${path}`, token);
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
async function apiGetAllPages(path, useKey = true) {
  const cfg   = loadConfig();
  const token = useKey ? cfg.api_key : null;
  const sep   = path.includes("?") ? "&" : "?";

  const { data: firstPage, headers } = await httpGet(
    `${API_BASE}${path}${sep}page=0&page_size=${PAGE_SIZE}`,
    token
  );

  const totalPages = parseInt(headers["x-page-total"] || "1", 10);
  const all        = Array.isArray(firstPage) ? [...firstPage] : [];

  // Fetch a few pages at a time so large accounts do not overwhelm the API.
  for (let start = 1; start < totalPages; start += PAGE_CONCURRENCY) {
    const pageRequests = Array.from(
      { length: Math.min(PAGE_CONCURRENCY, totalPages - start) },
      (_, offset) => httpGet(
        `${API_BASE}${path}${sep}page=${start + offset}&page_size=${PAGE_SIZE}`,
        token
      ).then(({ data }) => data)
    );
    const pages = await Promise.all(pageRequests);
    for (const page of pages) {
      if (Array.isArray(page)) all.push(...page);
    }
  }

  return all;
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
  const g = Math.floor(copper / 10000);
  const s = Math.floor((copper % 10000) / 100);
  const c = copper % 100;
  return `${g}g ${s}s ${c}c`;
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

/**
 * ipc: "fetch-orders"
 * Fetches all current sell and buy orders for the authenticated account.
 * Merges duplicate item_ids (keeping lowest sell price / highest buy price).
 *
 * @returns {{ sells: Record<number,{price,quantity}>, buys: Record<number,{price,quantity}> }}
 */
ipcMain.handle("fetch-orders", async () => {
  const [sellsRaw, buysRaw] = await Promise.all([
    apiGetAllPages("/commerce/transactions/current/sells"),
    apiGetAllPages("/commerce/transactions/current/buys"),
  ]);

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

  return { sells, buys };
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
  if (!itemIds.length) return {};
  const data = await apiGet(`/commerce/listings?ids=${itemIds.join(",")}`, false);
  const result = {};
  for (const entry of data) {
    result[entry.id] = { sells: entry.sells || [], buys: entry.buys || [] };
  }
  return result;
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
  openCategoryWindow(categoryName);
});

/**
 * ipc: "open-delivery-window"
 * Opens (or focuses) the delivery box window.
 */
ipcMain.handle("open-delivery-window", () => openDeliveryWindow());

/**
 * ipc: "open-settings-window"
 * Opens (or focuses) the settings window.
 */
ipcMain.handle("open-settings-window", () => openSettingsWindow());

/**
 * ipc: "reload-launcher"
 * Tells the launcher window to rebuild its category button list.
 * Sent by the settings window after applying changes.
 */
ipcMain.handle("reload-launcher", () => {
  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.webContents.send("reload-launcher");
  }
});

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

/** @type {BrowserWindow|null} */
let launcherWin = null;

/** @type {Record<string, BrowserWindow>} Open category windows keyed by name */
const categoryWindows = {};

/** @type {BrowserWindow|null} */
let deliveryWin = null;

/** @type {BrowserWindow|null} */
let settingsWin = null;

/**
 * Shared BrowserWindow options applied to every window.
 */
const WINDOW_BASE_OPTIONS = {
  webPreferences: {
    preload:          path.join(__dirname, "preload.js"),
    contextIsolation: true,   // Security: renderer cannot access Node APIs
    nodeIntegration:  false,  // Security: no direct require() in renderer
  },
  icon: path.join(__dirname, "assets", "icon.png"),
  backgroundColor: "#1a1a2e",
  show: false, // Show only after "ready-to-show" to avoid blank flash
};

/**
 * Create the main launcher window.
 */
function createLauncherWindow() {
  launcherWin = new BrowserWindow({
    ...WINDOW_BASE_OPTIONS,
    width:     380,
    height:    520,
    minWidth:  320,
    minHeight: 400,
    title: "GW2 Trading Post Checker",
  });

  launcherWin.loadFile(path.join(__dirname, "renderer", "launcher.html"));
  launcherWin.once("ready-to-show", () => launcherWin.show());
  launcherWin.on("closed", () => { launcherWin = null; });

  // Remove default menu bar for cleaner look
  launcherWin.setMenuBarVisibility(false);
}

/**
 * Open (or focus) a category window for `categoryName`.
 *
 * @param {string} categoryName
 */
function openCategoryWindow(categoryName) {
  if (categoryWindows[categoryName] && !categoryWindows[categoryName].isDestroyed()) {
    categoryWindows[categoryName].focus();
    return;
  }

  const win = new BrowserWindow({
    ...WINDOW_BASE_OPTIONS,
    width:     960,
    height:    600,
    minWidth:  400,
    minHeight: 300,
    title: `GW2 TP — ${categoryName}`,
  });

  win.loadFile(path.join(__dirname, "renderer", "category.html"), {
    query: { category: categoryName },
  });

  win.once("ready-to-show", () => win.show());
  win.setMenuBarVisibility(false);
  win.on("closed", () => { delete categoryWindows[categoryName]; });

  categoryWindows[categoryName] = win;
}

/**
 * Open (or focus) the delivery box window.
 */
function openDeliveryWindow() {
  if (deliveryWin && !deliveryWin.isDestroyed()) { deliveryWin.focus(); return; }

  deliveryWin = new BrowserWindow({
    ...WINDOW_BASE_OPTIONS,
    width:     480,
    height:    560,
    minWidth:  360,
    minHeight: 300,
    title: "TP Delivery Box",
  });

  deliveryWin.loadFile(path.join(__dirname, "renderer", "delivery.html"));
  deliveryWin.once("ready-to-show", () => deliveryWin.show());
  deliveryWin.setMenuBarVisibility(false);
  deliveryWin.on("closed", () => { deliveryWin = null; });
}

/**
 * Open (or focus) the settings window.
 */
function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }

  settingsWin = new BrowserWindow({
    ...WINDOW_BASE_OPTIONS,
    width:     860,
    height:    620,
    minWidth:  640,
    minHeight: 480,
    title: "Settings",
  });

  settingsWin.loadFile(path.join(__dirname, "renderer", "settings.html"));
  settingsWin.once("ready-to-show", () => settingsWin.show());
  settingsWin.setMenuBarVisibility(false);
  settingsWin.on("closed", () => { settingsWin = null; });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  createLauncherWindow();

  // macOS: re-create window when dock icon is clicked and no windows are open
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createLauncherWindow();
  });
});

// Quit when all windows are closed (except on macOS)
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});