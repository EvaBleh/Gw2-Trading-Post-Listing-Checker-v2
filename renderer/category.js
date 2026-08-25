/**
 * category.js — Renderer script for category windows.
 *
 * Responsibilities:
 *  - Read the category name from window.location.search
 *  - Load config and build an ItemCard per item
 *  - Poll the GW2 API at the configured interval and refresh all cards
 *  - Track the countdown to next refresh in the footer
 */

const DEFAULT_UPDATE_INTERVAL_MS = 60_000;

let updateIntervalMs = DEFAULT_UPDATE_INTERVAL_MS;

// ── DOM refs ───────────────────────────────────────────────────────────────

const titleEl      = document.getElementById("category-title");
const gridEl       = document.getElementById("card-grid");
const statusEl     = document.getElementById("status-text");
const nextEl       = document.getElementById("next-refresh");
const refreshBtn   = document.getElementById("btn-refresh");

// ── State ──────────────────────────────────────────────────────────────────

/** @type {Map<number, ItemCard>}  itemId → card instance */
const cards = new Map();

/** Whether a fetch is currently in-flight */
let fetching = false;

/** Timestamp when the next automatic refresh is due */
let nextRefreshAt = 0;

/** setInterval handle for the countdown ticker */
let countdownHandle = null;

/** setInterval handle for the auto-refresh */
let refreshHandle   = null;

// ── Initialisation ─────────────────────────────────────────────────────────

/**
 * Parse the category name from the URL query string and initialise the page.
 */
async function init() {
  const params   = new URLSearchParams(window.location.search);
  const catName  = params.get("category") || "Unknown";

  document.title   = `GW2 TP — ${catName}`;
  titleEl.textContent = catName;

  const config   = await window.api.getConfig();
  const refreshSeconds = Number(config.refresh_interval_seconds);
  if (Number.isInteger(refreshSeconds) && refreshSeconds >= 10 && refreshSeconds <= 86400) {
    updateIntervalMs = refreshSeconds * 1000;
  }
  const catData  = (config.items || {})[catName] || {};
  const catDefault = (catData._default_order_type || "sell").toLowerCase();

  // Build a card for every item in this category
  for (const [name, raw] of Object.entries(catData)) {
    if (name.startsWith("_")) continue;

    const { itemId, defaultOrderType } = parseItemEntry(raw, catDefault);
    if (!itemId) continue;

    const card = new ItemCard(name, itemId, defaultOrderType);
    gridEl.appendChild(card.element);
    cards.set(itemId, card);
  }

  if (cards.size === 0) {
    gridEl.innerHTML =
      `<p class="text-muted" style="padding:24px">
         No items configured in this category.
       </p>`;
  }

  // First fetch immediately, then on interval
  fetchAndUpdate();
  scheduleRefresh();
  startCountdown();
}

/**
 * Parse a config item entry (plain int or {id, default_order_type} object).
 *
 * @param {number|object} raw
 * @param {string} catDefault  Category-level fallback
 * @returns {{ itemId: number, defaultOrderType: string }}
 */
function parseItemEntry(raw, catDefault) {
  if (typeof raw === "number") {
    return { itemId: raw, defaultOrderType: catDefault };
  }
  const ot = (raw.default_order_type || catDefault).toLowerCase();
  return {
    itemId:           raw.id,
    defaultOrderType: ["sell", "buy"].includes(ot) ? ot : catDefault,
  };
}

// ── Polling ────────────────────────────────────────────────────────────────

/**
 * Fetch orders + order books for all watched items and update every card.
 */
async function fetchAndUpdate() {
  if (fetching) return;
  fetching = true;
  statusEl.textContent = "Refreshing…";

  try {
    // Only fetch books for items that have "Watch" enabled
    const watchedIds = [...cards.entries()]
      .filter(([, card]) => card.watching)
      .map(([id]) => id);

    if (!watchedIds.length) {
      statusEl.textContent = "No items watched — enable Watch on at least one item.";
      return;
    }

    const [{ sells, buys }, books] = await Promise.all([
      window.api.fetchOrders(),
      window.api.fetchOrderBooks(watchedIds),
    ]);

    for (const [itemId, card] of cards) {
      await card.update(sells, buys, books);
    }

    statusEl.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    console.error("Fetch error:", err);
  } finally {
    fetching = false;
  }
}

/**
 * Set up the auto-refresh interval.
 */
function scheduleRefresh() {
  clearInterval(refreshHandle);
  nextRefreshAt  = Date.now() + updateIntervalMs;
  refreshHandle  = setInterval(() => {
    nextRefreshAt = Date.now() + updateIntervalMs;
    fetchAndUpdate();
  }, updateIntervalMs);
}

