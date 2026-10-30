const { BrowserWindow } = require("electron");
const path = require("path");

function createWindowManager({ mainDir, loadConfig }) {
  let launcherWin = null;
  const categoryWindows = {};
  let deliveryWin = null;
  let currentOrdersWin = null;
  let transactionHistoryWin = null;
  let rawTransactionHistoryWin = null;
  let investmentsWin = null;
  let settingsWin = null;

  const baseOptions = {
    webPreferences: {
      preload: path.join(mainDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(mainDir, "assets", "icon.png"),
    backgroundColor: "#1a1a2e",
    show: false,
  };

  function createLauncherWindow() {
    launcherWin = new BrowserWindow({
      ...baseOptions,
      width: 380,
      height: 520,
      minWidth: 320,
      minHeight: 400,
      title: "GW2 Trading Post Checker",
    });
    launcherWin.loadFile(path.join(mainDir, "renderer", "launcher.html"));
    launcherWin.once("ready-to-show", () => launcherWin.show());
    launcherWin.on("closed", () => { launcherWin = null; });
    launcherWin.setMenuBarVisibility(false);
  }

  function openCategoryWindow(categoryName) {
    if (categoryWindows[categoryName] && !categoryWindows[categoryName].isDestroyed()) {
      categoryWindows[categoryName].focus();
      return;
    }
    const win = new BrowserWindow({
      ...baseOptions,
      width: 960,
      height: 600,
      minWidth: 400,
      minHeight: 300,
      title: `GW2 TP — ${categoryName}`,
    });
    const category = loadConfig().items?.[categoryName] || {};
    const page = category._type === "stock" ? "stock.html" : category._type === "investment" ? "investments.html" : "category.html";
    win.loadFile(path.join(mainDir, "renderer", page), { query: { category: categoryName } });
    win.once("ready-to-show", () => win.show());
    win.setMenuBarVisibility(false);
    win.on("closed", () => { delete categoryWindows[categoryName]; });
    categoryWindows[categoryName] = win;
  }

  function openDeliveryWindow() {
    if (deliveryWin && !deliveryWin.isDestroyed()) { deliveryWin.focus(); return; }
    deliveryWin = new BrowserWindow({ ...baseOptions, width: 480, height: 560, minWidth: 360, minHeight: 300, title: "TP Delivery Box" });
    deliveryWin.loadFile(path.join(mainDir, "renderer", "delivery.html"));
    deliveryWin.once("ready-to-show", () => deliveryWin.show());
    deliveryWin.setMenuBarVisibility(false);
    deliveryWin.on("closed", () => { deliveryWin = null; });
  }

  function openRecipeWindow(name, itemId) {
    const win = new BrowserWindow({
      ...baseOptions,
      width: 520,
      height: 560,
      minWidth: 360,
      minHeight: 300,
      title: `Recipe — ${name}`,
      parent: launcherWin || undefined,
      modal: false,
    });
    win.loadFile(path.join(mainDir, "renderer", "recipe.html"), { query: { name, id: String(itemId) } });
    win.once("ready-to-show", () => win.show());
    win.setMenuBarVisibility(false);
  }

  function openCurrentOrdersWindow() {
    if (currentOrdersWin && !currentOrdersWin.isDestroyed()) { currentOrdersWin.focus(); return; }
    currentOrdersWin = new BrowserWindow({ ...baseOptions, width: 820, height: 600, minWidth: 560, minHeight: 300, title: "TP Current Orders" });
    currentOrdersWin.loadFile(path.join(mainDir, "renderer", "current-orders.html"));
    currentOrdersWin.once("ready-to-show", () => currentOrdersWin.show());
    currentOrdersWin.setMenuBarVisibility(false);
    currentOrdersWin.on("closed", () => { currentOrdersWin = null; });
  }

  function openTransactionHistoryWindow() {
    if (transactionHistoryWin && !transactionHistoryWin.isDestroyed()) { transactionHistoryWin.focus(); return; }
    transactionHistoryWin = new BrowserWindow({ ...baseOptions, width: 900, height: 700, minWidth: 560, minHeight: 420, title: "TP Transaction History" });
    transactionHistoryWin.loadFile(path.join(mainDir, "renderer", "transaction-history.html"));
    transactionHistoryWin.once("ready-to-show", () => transactionHistoryWin.show());
    transactionHistoryWin.setMenuBarVisibility(false);
    transactionHistoryWin.on("closed", () => { transactionHistoryWin = null; });
  }

  function openRawTransactionHistoryWindow() {
    if (rawTransactionHistoryWin && !rawTransactionHistoryWin.isDestroyed()) { rawTransactionHistoryWin.focus(); return; }
    rawTransactionHistoryWin = new BrowserWindow({ ...baseOptions, width: 900, height: 700, minWidth: 560, minHeight: 420, title: "TP Raw Transaction History" });
    rawTransactionHistoryWin.loadFile(path.join(mainDir, "renderer", "raw-transaction-history.html"));
    rawTransactionHistoryWin.once("ready-to-show", () => rawTransactionHistoryWin.show());
    rawTransactionHistoryWin.setMenuBarVisibility(false);
    rawTransactionHistoryWin.on("closed", () => { rawTransactionHistoryWin = null; });
  }

  function openInvestmentsWindow(categoryName = null) {
    if (investmentsWin && !investmentsWin.isDestroyed()) { investmentsWin.focus(); return; }
    investmentsWin = new BrowserWindow({ ...baseOptions, width: 900, height: 650, minWidth: 600, minHeight: 400, title: "Investment Tracker" });
    investmentsWin.loadFile(path.join(mainDir, "renderer", "investments.html"), { query: categoryName ? { category: categoryName } : {} });
    investmentsWin.once("ready-to-show", () => investmentsWin.show());
    investmentsWin.setMenuBarVisibility(false);
    investmentsWin.on("closed", () => { investmentsWin = null; });
  }

  function openSettingsWindow() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
    settingsWin = new BrowserWindow({ ...baseOptions, width: 860, height: 620, minWidth: 640, minHeight: 480, title: "Settings" });
    settingsWin.loadFile(path.join(mainDir, "renderer", "settings.html"));
    settingsWin.once("ready-to-show", () => settingsWin.show());
    settingsWin.setMenuBarVisibility(false);
    settingsWin.on("closed", () => { settingsWin = null; });
  }

  function reloadLauncher() {
    if (launcherWin && !launcherWin.isDestroyed()) launcherWin.webContents.send("reload-launcher");
  }

  function noLauncherWindows() {
    return BrowserWindow.getAllWindows().length === 0;
  }

  return {
    createLauncherWindow,
    openCategoryWindow,
    openDeliveryWindow,
    openRecipeWindow,
    openCurrentOrdersWindow,
    openTransactionHistoryWindow,
    openRawTransactionHistoryWindow,
    openInvestmentsWindow,
    openSettingsWindow,
    reloadLauncher,
    noLauncherWindows,
  };
}

module.exports = { createWindowManager };
