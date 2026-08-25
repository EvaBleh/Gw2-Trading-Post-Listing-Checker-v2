/**
 * recipe.js — Renderer for the recipe popup window.
 *
 * Reads ?name=...&id=... from the URL, fetches the recipe tree from the
 * main process, and renders it as a nested <ul> tree.
 */

const titleEl = document.getElementById("recipe-title");
const bodyEl  = document.getElementById("recipe-body");

const params   = new URLSearchParams(window.location.search);
const itemName = params.get("name") || "Item";
const itemId   = parseInt(params.get("id") || "0", 10);

document.title      = `Recipe — ${itemName}`;
titleEl.textContent = itemName;

/**
 * Recursively render a recipe tree node as a <li> containing a <ul> of
 * child ingredients.
 *
 * @param {object} node  { itemId, name, quantity, ingredients[] }
 * @returns {HTMLLIElement}
 */
function renderNode(node) {
  const li = document.createElement("li");
  li.className = "recipe-tree__item";

  // Quantity badge (only shown for ingredient nodes, not the root)
  if (node.quantity) {
    const qty = document.createElement("span");
    qty.className   = "recipe-tree__qty";
    qty.textContent = `${node.quantity}×`;
    li.appendChild(qty);
  }

  li.appendChild(document.createTextNode(node.name));

  if (!node.ingredients || !node.ingredients.length) {
    // Leaf node — mark as base material
    const base = document.createElement("span");
    base.className   = "recipe-tree__base";
    base.textContent = "(base material)";
    li.appendChild(base);
  } else {
    // Recurse
    const ul = document.createElement("ul");
    ul.className = "recipe-tree";
    for (const child of node.ingredients) {
      ul.appendChild(renderNode(child));
    }
    li.appendChild(ul);
  }

  return li;
}

/**
 * Fetch and render the recipe tree.
 */
async function loadRecipe() {
  try {
    const tree = await window.api.fetchRecipe(itemId);

    bodyEl.innerHTML = "";

    const root = document.createElement("ul");
    root.className = "recipe-tree recipe-tree--root";

    if (!tree.ingredients || !tree.ingredients.length) {
      root.innerHTML =
        `<li class="recipe-tree__item">
           <span class="recipe-tree__base">
             No craftable recipe found — this is a base or uncraftable item.
           </span>
         </li>`;
    } else {
      for (const child of tree.ingredients) {
        root.appendChild(renderNode(child));
      }
    }

    bodyEl.appendChild(root);
  } catch (err) {
    bodyEl.innerHTML =
      `<p class="text-danger" style="padding:16px">
         Failed to load recipe: ${err.message}
       </p>`;
  }
}

loadRecipe();