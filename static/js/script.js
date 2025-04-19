// Global variables to store fetched data
window.recipesData = {};
window.rawMaterialsSet = new Set();
window.shoppingList = new Map(); // Map<itemName, quantity>
window.recipeMeta = []; // For storing { name, image_path, description }

// --- Utility Functions ---
function getSafeQuantity(value) {
    const num = parseInt(value, 10);
    return isNaN(num) || num < 1 ? 1 : num;
}

// --- Recursive Calculation Logic (JavaScript Version) ---
function getBaseMaterials(itemName, quantity, recipes, rawMaterials) {
    const baseMaterials = new Map(); // Use Map for easier handling
    const materialsToProcess = [[itemName, parseFloat(quantity)]]; // Stack: [item, quantity_needed]
    const processedRecipes = new Map(); // Track processed recipes to prevent cycles: key=itemName, value=Set of input tuples

    const maxDepth = 100; // Safety break
    let currentDepth = 0;

    while (materialsToProcess.length > 0 && currentDepth < maxDepth) {
        const [currentItem, currentQtyNeeded] = materialsToProcess.pop();
        currentDepth++;

        // console.log(`Processing: ${currentItem} x ${currentQtyNeeded}`);

        // Is it a raw material?
        if (rawMaterials.has(currentItem)) {
            baseMaterials.set(currentItem, (baseMaterials.get(currentItem) || 0) + currentQtyNeeded);
            // console.log(`  -> Raw material found. Added ${currentQtyNeeded} to ${currentItem}. Total: ${baseMaterials.get(currentItem)}`);
            continue;
        }

        // Is it a known recipe?
        if (recipes[currentItem]) {
            const recipe = recipes[currentItem];
            const outputQty = recipe.output_qty || 1;
            const inputs = recipe.inputs || {};
            const inputItems = Object.entries(inputs).sort((a, b) => a[0].localeCompare(b[0])); // Sort for consistent key

            // Calculate how many times we need to craft this recipe
            const craftCount = currentQtyNeeded / outputQty;
            // console.log(`  -> Recipe found: ${currentItem} produces ${outputQty}. Need ${currentQtyNeeded}, so craft ${craftCount.toFixed(2)} times.`);

            // Check for cycles: has this item been processed with these exact inputs in this path?
            // Note: A simpler cycle check just using the item name might be sufficient for most cases
            //       but this version tries to mimic the Python logic slightly more closely.
            // A very basic cycle check: If we are asked to craft something we are already calculating higher up.
            // This needs a more robust path tracking for full cycle detection, but let's keep it simple for now.
            // We'll rely primarily on maxDepth.
            /*
            const inputsKey = JSON.stringify(inputItems);
            if (processedRecipes.has(currentItem) && processedRecipes.get(currentItem).has(inputsKey)) {
                 console.warn(`Cycle detected or recipe re-processed: ${currentItem}. Skipping.`);
                 continue;
            }
            if (!processedRecipes.has(currentItem)) {
                 processedRecipes.set(currentItem, new Set());
            }
            processedRecipes.get(currentItem).add(inputsKey);
            */

            // Add its ingredients to the stack
            for (const [ingredient, amountPerCraft] of Object.entries(inputs)) {
                if (ingredient) {
                    const ingredientNeededTotal = amountPerCraft * craftCount;
                    materialsToProcess.push([ingredient, ingredientNeededTotal]);
                    // console.log(`    Added ingredient to stack: ${ingredient} x ${ingredientNeededTotal.toFixed(2)}`);
                }
            }
        } else {
            // Item is not raw and not in recipes
            console.warn(`Warning: Item '${currentItem}' is not found in recipes or raw materials. Treating as raw.`);
            baseMaterials.set(currentItem, (baseMaterials.get(currentItem) || 0) + currentQtyNeeded);
        }
    }

    if (currentDepth >= maxDepth) {
        console.warn("Warning: Reached maximum calculation depth. Results might be incomplete.");
    }

    // Convert Map to object and round quantities up (ceil) or just round
    const finalMaterials = {};
    for (const [key, value] of baseMaterials.entries()) {
        const roundedValue = Math.round(value + 0.00001);
        if (roundedValue > 0) {
            finalMaterials[key] = roundedValue;
        }
    }

    return finalMaterials;
}

