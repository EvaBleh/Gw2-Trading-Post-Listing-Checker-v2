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
const categoryDialog = document.getElementById("category-dialog");
const categoryDialogForm = document.getElementById("category-dialog-form");
const categoryDialogTitle = document.getElementById("category-dialog-title");
const categoryNameInput = document.getElementById("category-name-input");
const categoryDialogCancel = document.getElementById("category-dialog-cancel");
const categoryTypeSelect = document.getElementById("category-type-select");
const categoryOrderDefault = document.getElementById("category-order-default");
const categoryAlertDefault = document.getElementById("category-alert-default");
const categoryAlertThresholdInput = document.getElementById("category-alert-threshold");
const categoryDialogType = document.getElementById("category-dialog-type");
const itemNameInput = document.getElementById("inp-item-name");
const itemIdInput = document.getElementById("inp-item-id");
const itemNameSearchResults = document.getElementById("item-name-search-results");
let itemSearchTimer = null;

const DEFAULT_REFRESH_INTERVAL_SECONDS = 60;

let config = { api_key: "", items: {} };
/** Name of the category currently shown in the editor. */
let selectedCategory = null;
/** Name of the folder currently selected in the category sidebar. */
let selectedFolder = null;
/** Name of the item currently selected for deletion or editing. */
let selectedItemName = null;

/** Display a temporary success or error notification. */
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

/** Return a category from the working config, creating it when absent. */
function categoryData(name) {
  return config.items[name] || (config.items[name] = {});
}

/** Normalize a legacy or current item config entry for display. */
function itemDetails(value, category) {
  if (typeof value === "number") {
    return { id: value, minimum: 0, orderType: category._default_order_type || "sell" };
  }
  return {
    id: value.id,
    minimum: Number.isInteger(value.minimum) && value.minimum >= 0 ? value.minimum : 0,
    orderType: (value.default_order_type || category._default_order_type || "sell").toLowerCase(),
  };
}

/** Normalize folder membership while preserving category compatibility. */
function categoryFolders() {
  config.categoryFolders = config.categoryFolders && typeof config.categoryFolders === "object"
    ? config.categoryFolders
    : {};
  for (const categories of Object.values(config.categoryFolders)) {
    if (!Array.isArray(categories)) continue;
  }
  return config.categoryFolders;
}

function folderForCategory(categoryName) {
  for (const [folderName, categories] of Object.entries(categoryFolders())) {
    if (Array.isArray(categories) && categories.includes(categoryName)) return folderName;
  }
  return "";
}

/** Rebuild the category navigation from the working config. */
function renderCategories() {
  categoryList.innerHTML = "";
  const folders = categoryFolders();
  const assigned = new Set(Object.values(folders).flatMap((categories) => Array.isArray(categories) ? categories : []));

  const folderSelect = document.getElementById("category-folder-select");
  folderSelect.innerHTML = '<option value="">Root</option>';
  for (const folderName of Object.keys(folders)) {
    folderSelect.add(new Option(folderName, folderName));
  }
  folderSelect.value = selectedCategory ? folderForCategory(selectedCategory) : "";

  for (const [folderName, categories] of Object.entries(folders)) {
    const li = document.createElement("li");
    li.className = "settings__cat-folder";
    const header = document.createElement("button");
    header.type = "button";
    header.className = `settings__cat-folder-name${folderName === selectedFolder ? " settings__cat-item--active" : ""}`;
    header.textContent = `${folderName}`;
    header.addEventListener("click", () => {
      selectedFolder = folderName;
      selectedCategory = null;
      selectedItemName = null;
      renderCategories();
      renderItems();
    });
    li.appendChild(header);
    const nested = document.createElement("div");
    nested.className = "settings__cat-folder-items";
    for (const name of categories.filter((category) => config.items?.[category])) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `settings__cat-item${name === selectedCategory ? " settings__cat-item--active" : ""}`;
      button.textContent = name;
      button.addEventListener("click", () => selectCategory(name));
      nested.appendChild(button);
    }
    li.appendChild(nested);
    categoryList.appendChild(li);
  }

  for (const name of Object.keys(config.items || {})) {
    if (assigned.has(name)) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `settings__cat-item${name === selectedCategory ? " settings__cat-item--active" : ""}`;
    button.textContent = name;
    button.addEventListener("click", () => selectCategory(name));
    const li = document.createElement("li");
    li.appendChild(button);
    categoryList.appendChild(li);
  }
}

