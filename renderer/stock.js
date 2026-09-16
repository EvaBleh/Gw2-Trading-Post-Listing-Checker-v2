/** Stock category renderer: account totals with expandable location details. */

const DEFAULT_UPDATE_INTERVAL_MS = 60_000;
let updateIntervalMs = DEFAULT_UPDATE_INTERVAL_MS;
let fetching = false;
let nextRefreshAt = 0;
let countdownHandle = null;
let refreshHandle = null;

const titleEl = document.getElementById("category-title");
const gridEl = document.getElementById("card-grid");
const statusEl = document.getElementById("status-text");
const nextEl = document.getElementById("next-refresh");
const refreshBtn = document.getElementById("btn-refresh");
const cards = new Map();

async function init() {
  const categoryName = new URLSearchParams(window.location.search).get("category") || "Unknown";
  document.title = `GW2 TP - ${categoryName}`;
  titleEl.textContent = categoryName;

  const config = await window.api.getConfig();
  const refreshSeconds = Number(config.refresh_interval_seconds);
  if (Number.isInteger(refreshSeconds) && refreshSeconds >= 10 && refreshSeconds <= 86400) {
    updateIntervalMs = refreshSeconds * 1000;
  }

  const category = (config.items || {})[categoryName] || {};
  for (const [name, raw] of Object.entries(category)) {
    if (name.startsWith("_")) continue;
    const itemId = typeof raw === "number" ? raw : raw?.id;
    if (!Number.isInteger(itemId) || itemId <= 0) continue;
    const minimum = typeof raw === "object" && Number.isInteger(raw.minimum)
      ? Math.max(0, raw.minimum)
      : 0;
    const card = new StockCard(name, itemId, minimum);
    gridEl.appendChild(card.element);
    cards.set(itemId, card);
  }

  if (!cards.size) {
    gridEl.innerHTML = '<p class="text-muted" style="padding:24px">No items configured in this category.</p>';
  }

  fetchAndUpdate();
  scheduleRefresh();
  startCountdown();
  layoutCards();
  new ResizeObserver(layoutCards).observe(gridEl);
}

/** Keep each card in an explicit column so expanding one cannot rebalance others. */
function layoutCards() {
  const cardList = [...cards.values()];
  if (!cardList.length) return;

  const styles = getComputedStyle(gridEl);
  const minWidth = parseFloat(styles.getPropertyValue("--card-min-width")) || 320;
  const gap = parseFloat(styles.columnGap) || 12;
  const padding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
  const columnCount = Math.max(1, Math.floor((gridEl.clientWidth - padding + gap) / (minWidth + gap)));

  gridEl.querySelectorAll(".card-column").forEach((column) => column.remove());
  const columns = Array.from({ length: columnCount }, () => {
    const column = document.createElement("div");
    column.className = "card-column";
    gridEl.appendChild(column);
    return column;
  });
  cardList.forEach((card, index) => columns[index % columnCount].appendChild(card.element));
}

async function fetchAndUpdate() {
  if (fetching) return;
  fetching = true;
  statusEl.textContent = "Refreshing...";
  try {
    const itemIds = [...cards.keys()];
    const [stock, orders] = await Promise.all([
      window.api.fetchStock(itemIds),
      window.api.fetchOrders(),
    ]);

    for (const [itemId, card] of cards) {
      const buyOrder = orders?.buys?.[itemId] || null;
      card.update(stock[itemId], buyOrder);
    }
    statusEl.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    statusEl.textContent = `Error: ${error.message}`;
    console.error("Stock fetch error:", error);
  } finally {
    fetching = false;
  }
}

function scheduleRefresh() {
  clearInterval(refreshHandle);
  nextRefreshAt = Date.now() + updateIntervalMs;
  refreshHandle = setInterval(() => {
    nextRefreshAt = Date.now() + updateIntervalMs;
    fetchAndUpdate();
  }, updateIntervalMs);
}

function startCountdown() {
  clearInterval(countdownHandle);
  countdownHandle = setInterval(() => {
    const seconds = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000));
    nextEl.textContent = `Next refresh in ${seconds}s`;
  }, 1000);
}

refreshBtn.addEventListener("click", () => {
  scheduleRefresh();
  fetchAndUpdate();
});

class StockCard {
  constructor(name, itemId, minimum) {
    this.minimum = minimum;
    this.element = document.createElement("div");
    this.element.className = "item-card";

    const header = document.createElement("div");
    header.className = "item-card__header";
    const toggle = document.createElement("span");
    toggle.className = "item-card__toggle item-card__toggle--closed";
    toggle.textContent = "▶";
    const nameEl = document.createElement("span");
    nameEl.className = "item-card__name";
    nameEl.textContent = name;
    this.summary = document.createElement("span");
    this.summary.className = "item-card__summary";
    this.summary.title = `Minimum: ${minimum}`;
    header.append(toggle, nameEl, this.summary);

    this.body = document.createElement("div");
    this.body.className = "item-card__body item-card__body--hidden";
    this.details = document.createElement("div");
    this.details.className = "item-card__details";
    this.body.appendChild(this.details);
    this.element.append(header, this.body);

    header.addEventListener("click", () => {
      const collapsed = this.body.classList.toggle("item-card__body--hidden");
      toggle.textContent = collapsed ? "▶" : "▼";
      toggle.className = `item-card__toggle item-card__toggle--${collapsed ? "closed" : "open"}`;
    });
  }

  update(data = { total: 0, locations: [] }, buyOrder = null) {
    const total = Number(data.total) || 0;
    const buyOrderAmount = Number(buyOrder?.quantity) || 0;
    const belowMinimum = total < this.minimum;
    this.summary.textContent = `${total} current stock (${buyOrderAmount} buy orders)`;
    this.summary.className = `item-card__summary ${belowMinimum ? "text-danger" : "text-success"}`;
    this.summary.title = `Minimum: ${this.minimum}`;

    const details = [
      buyOrderAmount > 0 ? `<div>Buy orders: <strong>${buyOrderAmount}</strong></div>` : "<div>Buy orders: <strong>0</strong></div>",
    ];
    if (Array.isArray(data.locations) && data.locations.length) {
      details.push(...data.locations.map(({ location, amount }) => `<div>${escapeHtml(location)}: <strong>${amount}</strong></div>`));
    } else {
      details.push("<div>No stock found on the account.</div>");
    }
    this.details.innerHTML = details.join("");
  }
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

init();
