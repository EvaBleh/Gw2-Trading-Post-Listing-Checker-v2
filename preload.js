/**
 * preload.js — Electron preload script
 *
 * Runs in a privileged context with access to both Node.js and the DOM,
 * but with contextIsolation=true it cannot directly share objects with
 * the renderer.  Instead we use contextBridge to expose a minimal, safe
 * API surface under window.api.
 *
 * Every method here is a thin wrapper around ipcRenderer.invoke() or
 * ipcRenderer.on(), keeping all actual logic in the main process.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {

  // ── Config ──────────────────────────────────────────────────────────────

  /** Load the full config object from disk. */
  getConfig: ()    => ipcRenderer.invoke("get-config"),

  /** Persist a full config object to disk. */
  saveConfig: (cfg) => ipcRenderer.invoke("save-config", cfg),

  // ── GW2 API ─────────────────────────────────────────────────────────────

  /**
   * Fetch all current sell and buy orders for the authenticated account.
   * @returns {Promise<{sells, buys}>}
   */
  fetchOrders: () => ipcRenderer.invoke("fetch-orders"),

  /**
   * Fetch the full order book depth for an array of item IDs.
   * @param {number[]} itemIds
   * @returns {Promise<Record<number,{sells,buys}>>}
   */
  fetchOrderBooks: (itemIds) => ipcRenderer.invoke("fetch-order-books", itemIds),

  /**
   * Fetch the TP delivery box contents.
   * @returns {Promise<{items, coins, itemNames}>}
   */
  fetchDelivery: () => ipcRenderer.invoke("fetch-delivery"),

  /**
   * Fetch the full recursive crafting tree for an item.
   * @param {number} itemId
   * @returns {Promise<object>}
   */
  fetchRecipe: (itemId) => ipcRenderer.invoke("fetch-recipe", itemId),

  /**
   * Convert a copper integer to a "Xg Xs Xc" display string.
   * @param {number} copper
   * @returns {Promise<string>}
   */
  copperToGold: (copper) => ipcRenderer.invoke("copper-to-gold", copper),

  // ── Window management ────────────────────────────────────────────────────

  /** Open (or focus) a category window for the given category name. */
  openCategoryWindow:  (name) => ipcRenderer.invoke("open-category-window", name),

  /** Open (or focus) the delivery box window. */
  openDeliveryWindow:  ()     => ipcRenderer.invoke("open-delivery-window"),

  /** Open (or focus) the settings window. */
  openSettingsWindow:  ()     => ipcRenderer.invoke("open-settings-window"),

  /**
   * Tell the launcher to reload its category list.
   * Called by the settings window after applying changes.
   */
  reloadLauncher: () => ipcRenderer.invoke("reload-launcher"),

  // ── Event listeners ──────────────────────────────────────────────────────

  /**
   * Register a one-way listener for events pushed from the main process.
   * Returns an unsubscribe function.
   *
   * @param {string}   channel
   * @param {Function} callback
   * @returns {Function} call to remove the listener
   */
  on: (channel, callback) => {
    const handler = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});