/** Rebuild the item table for the selected category. */
function populateSelectedItemForm() {
  clearTimeout(itemSearchTimer);
  itemNameSearchResults.innerHTML = "";
  const nameInput = document.getElementById("inp-item-name");
  const idInput = document.getElementById("inp-item-id");
  const minimumInput = document.getElementById("inp-item-minimum");
  const addButton = document.getElementById("btn-add-item");

  if (!selectedCategory || !config.items[selectedCategory] || !selectedItemName) {
    nameInput.value = "";
    idInput.value = "";
    minimumInput.value = "";
    document.querySelector('input[name="add-ot"][value="sell"]').checked = true;
    addButton.textContent = "+ Add Item";
    return;
  }

  const category = categoryData(selectedCategory);
  const value = category[selectedItemName];
  const details = itemDetails(value, category);
  nameInput.value = selectedItemName;
  idInput.value = details.id;
  minimumInput.value = category._type === "stock" ? details.minimum : "";
  const orderValue = details.orderType || "sell";
  document.querySelector(`input[name="add-ot"][value="${orderValue}"]`).checked = true;
  addButton.textContent = "Update Item";
}

function renderItems() {
  itemTbody.innerHTML = "";
  if (!selectedCategory || !config.items[selectedCategory]) {
    itemsHeader.textContent = "Select a category to manage its items";
    populateSelectedItemForm();
    return;
  }

  const category = categoryData(selectedCategory);
  itemsHeader.textContent = selectedCategory;
  const categoryType = ["stock", "investment"].includes(category._type) ? category._type : "orders";
  categoryTypeSelect.value = categoryType;
  categoryOrderDefault.hidden = categoryType !== "orders";
  categoryAlertDefault.hidden = categoryType !== "orders";
  categoryAlertThresholdInput.value = Number.isInteger(category._alert_threshold) ? category._alert_threshold : 0;
  document.getElementById("inp-item-minimum").disabled = categoryType !== "stock";
  document.getElementById("rd-sell").checked = (category._default_order_type || "sell").toLowerCase() === "sell";
  document.getElementById("rd-buy").checked = !document.getElementById("rd-sell").checked;

  for (const [name, value] of Object.entries(category)) {
    if (name.startsWith("_")) continue;
    const details = itemDetails(value, category);
    const row = document.createElement("tr");
    row.className = name === selectedItemName ? "settings-table__row--selected" : "";
    const minimum = category._type === "stock" ? details.minimum : "-";
    row.innerHTML = `<td>${escapeHtml(name)}</td><td>${details.id}</td><td>${minimum}</td><td>${details.orderType}</td><td></td>`;
    row.addEventListener("click", () => {
      selectedItemName = name;
      renderItems();
      populateSelectedItemForm();
    });
    itemTbody.appendChild(row);
  }

  populateSelectedItemForm();
}

/** Select a category and refresh both editor sections. */
function selectCategory(name) {
  selectedCategory = name;
  selectedFolder = null;
  selectedItemName = null;
  renderCategories();
  renderItems();
}

