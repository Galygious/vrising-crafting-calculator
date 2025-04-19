document.addEventListener('DOMContentLoaded', () => {
    const itemSelect = document.getElementById('item-select');
    const quantityInput = document.getElementById('quantity-input');
    const calculateButton = document.getElementById('calculate-button');
    const resultsList = document.getElementById('results-list');
    const errorMessage = document.getElementById('error-message');

    let recipes = {};
    let rawMaterials = new Set();
    let calculationCache = {}; // Cache results for performance

    async function loadData() {
        try {
            const [recipesResponse, rawMaterialsResponse] = await Promise.all([
                fetch('recipes.json'),
                fetch('raw_materials.json')
            ]);

            if (!recipesResponse.ok || !rawMaterialsResponse.ok) {
                throw new Error('Failed to load data files.');
            }

            recipes = await recipesResponse.json();
            const rawMaterialsList = await rawMaterialsResponse.json();
            rawMaterials = new Set(rawMaterialsList);

            populateItemSelect();
            console.log("Data loaded successfully.");
            console.log("Raw Materials:", rawMaterials);
            console.log("Recipes:", recipes);

        } catch (error) {
            errorMessage.textContent = `Error loading data: ${error.message}`;
            console.error("Error loading data:", error);
        }
    }

    function populateItemSelect() {
        // Clear placeholder
        itemSelect.innerHTML = '<option value="">-- Select an Item --</option>';

        // Get item names from recipes and sort them
        const itemNames = Object.keys(recipes).sort();

        itemNames.forEach(itemName => {
            const option = document.createElement('option');
            option.value = itemName;
            option.textContent = itemName;
            itemSelect.appendChild(option);
        });
    }

    function calculateCost(itemName, quantity, path = new Set()) {
        // Basic error/validation
        if (quantity <= 0) return {};
        if (!itemName) return {};

        // Use cache if available
        const cacheKey = `${itemName}-${quantity}`;
        if (calculationCache[cacheKey]) {
            return calculationCache[cacheKey];
        }

        // Circular dependency check
        if (path.has(itemName)) {
            console.warn(`Circular dependency detected for: ${itemName}`);
            throw new Error(`Circular dependency detected: ${[...path, itemName].join(' -> ')}`);
        }

        path.add(itemName); // Add current item to the path

        let totalCost = {};

        // Base Case: Item is a raw material
        if (rawMaterials.has(itemName)) {
            totalCost[itemName] = quantity;
        } 
        // Recursive Case: Item is craftable
        else if (recipes[itemName]) {
            const recipe = recipes[itemName];
            const outputQty = recipe.output_qty || 1;
            const runsNeeded = Math.ceil(quantity / outputQty);

            for (const ingredientName in recipe.inputs) {
                const ingredientQty = recipe.inputs[ingredientName];
                const requiredIngredientTotal = ingredientQty * runsNeeded;
                
                try {
                    const ingredientCost = calculateCost(ingredientName, requiredIngredientTotal, new Set(path)); // Pass a copy of the path
                    
                    // Merge costs
                    for (const rawMaterial in ingredientCost) {
                        totalCost[rawMaterial] = (totalCost[rawMaterial] || 0) + ingredientCost[rawMaterial];
                    }
                } catch (error) {
                    // Propagate the error up
                    path.delete(itemName); // Clean up path before throwing
                    throw error;
                }
            }
        } 
        // Unknown Item Case:
        else {
            console.warn(`Unknown item or missing recipe: ${itemName}`);
            // Option 1: Treat as a raw material (might be desired sometimes)
            // totalCost[itemName] = quantity;
            // Option 2: Throw an error
             path.delete(itemName); // Clean up path before throwing
             throw new Error(`Recipe not found for intermediate item: ${itemName}`);
        }

        path.delete(itemName); // Remove current item from path as we return

        // Cache the result before returning
        calculationCache[cacheKey] = totalCost;
        return totalCost;
    }

    function displayResults(costs) {
        resultsList.innerHTML = ''; // Clear previous results
        errorMessage.textContent = ''; // Clear previous errors

        const sortedCosts = Object.entries(costs).sort((a, b) => a[0].localeCompare(b[0]));

        if (sortedCosts.length === 0) {
            resultsList.innerHTML = '<li>No base materials required or item not found.</li>';
            return;
        }

        sortedCosts.forEach(([material, quantity]) => {
            const li = document.createElement('li');
            // Format quantity nicely (e.g., use integers where possible)
            const displayQuantity = Number.isInteger(quantity) ? quantity : quantity.toFixed(2);
            li.textContent = `${material}: ${displayQuantity}`;
            resultsList.appendChild(li);
        });
    }

    calculateButton.addEventListener('click', () => {
        const selectedItem = itemSelect.value;
        const desiredQuantity = parseInt(quantityInput.value, 10);

        if (!selectedItem) {
            errorMessage.textContent = 'Please select an item.';
            resultsList.innerHTML = '';
            return;
        }

        if (isNaN(desiredQuantity) || desiredQuantity <= 0) {
            errorMessage.textContent = 'Please enter a valid quantity greater than 0.';
            resultsList.innerHTML = '';
            return;
        }
        
        // Clear cache for new calculation
        calculationCache = {};

        try {
            console.log(`Calculating cost for ${desiredQuantity} of ${selectedItem}`);
            const finalCosts = calculateCost(selectedItem, desiredQuantity);
            console.log("Final Costs:", finalCosts);
            displayResults(finalCosts);
        } catch (error) {
            errorMessage.textContent = `Calculation Error: ${error.message}`;
            resultsList.innerHTML = '';
            console.error("Calculation Error:", error);
        }
    });

    // Initial data load
    loadData();
}); 