/**
 * Update the "Next refresh in Xs" counter in the footer every second.
 */
function startCountdown() {
  clearInterval(countdownHandle);
  countdownHandle = setInterval(() => {
    const secs = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000));
    nextEl.textContent = `Next refresh in ${secs}s`;
  }, 1000);
}

// ── Manual refresh ─────────────────────────────────────────────────────────

refreshBtn.addEventListener("click", () => {
  scheduleRefresh(); // reset the timer
  fetchAndUpdate();
});

// ── ItemCard class ─────────────────────────────────────────────────────────

/**
 * Represents one item card in the grid.
 * Manages its own DOM, collapse state, and data rendering.
 */
class ItemCard {
  /**
   * @param {string} name             Display name
   * @param {number} itemId           GW2 item ID
   * @param {string} defaultOrderType "sell" | "buy"
   */
  constructor(name, itemId, defaultOrderType) {
    this.name        = name;
    this.itemId      = itemId;
    this.orderType   = defaultOrderType; // "sell" | "buy"
    this.watching    = true;
    this._expanded   = true;

    this.element = this._buildDOM();
  }

  // ── DOM construction ─────────────────────────────────────────────────────

  /**
   * Build the card DOM and wire up internal event listeners.
   * @returns {HTMLElement}
   */
  _buildDOM() {
    const card = document.createElement("div");
    card.className = "item-card";

    // ── Header ────────────────────────────────────────────────────────────
    const header = document.createElement("div");
    header.className = "item-card__header";
    header.addEventListener("click", () => this._toggleCollapse());

    this._toggleIcon = document.createElement("span");
    this._toggleIcon.className = "item-card__toggle item-card__toggle--open";
    this._toggleIcon.textContent = "▼";

    const nameEl = document.createElement("span");
    nameEl.className = "item-card__name";
    nameEl.title     = this.name; // tooltip for long names
    nameEl.textContent = this.name;

    this._summaryEl = document.createElement("span");
    this._summaryEl.className = "item-card__summary text-muted";

    header.append(this._toggleIcon, nameEl, this._summaryEl);

    // ── Body ──────────────────────────────────────────────────────────────
    this._bodyEl = document.createElement("div");
    this._bodyEl.className = "item-card__body";

    // Controls row
    const ctrl = document.createElement("div");
    ctrl.className = "item-card__controls";

    // Watch checkbox
    const watchLabel = document.createElement("label");
    watchLabel.className = "checkbox-label";
    this._watchCheck = document.createElement("input");
    this._watchCheck.type    = "checkbox";
    this._watchCheck.checked = true;
    this._watchCheck.addEventListener("change", (e) => {
      this.watching = e.target.checked;
    });
    watchLabel.append(this._watchCheck, "Watch");

    // Sell radio
    const sellLabel = document.createElement("label");
    sellLabel.className = "radio-label";
    this._sellRadio = document.createElement("input");
    this._sellRadio.type = "radio";
    this._sellRadio.name = `ot-${this.itemId}`;
    this._sellRadio.value   = "sell";
    this._sellRadio.checked = this.orderType === "sell";
    this._sellRadio.addEventListener("change", () => { this.orderType = "sell"; });
    sellLabel.append(this._sellRadio, "Sell");

    // Buy radio
    const buyLabel = document.createElement("label");
    buyLabel.className = "radio-label";
    this._buyRadio = document.createElement("input");
    this._buyRadio.type  = "radio";
    this._buyRadio.name  = `ot-${this.itemId}`;
    this._buyRadio.value = "buy";
    this._buyRadio.checked = this.orderType === "buy";
    this._buyRadio.addEventListener("change", () => { this.orderType = "buy"; });
    buyLabel.append(this._buyRadio, "Buy");

    // Recipe button (opens a small popup window)
    const recipeBtn = document.createElement("button");
    recipeBtn.className   = "btn btn--ghost btn--sm";
    recipeBtn.textContent = "Recipe";
    recipeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openRecipePopup(this.name, this.itemId);
    });

    ctrl.append(watchLabel, sellLabel, buyLabel, recipeBtn);

    // Status row
    const statusRow = document.createElement("div");
    statusRow.className = "item-card__status-row";

    this._statusEl = document.createElement("span");
    this._statusEl.className = "item-card__status status--neutral";
    this._statusEl.textContent = "Waiting for data…";

    this._markerEl = document.createElement("span");
    this._markerEl.className = "item-card__marker";

    statusRow.append(this._statusEl, this._markerEl);

    // Details line
    this._detailsEl = document.createElement("div");
    this._detailsEl.className = "item-card__details";

    this._bodyEl.append(ctrl, statusRow, this._detailsEl);

    card.append(header, this._bodyEl);
    return card;
  }

  // ── Collapse / expand ────────────────────────────────────────────────────

  /**
   * Toggle the card's collapsed state.
   * When collapsed, only the header (name + summary) is shown.
   */
  _toggleCollapse() {
    this._expanded = !this._expanded;
    this._bodyEl.classList.toggle("item-card__body--hidden", !this._expanded);
    this._toggleIcon.textContent  = this._expanded ? "▼" : "▶";
    this._toggleIcon.className    =
      `item-card__toggle item-card__toggle--${this._expanded ? "open" : "closed"}`;
  }

  // ── Data update ──────────────────────────────────────────────────────────

  /**
   * Update the card with fresh API data.
   *
   * @param {object} sells       From fetchOrders — { [itemId]: {price, quantity} }
   * @param {object} buys        From fetchOrders — { [itemId]: {price, quantity} }
   * @param {object} orderBooks  From fetchOrderBooks — { [itemId]: {sells[], buys[]} }
   */
  async update(sells, buys, orderBooks) {
    if (!this.watching) {
      this._setStatus("Not watched", "neutral");
      this._markerEl.textContent  = "";
      this._detailsEl.textContent = "";
      this._summaryEl.textContent = "—";
      this._summaryEl.className   = "item-card__summary text-muted";
      return;
    }

    const ot        = this.orderType;
    const book      = orderBooks[this.itemId] || { sells: [], buys: [] };
    const myListing = ot === "sell" ? sells[this.itemId] : buys[this.itemId];
    const bookSide  = ot === "sell" ? book.sells         : book.buys;
    const oppBest   = bookSide.length ? bookSide[0].unit_price : null;
    const lbl       = ot === "sell" ? "Sell" : "Buy";

    if (!myListing) {
      this._setStatus(`${lbl} listing: No`, "no");
      this._markerEl.textContent  = "";
      this._detailsEl.textContent = "";
      this._setSummary("No listing", "danger");
      return;
    }

    const { price: myPrice, quantity: myQty } = myListing;
    this._setStatus(`${lbl} listing: Yes (${myQty})`, "yes");

    const myPriceStr  = await window.api.copperToGold(myPrice);
    const oppBestStr  = await window.api.copperToGold(oppBest);

    if (oppBest != null) {
      let count   = 0;
      let isBest  = false;
      let marker  = "";

      if (ot === "sell") {
        // Count items listed strictly cheaper than mine
        for (const tier of bookSide) {
          if (tier.unit_price < myPrice) count += tier.quantity;
          else break;
        }
        isBest = count === 0;
        marker = isBest ? "✓ Lowest" : `✗ Undercut by ${count}`;
      } else {
        // Count orders priced strictly higher than mine
        for (const tier of bookSide) {
          if (tier.unit_price > myPrice) count += tier.quantity;
          else break;
        }
        isBest = count === 0;
        marker = isBest ? "✓ Highest" : `✗ Overcut by ${count}`;
      }

      this._markerEl.textContent = marker;
      this._markerEl.className   = `item-card__marker ${isBest ? "marker--best" : "marker--not-best"}`;
      this._setSummary(marker, isBest ? "success" : "danger");
    } else {
      this._markerEl.textContent = "";
      this._setSummary(myPriceStr, "success");
    }

    const compareLabel = ot === "sell" ? "Market Lowest" : "Market Highest";
    this._detailsEl.textContent =
      `Your price: ${myPriceStr}   |   ${compareLabel}: ${oppBestStr}`;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * @param {string} text
   * @param {"yes"|"no"|"neutral"|"error"} state
   */
  _setStatus(text, state) {
    this._statusEl.textContent = text;
    this._statusEl.className   = `item-card__status status--${state}`;
  }

  /**
   * @param {string} text
   * @param {"success"|"danger"|"neutral"} variant
   */
  _setSummary(text, variant) {
    this._summaryEl.textContent = text;
    this._summaryEl.className   = `item-card__summary text-${variant}`;
  }
}

// ── Recipe popup ───────────────────────────────────────────────────────────

/**
 * Open a small recipe popup window by storing the item info in sessionStorage
 * and opening a new renderer page.  (Electron's BrowserWindow query param
 * approach works here — see main.js openCategoryWindow for the pattern.)
 *
 * We navigate to recipe.html in a new window via shell or a dedicated IPC
 * call.  For simplicity we open it inside an Electron child window using
 * the existing openCategoryWindow-style IPC.  Here we open a standalone
 * recipe.html via a dedicated IPC.
 */
async function openRecipePopup(name, itemId) {
  // Delegate to main process which will open a BrowserWindow
  await window.api.openRecipeWindow(name, itemId);
}

// ── Boot ───────────────────────────────────────────────────────────────────

init();