/** Escape user-provided config names before inserting them into HTML. */
function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Show the reusable category-name dialog and resolve its submitted value. */
function requestCategoryName(title, initialValue = "", initialType = "orders") {
  return new Promise((resolve) => {
    categoryDialogTitle.textContent = title;
    categoryNameInput.value = initialValue;
    categoryDialog.hidden = false;
    categoryNameInput.focus();
    categoryNameInput.select();
    categoryDialogType.value = initialType;

    const finish = (value) => {
      categoryDialog.hidden = true;
      categoryDialogForm.removeEventListener("submit", submit);
      categoryDialogCancel.removeEventListener("click", cancel);
      resolve(value);
    };
    const submit = (event) => {
      event.preventDefault();
      finish(categoryNameInput.value.trim());
    };
    const cancel = () => finish(null);
    categoryDialogForm.addEventListener("submit", submit);
    categoryDialogCancel.addEventListener("click", cancel);
  });
}

async function addFolder() {
  const name = await requestCategoryName("Add folder");
  if (!name) return;
  const folders = categoryFolders();
  if (folders[name]) return showMessage("A folder with that name already exists.", true);
  if (config.items[name]) return showMessage("A category with that name already exists.", true);
  folders[name] = [];
  renderCategories();
}

function moveSelectedCategory() {
  if (!selectedCategory) return showMessage("Select a category first.", true);
  const folders = categoryFolders();
  for (const categories of Object.values(folders)) {
    if (Array.isArray(categories)) {
      const index = categories.indexOf(selectedCategory);
      if (index >= 0) categories.splice(index, 1);
    }
  }
  const folderName = document.getElementById("category-folder-select").value;
  if (folderName) {
    if (!Array.isArray(folders[folderName])) folders[folderName] = [];
    folders[folderName].push(selectedCategory);
  }
  renderCategories();
  showMessage(folderName ? `Moved "${selectedCategory}" to "${folderName}".` : `Moved "${selectedCategory}" to root.`);
}

/** Add a new empty category to the working config. */
async function addCategory() {
  const name = await requestCategoryName("Add category");
  if (!name) return;
  if (config.items[name]) return showMessage("A category with that name already exists.", true);
  config.items[name] = {
    _type: categoryDialogType.value,
    _default_order_type: "sell",
    _alert_threshold: 0,
  };
  selectCategory(name);
}

/** Rename the selected category while preserving its item configuration. */
async function renameCategory() {
  if (selectedFolder) {
    const folders = categoryFolders();
    const name = await requestCategoryName("Rename folder", selectedFolder);
    if (!name || name === selectedFolder) return;
    if (folders[name] || config.items[name]) return showMessage("A folder or category with that name already exists.", true);
    folders[name] = folders[selectedFolder];
    delete folders[selectedFolder];
    selectedFolder = name;
    renderCategories();
    return;
  }
  if (!selectedCategory) return;
  const name = await requestCategoryName("Rename category", selectedCategory, categoryData(selectedCategory)._type || "orders");
  if (!name || name === selectedCategory) return;
  if (config.items[name]) return showMessage("A category with that name already exists.", true);
  config.items[name] = config.items[selectedCategory];
  if (!Number.isInteger(config.items[name]._alert_threshold)) {
    config.items[name]._alert_threshold = 0;
  }
  delete config.items[selectedCategory];
  for (const categories of Object.values(categoryFolders())) {
    if (Array.isArray(categories)) {
      const index = categories.indexOf(selectedCategory);
      if (index >= 0) categories[index] = name;
    }
  }
  selectCategory(name);
}

/** Delete the selected category or folder after user confirmation. */
function deleteCategory() {
  if (selectedFolder) {
    if (!confirm(`Delete folder "${selectedFolder}"? Categories inside it will move to root.`)) return;
    delete categoryFolders()[selectedFolder];
    selectedFolder = null;
    selectedCategory = Object.keys(config.items)[0] || null;
    renderCategories();
    renderItems();
    return;
  }
  if (!selectedCategory) return showMessage("Select a category or folder first.", true);
  if (!confirm(`Delete category "${selectedCategory}"?`)) return;
  delete config.items[selectedCategory];
  for (const categories of Object.values(categoryFolders())) {
    if (Array.isArray(categories)) {
      const index = categories.indexOf(selectedCategory);
      if (index >= 0) categories.splice(index, 1);
    }
  }
  selectedCategory = Object.keys(config.items)[0] || null;
  selectedItemName = null;
  renderCategories();
  renderItems();
}