// --- DOM Update Functions ---
function renderShoppingList() {
    const listElement = document.getElementById('shopping-list-items');
    listElement.innerHTML = ''; // Clear current list

    if (window.shoppingList.size === 0) {
        listElement.innerHTML = '<li class="text-gray-500 italic px-3 py-2">List is empty</li>';
        return;
    }

    const sortedList = Array.from(window.shoppingList.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    sortedList.forEach(([itemName, quantity]) => {
        const meta = window.recipeMeta.find(r => r.name === itemName);
        const imagePath = meta?.image_path && meta.image_path !== 'null' ? meta.image_path : null;

        const li = document.createElement('li');
        li.className = 'flex items-center gap-3 px-3 py-2 border-b border-gray-700 last:border-b-0 hover:bg-gray-700 transition duration-150 ease-in-out';
        li.dataset.itemName = itemName;

        // Image (optional)
        if (imagePath) {
            li.innerHTML += `<img src="${imagePath}" alt="${itemName}" class="w-8 h-8 object-contain flex-shrink-0 rounded-sm bg-gray-600 p-0.5">`;
        } else {
            li.innerHTML += `<div class="w-8 h-8 flex-shrink-0 rounded-sm bg-gray-600"></div>`; // Placeholder
        }

        // Name
        li.innerHTML += `<span class="flex-grow text-sm font-medium text-gray-300">${itemName}</span>`;

        // Quantity Controls
        li.innerHTML += `
            <div class="flex items-center gap-1 flex-shrink-0">
                <button class="decrease-qty-btn p-1 rounded bg-gray-600 hover:bg-red-700 text-white leading-none" data-item="${itemName}">-</button>
                <input type="number" value="${quantity}" min="1" class="list-quantity-input w-12 text-center p-1 bg-gray-600 border border-gray-500 rounded text-sm" data-item="${itemName}">
                <button class="increase-qty-btn p-1 rounded bg-gray-600 hover:bg-green-700 text-white leading-none" data-item="${itemName}">+</button>
            </div>
        `;

        // Remove Button
        li.innerHTML += `<button class="remove-item-btn p-1 rounded bg-red-600 hover:bg-red-800 text-white leading-none flex-shrink-0" data-item="${itemName}">&times;</button>`;

        listElement.appendChild(li);
    });

    // Add event listeners after rendering
    addShoppingListEventListeners();
}

function renderTotalMaterials() {
    const listElement = document.getElementById('total-materials-list');
    const listErrorMsg = document.getElementById('list-error-message');
    listElement.innerHTML = '';
    listErrorMsg.textContent = ''; // Clear previous errors

    if (window.shoppingList.size === 0) {
        listElement.innerHTML = '<li class="text-gray-500 italic">List is empty</li>';
        return;
    }

    const totalBaseMaterials = new Map();
    let calculationError = false;

    try {
        for (const [itemName, quantity] of window.shoppingList.entries()) {
            if (quantity > 0) {
                const itemMaterials = getBaseMaterials(itemName, quantity, window.recipesData, window.rawMaterialsSet);
                for (const [material, amount] of Object.entries(itemMaterials)) {
                    totalBaseMaterials.set(material, (totalBaseMaterials.get(material) || 0) + amount);
                }
            }
        }
    } catch (error) {
        console.error("Error during total calculation:", error);
        listErrorMsg.textContent = `Calculation Error: ${error.message}`; 
        calculationError = true;
        listElement.innerHTML = '<li class="text-red-500 italic">Error calculating totals.</li>';
    }

    if (!calculationError && totalBaseMaterials.size === 0) {
         listElement.innerHTML = '<li class="text-gray-500 italic">No base materials required.</li>';
         return;
    }
    
    if (!calculationError) {
        const sortedMaterials = Array.from(totalBaseMaterials.entries()).sort((a, b) => a[0].localeCompare(b[0]));
        sortedMaterials.forEach(([material, amount]) => {
            const li = document.createElement('li');
            li.className = 'text-sm text-gray-300 py-1 flex justify-between';
            li.innerHTML = `<span>${material}</span><span class="font-semibold text-gray-100">${amount}</span>`;
            listElement.appendChild(li);
        });
    }
}

// --- Event Handling ---
function handleAddItem() {
    const itemSelect = document.getElementById('item-select');
    const quantityInput = document.getElementById('quantity-input');
    const addErrorMsg = document.getElementById('add-error-message');
    addErrorMsg.textContent = ''; // Clear previous errors

    const itemName = itemSelect.value;
    const quantity = getSafeQuantity(quantityInput.value);

    if (!itemName) {
        addErrorMsg.textContent = 'Please select an item.';
        return;
    }

    const currentQuantity = window.shoppingList.get(itemName) || 0;
    window.shoppingList.set(itemName, currentQuantity + quantity);

    renderShoppingList();
    renderTotalMaterials();
}

function updateItemQuantity(itemName, newQuantity) {
    const quantity = getSafeQuantity(newQuantity);
     if (quantity <= 0) { // Should not happen with getSafeQuantity but safety check
         window.shoppingList.delete(itemName);
     } else {
         window.shoppingList.set(itemName, quantity);
     }
     renderShoppingList(); // Re-render to update input value if needed
     renderTotalMaterials();
}

function removeItem(itemName) {
     window.shoppingList.delete(itemName);
     renderShoppingList();
     renderTotalMaterials();
}

// Function to attach listeners to dynamically created elements in the shopping list
function addShoppingListEventListeners() {
    const listContainer = document.getElementById('shopping-list-items');
    if (!listContainer) return; // Safety check

    listContainer.querySelectorAll('.decrease-qty-btn').forEach(button => {
        // Remove old listener before adding new one to prevent duplicates
        button.onclick = null;
        button.onclick = (e) => {
            const itemName = e.target.dataset.item;
            const currentQuantity = window.shoppingList.get(itemName) || 1;
            if (currentQuantity > 1) {
               updateItemQuantity(itemName, currentQuantity - 1);
            } else {
               removeItem(itemName); // Remove if quantity becomes 0 or less
            }
        };
    });

    listContainer.querySelectorAll('.increase-qty-btn').forEach(button => {
        button.onclick = null;
        button.onclick = (e) => {
            const itemName = e.target.dataset.item;
            const currentQuantity = window.shoppingList.get(itemName) || 0;
            updateItemQuantity(itemName, currentQuantity + 1);
        };
    });

    listContainer.querySelectorAll('.list-quantity-input').forEach(input => {
        input.onchange = null;
        input.onblur = null; // Remove old listeners
        input.onchange = (e) => { 
            const itemName = e.target.dataset.item;
            updateItemQuantity(itemName, e.target.value);
        };
         input.onblur = (e) => { 
             const itemName = e.target.dataset.item;
             updateItemQuantity(itemName, e.target.value);
         };
    });

    listContainer.querySelectorAll('.remove-item-btn').forEach(button => {
        button.onclick = null;
        button.onclick = (e) => {
            // Use closest to ensure we get the item name even if click is on icon inside button
            const itemName = e.target.closest('[data-item-name]')?.dataset.itemName; 
             if (itemName) {
                removeItem(itemName);
             } else {
                 console.error('Could not find item name for remove button');
             }
        };
    });
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded and parsed");

    // Select critical elements needed immediately or for error display
    const itemSelect = document.getElementById('item-select');
    const listErrorMsg = document.getElementById('list-error-message');
    const addErrorMsg = document.getElementById('add-error-message');

    // Initial UI state checks
    if (!itemSelect || !listErrorMsg || !addErrorMsg) {
        console.error("Fatal Error: One or more critical UI elements are missing (select/error msg)!");
        document.body.innerHTML = '<p class="text-red-500 p-4">Fatal Error: UI elements missing. Cannot initialize calculator.</p>';
        return; // Stop execution
    }

    // Initial state for elements we know exist
    itemSelect.innerHTML = '<option value="">Loading data...</option>'; // Initial loading message
    itemSelect.disabled = true; // Disable select until data loads

    // Fetch data
    Promise.all([
        fetch('recipes.json')
           .then(res => {
                if (!res.ok) throw new Error(`recipes.json: ${res.statusText} (${res.status})`);
                return res.json();
            }),
        fetch('raw_materials.json')
           .then(res => {
                if (!res.ok) throw new Error(`raw_materials.json: ${res.statusText} (${res.status})`);
                return res.json();
            })
    ])
    .then(([recipeJson, rawMaterialList]) => {
        console.log("Data fetch successful");
        window.recipesData = recipeJson;
        window.rawMaterialsSet = new Set(rawMaterialList);

        // Prepare metadata for dropdown
        window.recipeMeta = Object.entries(recipeJson).map(([name, data]) => ({
            name: name,
            image_path: data.local_image_path,
            description: data.description
        })).sort((a, b) => a.name.localeCompare(b.name));

        // Populate dropdown
        itemSelect.innerHTML = '<option value="">-- Select Item --</option>'; 
        window.recipeMeta.forEach(recipe => {
            const option = document.createElement('option');
            option.value = recipe.name;
            option.textContent = recipe.name;
            itemSelect.appendChild(option);
        });
        
        // Enable item select now that it's populated
        itemSelect.disabled = false;

        // --- Defer button selection and listener attachment --- 
        setTimeout(() => {
             console.log("Attempting to attach listener post-timeout");
             const addToListButton = document.getElementById('add-to-list-button');
             if (addToListButton) {
                 addToListButton.disabled = false; // Enable interaction
                 addToListButton.addEventListener('click', handleAddItem);
                 console.log("Add button listener attached successfully.");
             } else {
                 console.error("Could not find 'add-to-list-button' even after timeout!");
                 if(addErrorMsg) addErrorMsg.textContent = "Error: Add button UI element missing.";
             }
        }, 0); // Zero delay pushes to end of execution queue

        // Initial render of lists (safe to do now)
        renderShoppingList(); 
        renderTotalMaterials();
        console.log("Initial render complete.");

    })
    .catch(error => {
        console.error('Error loading data files:', error);
        const errorTarget = addErrorMsg || listErrorMsg || document.body;
        errorTarget.textContent = `Fatal Error loading data: ${error.message}. Please refresh.`;
        errorTarget.classList.remove('h-4'); 
        itemSelect.innerHTML = '<option value="">Error</option>';
        itemSelect.disabled = true;
        // Attempt to disable button if it exists, even on error
        const addToListButton = document.getElementById('add-to-list-button');
        if (addToListButton) addToListButton.disabled = true;
    });

    console.log("Initialization script finished.");

}); // End of DOMContentLoaded 