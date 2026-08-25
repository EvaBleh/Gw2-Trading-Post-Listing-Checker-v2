/**
 * settings.js — Renderer script for the settings window.
 *
 * Keeps edits local until Apply & Save is clicked, then persists the full
 * configuration through the preload API.
 */

const apiKeyInput = document.getElementById("api-key-input");
const categoryList = document.getElementById("cat-list");
const itemsHeader = document.getElementById("items-header");
const itemTbody = document.getElementById("item-tbody");
const toastContainer = document.getElementById("toasts");
const configJsonInput = document.getElementById("config-json");
const refreshIntervalInput = document.getElementById("refresh-interval-input");

const DEFAULT_REFRESH_INTERVAL_SECONDS = 60;

let config = { api_key: "", items: {} };
let selectedCategory = null;
let selectedItemName = null;

function showMessage(message, isError = false) {
  toastContainer.innerHTML = "";
  const toast = document.createElement("div");
  toast.className = `toast${isError ? " toast--error" : ""}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 2500);
}

function categoryData(name) {
  return config.items[name] || (config.items[name] = {});
}

function itemDetails(value, category) {
  if (typeof value === "number") {
    return { id: value, orderType: category._default_order_type || "sell" };
  }
  return {
    id: value.id,
    orderType: (value.default_order_type || category._default_order_type || "sell").toLowerCase(),
  };
}

function renderCategories() {
  categoryList.innerHTML = "";
  for (const name of Object.keys(config.items || {})) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `settings__cat${name === selectedCategory ? " settings__cat--selected" : ""}`;
    button.textContent = name;
    button.addEventListener("click", () => selectCategory(name));
    const li = document.createElement("li");
    li.appendChild(button);
    categoryList.appendChild(li);
  }
}

function renderItems() {
  itemTbody.innerHTML = "";
  if (!selectedCategory || !config.items[selectedCategory]) {
    itemsHeader.textContent = "Select a category to manage its items";
    return;
  }

  const category = categoryData(selectedCategory);
  itemsHeader.textContent = selectedCategory;
  document.getElementById("rd-sell").checked = (category._default_order_type || "sell").toLowerCase() === "sell";
  document.getElementById("rd-buy").checked = !document.getElementById("rd-sell").checked;

  for (const [name, value] of Object.entries(category)) {
    if (name.startsWith("_")) continue;
    const details = itemDetails(value, category);
    const row = document.createElement("tr");
    row.className = name === selectedItemName ? "settings-table__row--selected" : "";
    row.innerHTML = `<td>${escapeHtml(name)}</td><td>${details.id}</td><td>${details.orderType}</td><td></td>`;
    row.addEventListener("click", () => {
      selectedItemName = name;
      renderItems();
    });
    itemTbody.appendChild(row);
  }
}

function selectCategory(name) {
  selectedCategory = name;
  selectedItemName = null;
  renderCategories();
  renderItems();
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function addCategory() {
  const name = prompt("Category name:");
  if (!name || config.items[name]) return;
  config.items[name] = { _default_order_type: "sell" };
  selectCategory(name);
}

function renameCategory() {
  if (!selectedCategory) return;
  const name = prompt("New category name:", selectedCategory);
  if (!name || name === selectedCategory || config.items[name]) return;
  config.items[name] = config.items[selectedCategory];
  delete config.items[selectedCategory];
  selectCategory(name);
}

function deleteCategory() {
  if (!selectedCategory || !confirm(`Delete category "${selectedCategory}"?`)) return;
  delete config.items[selectedCategory];
  selectedCategory = Object.keys(config.items)[0] || null;
  selectedItemName = null;
  renderCategories();
  renderItems();
}

function addItem() {
  if (!selectedCategory) return showMessage("Select a category first.", true);
  const nameInput = document.getElementById("inp-item-name");
  const idInput = document.getElementById("inp-item-id");
  const name = nameInput.value.trim();
  const id = Number(idInput.value);
  if (!name || !Number.isInteger(id) || id <= 0) return showMessage("Enter an item name and valid ID.", true);
  const category = categoryData(selectedCategory);
  category[name] = { id, default_order_type: document.querySelector('input[name="add-ot"]:checked').value };
  nameInput.value = "";
  idInput.value = "";
  renderItems();
}

function deleteItem() {
  if (!selectedCategory || !selectedItemName) return showMessage("Select an item first.", true);
  delete categoryData(selectedCategory)[selectedItemName];
  selectedItemName = null;
  renderItems();
}

async function applyChanges() {
  try {
    config.api_key = apiKeyInput.value.trim();
    config.refresh_interval_seconds = getRefreshIntervalSeconds();
    if (selectedCategory) {
      categoryData(selectedCategory)._default_order_type = document.querySelector('input[name="cat-default"]:checked').value;
    }
    await window.api.saveConfig(config);
    await window.api.reloadLauncher();
    showMessage("Settings saved.");
  } catch (error) {
    showMessage(error.message, true);
  }
}

function getRefreshIntervalSeconds() {
  const seconds = Number(refreshIntervalInput.value);
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 86400) {
    throw new Error("Refresh interval must be a whole number from 10 to 86400 seconds.");
  }
  return seconds;
}

function exportJson() {
  try {
    config.api_key = apiKeyInput.value.trim();
    config.refresh_interval_seconds = getRefreshIntervalSeconds();
    if (selectedCategory) {
      categoryData(selectedCategory)._default_order_type = document.querySelector('input[name="cat-default"]:checked').value;
    }
    configJsonInput.value = JSON.stringify(config, null, 2);
    configJsonInput.focus();
    configJsonInput.select();
    showMessage("JSON exported to the text area.");
  } catch (error) {
    showMessage(error.message, true);
  }
}

async function copyJson() {
  if (!configJsonInput.value.trim()) exportJson();
  try {
    await navigator.clipboard.writeText(configJsonInput.value);
    showMessage("JSON copied to the clipboard.");
  } catch {
    configJsonInput.focus();
    configJsonInput.select();
    document.execCommand("copy");
    showMessage("JSON copied to the clipboard.");
  }
}

function importJson() {
  try {
    const imported = JSON.parse(configJsonInput.value);
    if (!imported || typeof imported !== "object" || Array.isArray(imported) ||
        !imported.items || typeof imported.items !== "object" || Array.isArray(imported.items)) {
      throw new Error("JSON must contain an items object.");
    }
    config = {
      api_key: imported.api_key || "",
      refresh_interval_seconds: imported.refresh_interval_seconds || DEFAULT_REFRESH_INTERVAL_SECONDS,
      items: imported.items,
    };
    apiKeyInput.value = config.api_key;
    refreshIntervalInput.value = config.refresh_interval_seconds;
    selectedCategory = Object.keys(config.items)[0] || null;
    selectedItemName = null;
    renderCategories();
    renderItems();
    showMessage("JSON imported. Click Apply & Save to persist it.");
  } catch (error) {
    showMessage(`Invalid config JSON: ${error.message}`, true);
  }
}

function cancelChanges() {
  window.close();
}

document.getElementById("btn-toggle-key").addEventListener("click", (event) => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  event.currentTarget.textContent = apiKeyInput.type === "password" ? "Show" : "Hide";
});
document.getElementById("btn-add-cat").addEventListener("click", addCategory);
document.getElementById("btn-rename-cat").addEventListener("click", renameCategory);
document.getElementById("btn-del-cat").addEventListener("click", deleteCategory);
document.getElementById("btn-add-item").addEventListener("click", addItem);
document.getElementById("btn-del-item").addEventListener("click", deleteItem);
document.getElementById("btn-apply").addEventListener("click", applyChanges);
document.getElementById("btn-cancel").addEventListener("click", cancelChanges);
document.getElementById("btn-export-json").addEventListener("click", exportJson);
document.getElementById("btn-copy-json").addEventListener("click", copyJson);
document.getElementById("btn-import-json").addEventListener("click", importJson);
document.querySelectorAll('input[name="cat-default"]').forEach((input) => {
  input.addEventListener("change", () => {
    if (selectedCategory) categoryData(selectedCategory)._default_order_type = input.value;
  });
});

(async function init() {
  try {
    config = await window.api.getConfig();
    config.items = config.items || {};
    apiKeyInput.value = config.api_key || "";
    refreshIntervalInput.value = config.refresh_interval_seconds || DEFAULT_REFRESH_INTERVAL_SECONDS;
    selectedCategory = Object.keys(config.items)[0] || null;
    renderCategories();
    renderItems();
  } catch (error) {
    showMessage(`Could not load settings: ${error.message}`, true);
  }
})();