/** Add a validated item entry to the selected category. */
function addItem() {
  if (!selectedCategory) return showMessage("Select a category first.", true);
  const nameInput = document.getElementById("inp-item-name");
  const idInput = document.getElementById("inp-item-id");
  const minimumInput = document.getElementById("inp-item-minimum");
  const name = nameInput.value.trim();
  const id = Number(idInput.value);
  const minimum = Number(minimumInput.value || 0);
  const category = categoryData(selectedCategory);

  if (!name || !Number.isInteger(id) || id <= 0 || !Number.isInteger(minimum) || minimum < 0) {
    return showMessage("Enter an item name, valid ID, and non-negative minimum.", true);
  }

  let previousName = selectedItemName;
  const isEditing = Boolean(selectedItemName && category[selectedItemName]);
  if (isEditing && previousName !== name && category[name] && category[name] !== category[previousName]) {
    return showMessage("An item with that name already exists in this category.", true);
  }

  if (isEditing && previousName !== name) {
    delete category[previousName];
  }

  category[name] = {
    id,
    minimum,
    default_order_type: document.querySelector('input[name="add-ot"]:checked').value,
  };

  selectedItemName = name;
  nameInput.value = "";
  idInput.value = "";
  minimumInput.value = "";
  document.querySelector('input[name="add-ot"][value="sell"]').checked = true;
  renderItems();
}

/** Delete the currently selected item from the working config. */
function moveSelectedItem(direction) {
  if (!selectedCategory || !selectedItemName) return showMessage("Select an item first.", true);

  const category = categoryData(selectedCategory);
  const entries = Object.entries(category).filter(([name]) => !name.startsWith("_"));
  const currentIndex = entries.findIndex(([name]) => name === selectedItemName);
  const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;

  if (currentIndex === -1 || targetIndex < 0 || targetIndex >= entries.length) {
    return;
  }

  const reordered = {};
  const metaEntries = Object.entries(category).filter(([name]) => name.startsWith("_"));
  for (const [name, value] of metaEntries) reordered[name] = value;

  const itemEntries = [...entries];
  const [moved] = itemEntries.splice(currentIndex, 1);
  itemEntries.splice(targetIndex, 0, moved);

  for (const [name, value] of itemEntries) reordered[name] = value;
  config.items[selectedCategory] = reordered;
  selectedItemName = moved[0];
  renderItems();
}

function deleteItem() {
  if (!selectedCategory || !selectedItemName) return showMessage("Select an item first.", true);
  delete categoryData(selectedCategory)[selectedItemName];
  selectedItemName = null;
  populateSelectedItemForm();
  renderItems();
}

/** Validate and persist the current settings, then refresh the launcher. */
async function applyChanges() {
  try {
    config.api_key = apiKeyInput.value.trim();
    config.refresh_interval_seconds = getRefreshIntervalSeconds();
    if (selectedCategory) {
      categoryData(selectedCategory)._default_order_type = document.querySelector('input[name="cat-default"]:checked').value;
      const threshold = Number(categoryAlertThresholdInput.value);
      categoryData(selectedCategory)._alert_threshold = Number.isInteger(threshold) && threshold >= 0 ? threshold : 0;
    }
    await window.api.saveConfig(config);
    await window.api.reloadLauncher();
    showMessage("Settings saved.");
  } catch (error) {
    showMessage(error.message, true);
  }
}

/** Read and validate the configured automatic refresh interval. */
function getRefreshIntervalSeconds() {
  const seconds = Number(refreshIntervalInput.value);
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 86400) {
    throw new Error("Refresh interval must be a whole number from 10 to 86400 seconds.");
  }
  return seconds;
}

