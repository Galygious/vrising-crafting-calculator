// Global variables to store fetched data
window.recipesData = {};
window.rawMaterialsSet = new Set();

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
        finalMaterials[key] = Math.round(value + 0.00001); // Round to nearest integer
    }

    return finalMaterials;
}

document.addEventListener('DOMContentLoaded', () => {
    const itemSelect = document.getElementById('item-select');
    const quantityInput = document.getElementById('quantity-input');
    const calculateButton = document.getElementById('calculate-button');
    const resultsList = document.getElementById('results-list');
    const errorMessage = document.getElementById('error-message');
    const itemImage = document.getElementById('item-image');
    const selectedItemNameDisplay = document.getElementById('selected-item-name');
    const itemDescriptionDisplay = document.getElementById('item-description');

    let recipeMeta = []; // To store just names and image paths for dropdown

    // --- Fetch Data Files --- 
    Promise.all([
        fetch('recipes.json').then(res => {
            if (!res.ok) throw new Error(`Failed to load recipes.json: ${res.statusText}`);
            return res.json();
        }),
        fetch('raw_materials.json').then(res => {
            if (!res.ok) throw new Error(`Failed to load raw_materials.json: ${res.statusText}`);
            return res.json();
        })
    ])
    .then(([recipeJson, rawMaterialList]) => {
        // Store full data globally
        window.recipesData = recipeJson;
        window.rawMaterialsSet = new Set(rawMaterialList);
        console.log("Recipe and raw material data loaded.");

        // Populate dropdown
        itemSelect.innerHTML = '<option value="">-- Select an Item --</option>'; 
        recipeMeta = Object.entries(recipeJson).map(([name, data]) => ({
            name: name,
            image_path: data.local_image_path, // Use the correct field name
            description: data.description // Store description too
        })).sort((a, b) => a.name.localeCompare(b.name)); // Sort alphabetically
        
        recipeMeta.forEach(recipe => {
            const option = document.createElement('option');
            option.value = recipe.name;
            option.textContent = recipe.name;
            if(recipe.image_path) {
                option.dataset.imagePath = recipe.image_path; 
            }
            if(recipe.description) {
                option.dataset.description = recipe.description;
            }
            itemSelect.appendChild(option);
        });

    })
    .catch(error => {
        console.error('Error loading data files:', error);
        errorMessage.textContent = `Error loading necessary data: ${error.message}`;
        itemSelect.innerHTML = '<option value="">Error loading</option>';
    });

    // --- Event Listeners --- 

    // Event listener for item selection change
    itemSelect.addEventListener('change', () => {
        const selectedOption = itemSelect.options[itemSelect.selectedIndex];
        const imagePath = selectedOption.dataset.imagePath;
        const description = selectedOption.dataset.description;
        const itemName = selectedOption.value;

        if (imagePath && imagePath !== 'null') { // Check for null string too
            itemImage.src = imagePath; // Direct relative path now
            itemImage.alt = itemName;
            itemImage.style.display = 'block';
        } else {
            itemImage.style.display = 'none';
            itemImage.src = "";
            itemImage.alt = "";
        }
        
        selectedItemNameDisplay.textContent = itemName || "Select an item";
        itemDescriptionDisplay.textContent = description || ""; // Show description

        // Clear previous results when item changes
        resultsList.innerHTML = '';
        errorMessage.textContent = '';
    });

    // Event listener for calculate button
    calculateButton.addEventListener('click', () => {
        const selectedItem = itemSelect.value;
        const quantity = quantityInput.value;

        resultsList.innerHTML = '';
        errorMessage.textContent = '';

        if (!selectedItem) {
            errorMessage.textContent = 'Please select an item.';
            return;
        }
        const quantityNum = parseInt(quantity);
        if (!quantityNum || quantityNum <= 0) {
            errorMessage.textContent = 'Please enter a valid quantity (greater than 0).';
            return;
        }
        
        // Ensure data is loaded
        if (!window.recipesData || Object.keys(window.recipesData).length === 0 || !window.rawMaterialsSet || window.rawMaterialsSet.size === 0) {
             errorMessage.textContent = 'Data not loaded yet, please wait or refresh.';
             return;
        }

        // Show loading state 
        resultsList.innerHTML = '<li>Calculating...</li>';

        // Perform calculation using JS function
        try {
            const baseMaterialsResult = getBaseMaterials(selectedItem, quantityNum, window.recipesData, window.rawMaterialsSet);
            
            resultsList.innerHTML = ''; // Clear loading
            if (baseMaterialsResult && Object.keys(baseMaterialsResult).length > 0) {
                const sortedMaterials = Object.entries(baseMaterialsResult).sort((a, b) => a[0].localeCompare(b[0]));
                
                sortedMaterials.forEach(([material, amount]) => {
                    if (amount > 0) { // Only show materials with amount > 0
                       const li = document.createElement('li');
                       li.textContent = `${material}: ${amount}`;
                       resultsList.appendChild(li);
                    }
                });
            } else {
                resultsList.innerHTML = '<li>No base materials required (or item is itself a base material).</li>';
            }
        } catch (error) {
            console.error('Error during calculation:', error);
            resultsList.innerHTML = ''; // Clear loading
            errorMessage.textContent = `Calculation error: ${error.message}`;
        }
    });
}); 