/**
 * launcher.js — Renderer script for the main launcher window.
 *
 * Loads configured categories and forwards launcher actions to the main process.
 */

const categoryButtonsEl = document.getElementById("category-buttons");
const deliveryButton    = document.getElementById("btn-delivery");
const currentOrdersButton = document.getElementById("btn-current-orders");
const transactionHistoryButton = document.getElementById("btn-transaction-history");
const investmentsButton = document.getElementById("btn-investments");
const settingsButton    = document.getElementById("btn-settings");

/** Build the category buttons from the current saved configuration. */
async function loadCategories() {
  const config = await window.api.getConfig();
  categoryButtonsEl.innerHTML = "";

  const folders = config.categoryFolders || {};
  const assigned = new Set(Object.values(folders).flatMap((categories) => Array.isArray(categories) ? categories : []));

  const addCategoryButton = (categoryName) => {
    const button = document.createElement("button");
    button.className = "btn btn--primary btn--block";
    button.textContent = categoryName;
    button.addEventListener("click", () => window.api.openCategoryWindow(categoryName));
    categoryButtonsEl.appendChild(button);
  };

  for (const [folderName, categoryNames] of Object.entries(folders)) {
    const folder = document.createElement("details");
    folder.className = "launcher-folder";
    const summary = document.createElement("summary");
    summary.className = "launcher-folder__summary";
    summary.textContent = `${folderName}`;
    folder.appendChild(summary);

    const children = document.createElement("div");
    children.className = "launcher-folder__children";
    for (const categoryName of categoryNames.filter((name) => config.items?.[name])) {
      const button = document.createElement("button");
      button.className = "btn btn--primary btn--block";
      button.textContent = categoryName;
      button.addEventListener("click", () => window.api.openCategoryWindow(categoryName));
      children.appendChild(button);
    }
    folder.appendChild(children);
    categoryButtonsEl.appendChild(folder);
  }

  for (const categoryName of Object.keys(config.items || {})) {
    if (!assigned.has(categoryName)) addCategoryButton(categoryName);
  }
}

deliveryButton.addEventListener("click", () => {
  window.api.openDeliveryWindow();
});

currentOrdersButton.addEventListener("click", () => {
  window.api.openCurrentOrdersWindow();
});

transactionHistoryButton.addEventListener("click", () => {
  window.api.openTransactionHistoryWindow();
});

investmentsButton.addEventListener("click", () => {
  window.api.openInvestmentsWindow();
});

settingsButton.addEventListener("click", () => {
  window.api.openSettingsWindow();
});

window.api.on("reload-launcher", loadCategories);
loadCategories();