/** Serialize the working config into the export text area. */
function exportJson() {
  try {
    config.api_key = apiKeyInput.value.trim();
    config.refresh_interval_seconds = getRefreshIntervalSeconds();
    if (selectedCategory) {
      categoryData(selectedCategory)._default_order_type = document.querySelector('input[name="cat-default"]:checked').value;
      const threshold = Number(categoryAlertThresholdInput.value);
      categoryData(selectedCategory)._alert_threshold = Number.isInteger(threshold) && threshold >= 0 ? threshold : 0;
    }
    configJsonInput.value = JSON.stringify(config, null, 2);
    configJsonInput.focus();
    configJsonInput.select();
    showMessage("JSON exported to the text area.");
  } catch (error) {
    showMessage(error.message, true);
  }
}

/** Copy the exported config JSON to the system clipboard. */
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

/** Parse and apply config JSON from the import text area without saving it. */
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

/** Close settings and discard unsaved changes. */
function cancelChanges() {
  window.close();
}

document.getElementById("btn-toggle-key").addEventListener("click", (event) => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  event.currentTarget.textContent = apiKeyInput.type === "password" ? "Show" : "Hide";
});
document.getElementById("btn-add-cat").addEventListener("click", addCategory);
document.getElementById("btn-add-folder").addEventListener("click", addFolder);
document.getElementById("btn-move-category").addEventListener("click", moveSelectedCategory);
document.getElementById("btn-rename-cat").addEventListener("click", renameCategory);
document.getElementById("btn-del-cat").addEventListener("click", deleteCategory);
document.getElementById("btn-add-item").addEventListener("click", addItem);
document.getElementById("btn-move-item-up").addEventListener("click", () => moveSelectedItem("up"));
document.getElementById("btn-move-item-down").addEventListener("click", () => moveSelectedItem("down"));
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
categoryTypeSelect.addEventListener("change", () => {
  if (!selectedCategory) return;
  categoryData(selectedCategory)._type = categoryTypeSelect.value;
  if (categoryTypeSelect.value === "stock") {
    categoryData(selectedCategory)._alert_threshold = 0;
  }
  document.getElementById("inp-item-minimum").disabled = categoryTypeSelect.value !== "stock";
  renderItems();
});
categoryAlertThresholdInput.addEventListener("change", () => {
  if (!selectedCategory) return;
  const value = Number(categoryAlertThresholdInput.value);
  categoryData(selectedCategory)._alert_threshold = Number.isInteger(value) && value >= 0 ? value : 0;
  renderItems();
});

itemNameInput.addEventListener("input", () => {
  clearTimeout(itemSearchTimer);
  itemIdInput.value = "";
  const query = itemNameInput.value.trim();
  if (!query) {
    itemNameSearchResults.innerHTML = "";
    return;
  }

  itemNameSearchResults.innerHTML = '<div class="settings__item-search-empty">Searching…</div>';
  itemSearchTimer = setTimeout(async () => {
    try {
      const items = await window.api.searchInvestmentItems(query);
      itemNameSearchResults.innerHTML = "";
      if (!items.length) {
        itemNameSearchResults.innerHTML = '<div class="settings__item-search-empty">No items found.</div>';
        return;
      }

      for (const item of items.slice(0, 15)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "settings__item-search-result";
        button.innerHTML = `<span>${escapeHtml(item.name)}</span><span class="text-muted">${item.id}</span>`;
        button.addEventListener("click", () => {
          itemNameInput.value = item.name;
          itemIdInput.value = String(item.id);
          itemNameSearchResults.innerHTML = "";
          itemIdInput.focus();
        });
        itemNameSearchResults.appendChild(button);
      }
    } catch (error) {
      itemNameSearchResults.innerHTML = `<div class="settings__item-search-empty text-danger">${escapeHtml(error.message)}</div>`;
    }
  }, 250);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".settings__item-search")) {
    itemNameSearchResults.innerHTML = "";
  }
});

/** Load the saved configuration and initialize the settings editor. */
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
