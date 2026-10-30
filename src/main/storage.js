const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG = {
  api_key: "",
  items: {
    Runes: {
      _default_order_type: "sell",
      "Superior Rune of the Scholar": 24836,
      "Superior Rune of the Dragonhunter": 77575,
    },
  },
};

function createStorage(appDataDir) {
  const paths = {
    config: path.join(appDataDir, "config.json"),
    transactionHistory: path.join(appDataDir, "transaction-history.json"),
    investments: path.join(appDataDir, "investments.json"),
    soldInvestments: path.join(appDataDir, "sold-investments.json"),
    itemDatabase: path.join(appDataDir, "items.json"),
  };

  function loadJson(filePath, fallback) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return fallback;
    }
  }

  function saveJson(filePath, value) {
    fs.mkdirSync(appDataDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
  }

  function loadConfig() {
    if (!fs.existsSync(paths.config)) saveJson(paths.config, DEFAULT_CONFIG);
    return loadJson(paths.config, structuredClone(DEFAULT_CONFIG));
  }

  function saveConfig(config) {
    saveJson(paths.config, config);
  }

  function loadTransactionHistory() {
    const saved = loadJson(paths.transactionHistory, null);
    if (!Array.isArray(saved?.transactions)) return null;
    return {
      transactions: saved.transactions,
      itemNames: saved.itemNames && typeof saved.itemNames === "object" ? saved.itemNames : {},
    };
  }

  function saveTransactionHistory(history) {
    saveJson(paths.transactionHistory, history);
  }

  function loadInvestments() {
    const saved = loadJson(paths.investments, null);
    return Array.isArray(saved?.investments) ? saved.investments : [];
  }

  function saveInvestments(investments) {
    saveJson(paths.investments, { investments });
  }

  function loadSoldInvestments() {
    const saved = loadJson(paths.soldInvestments, null);
    return Array.isArray(saved?.items) ? saved.items : [];
  }

  function saveSoldInvestments(items) {
    saveJson(paths.soldInvestments, { items });
  }

  function loadItemDatabase() {
    const saved = loadJson(paths.itemDatabase, null);
    return {
      updatedAt: typeof saved?.updatedAt === "string" ? saved.updatedAt : null,
      items: Array.isArray(saved?.items)
        ? saved.items.filter((item) => Number.isInteger(item?.id) && typeof item.name === "string")
        : [],
    };
  }

  function saveItemDatabase(items) {
    saveJson(paths.itemDatabase, {
      updatedAt: new Date().toISOString(),
      items,
    });
  }

  function mergeTransactionHistory(existing, latest) {
    const merged = new Map();
    for (const transaction of [...(existing?.transactions || []), ...latest.transactions]) {
      const key = `${transaction.type}:${transaction.id ?? `${transaction.item_id}:${transaction.created}:${transaction.price}:${transaction.quantity}`}`;
      merged.set(key, transaction);
    }
    return {
      transactions: [...merged.values()],
      itemNames: { ...(existing?.itemNames || {}), ...latest.itemNames },
    };
  }

  return {
    paths,
    DEFAULT_CONFIG,
    loadConfig,
    saveConfig,
    loadTransactionHistory,
    saveTransactionHistory,
    loadInvestments,
    saveInvestments,
    loadSoldInvestments,
    saveSoldInvestments,
    loadItemDatabase,
    saveItemDatabase,
    mergeTransactionHistory,
  };
}

module.exports = { createStorage };
