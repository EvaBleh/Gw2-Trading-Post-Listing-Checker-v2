/**
 * launcher.js — Renderer script for the main launcher window.
 *
 * Loads configured categories and forwards launcher actions to the main process.
 */

const categoryButtonsEl = document.getElementById("category-buttons");
const deliveryButton    = document.getElementById("btn-delivery");
const settingsButton    = document.getElementById("btn-settings");

/** Build the category buttons from the current saved configuration. */
async function loadCategories() {
  const config = await window.api.getConfig();
  categoryButtonsEl.innerHTML = "";

  for (const categoryName of Object.keys(config.items || {})) {
    const button = document.createElement("button");
    button.className = "btn btn--primary btn--block";
    button.textContent = categoryName;
    button.addEventListener("click", () => {
      window.api.openCategoryWindow(categoryName);
    });
    categoryButtonsEl.appendChild(button);
  }
}

deliveryButton.addEventListener("click", () => {
  window.api.openDeliveryWindow();
});

settingsButton.addEventListener("click", () => {
  window.api.openSettingsWindow();
});

window.api.on("reload-launcher", loadCategories);
loadCategories();
