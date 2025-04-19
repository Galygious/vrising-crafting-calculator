import json
import re
import time # Import time for delays
import requests
import os # Import os for path operations
from bs4 import BeautifulSoup, Tag, NavigableString
from selenium import webdriver
from selenium.webdriver.chrome.service import Service as ChromeService
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from webdriver_manager.chrome import ChromeDriverManager

def parse_raw_resources(filename="Raw_Resources.html"):
    """Parses Raw_Resources.html to extract a list of raw material names."""
    raw_materials = set()
    try:
        with open(filename, 'r', encoding='utf-8') as f:
            soup = BeautifulSoup(f, 'html.parser')

        table = soup.find('table', class_='fandom-table')
        if not table:
            print(f"Warning: Could not find raw resources table in {filename}")
            return []

        tbody = table.find('tbody')
        if not tbody:
            print(f"Warning: Could not find tbody in raw resources table in {filename}")
            return []

        rows = tbody.find_all('tr')
        for row in rows[1:]: # Skip header row
            cols = row.find_all('td')
            if not cols:
                continue

            # Find the item name, usually in the first <a> tag's title or text
            item_link = cols[0].find('a')
            if item_link:
                item_name = item_link.get('title', item_link.text).strip()
                # Handle edge case like "Plants & Seeds" which links elsewhere
                if "Seeds & Saplings" not in item_name:
                     raw_materials.add(item_name)
            else:
                 # Fallback if no link, maybe just text?
                 item_name_text = cols[0].get_text(strip=True)
                 if item_name_text and "Seeds & Saplings" not in item_name_text: # Also check fallback text
                     raw_materials.add(item_name_text)

    except FileNotFoundError:
        print(f"Error: {filename} not found.")
        return []
    except Exception as e:
        print(f"Error parsing {filename}: {e}")
        return []

    print(f"Found {len(raw_materials)} raw materials from {filename}.")
    return sorted(list(raw_materials))

def parse_ingredients_from_cell(materials_col):
    """Helper function to parse ingredients from a table cell."""
    inputs = {}
    material_links = materials_col.find_all('a')
    
    current_qty = None
    nodes = list(materials_col.children)
    # print(f"DEBUG Materials Col Children: {len(nodes)}")
    for j, node in enumerate(nodes):
        node_str = str(node)
        # print(f"  Node {j}: {node.name} | Text: '{node_str[:50]}...'")
        if isinstance(node, NavigableString):
            node_text = node_str.strip().replace('&nbsp;', '')
            # Handle specific placeholder text like "1 Copper Tier Weapon" or "2 Crude Gem Stones"
            placeholder_match = re.match(r'^(\d+)\s+([a-zA-Z ]+(?:Tier Weapon|Gem Stones?))(?=\s*<br|\s*$)', node_text, re.IGNORECASE)
            if placeholder_match:
                # We capture this as a special input for now, maybe filter later
                placeholder_qty = int(placeholder_match.group(1))
                placeholder_name = placeholder_match.group(2).strip()
                inputs[placeholder_name] = placeholder_qty
                # print(f"    Found placeholder: {placeholder_name} x {placeholder_qty}")
                current_qty = None # Reset qty as this text consumed it
                continue # Move to next node
            
            qty_search = re.match(r'^(\d+)(?:\s*\(\s*\d+\s*\))?', node_text)
            if qty_search:
                current_qty = int(qty_search.group(1))
                # print(f"    Found quantity: {current_qty} from text: '{node_text}'")
        
        item_name = None
        is_item_node = False
        temp_node = None
        if isinstance(node, Tag):
            temp_node = node
        elif j + 1 < len(nodes) and isinstance(nodes[j+1], Tag):
            temp_node = nodes[j+1]

        if temp_node:
            link = None
            if temp_node.name == 'a':
                link = temp_node
            elif temp_node.name == 'span' and temp_node.find('a'):
                link = temp_node.find('a')
            elif temp_node.name == 'span' and temp_node.find('img'): # Handle span > img case
                 img = temp_node.find('img')
                 potential_name = img.get('title', img.get('alt', '')).strip()
                 if potential_name and "border" not in potential_name.lower():
                    item_name = potential_name
                    is_item_node = True
            
            if link:
                 potential_name = link.get('title', link.text).strip()
                 if potential_name:
                    item_name = potential_name
                    is_item_node = True
        
        if item_name and is_item_node:
            qty_to_assign = None
            if current_qty is not None:
                qty_to_assign = current_qty
                current_qty = None 
            else:
                if j + 1 < len(nodes) and isinstance(nodes[j+1], NavigableString):
                    next_node_text = str(nodes[j+1]).strip().replace('&nbsp;', '')
                    qty_search = re.match(r'^(\d+)(?:\s*\(\s*\d+\s*\))?', next_node_text)
                    if qty_search:
                        qty_to_assign = int(qty_search.group(1))
                elif j + 2 < len(nodes) and isinstance(nodes[j+1], Tag) and nodes[j+1].name == 'br' and isinstance(nodes[j+2], NavigableString):
                    next_node_text = str(nodes[j+2]).strip().replace('&nbsp;', '')
                    qty_search = re.match(r'^(\d+)(?:\s*\(\s*\d+\s*\))?', next_node_text)
                    if qty_search:
                        qty_to_assign = int(qty_search.group(1))
            
            if qty_to_assign is not None:
                 inputs[item_name] = qty_to_assign
            elif item_name not in inputs: 
                 # Maybe add with Qty 1 if no other quantity context? For now, skip.
                 pass 

    # Fallbacks (Keep as before)
    if not inputs and material_links:
        list_items = materials_col.find_all('li')
        if list_items:
            for li in list_items:
                link = li.find('a')
                if link:
                    item_name = link.get('title', link.text).strip()
                    if item_name:
                        inputs[item_name] = 1 
        
    if not inputs and material_links: 
        text_content = materials_col.get_text(separator='|', strip=True).replace('&nbsp;', ' ')
        parts = [p.strip() for p in text_content.split('|') if p.strip()]
        current_qty = None
        for part in parts:
            qty_search = re.match(r'^(\d+)\s*(?:\(\s*\d+\s*\))?$', part)
            if qty_search:
                current_qty = int(qty_search.group(1))
            elif current_qty is not None:
                cleaned_name = part.strip()
                found_match = False
                for link in material_links:
                    link_name = link.get('title', link.text).strip()
                    if cleaned_name == link_name:
                        inputs[link_name] = current_qty
                        current_qty = None
                        found_match = True
                        break
                if not found_match:
                     current_qty = None 
            elif len(parts) == 1 and parts[0] in [l.get('title', l.text).strip() for l in material_links]:
                inputs[parts[0]] = 1

    return inputs

def parse_item_recipes_file(filename="Item_Recipes.html"):
    """Parses Item_Recipes.html using its specific table structure."""
    recipes = {}
    print(f"--- Processing file (Standard Table): {filename} ---")
    try:
        with open(filename, 'r', encoding='utf-8') as f:
            soup = BeautifulSoup(f, 'html.parser')

        table = soup.find('table', class_='jquery-tablesorter')
        if not table:
            print(f"Warning: Could not find recipe table (jquery-tablesorter) in {filename}")
            return {}

        tbody = table.find('tbody')
        if not tbody:
             print(f"Warning: Could not find tbody in recipe table in {filename}")
             return {}

        rows = tbody.find_all('tr')
        print(f"Found {len(rows)} rows in standard recipe table.")

        for i, row in enumerate(rows):
            cols = row.find_all('td')
            if len(cols) < 3: # Need at least item, station, materials
                continue

            output_col = cols[0]
            materials_col = cols[-1]

            # --- Output Item(s) ---
            links = output_col.find_all('a')
            spans = output_col.find_all('span', typeof='mw:File/Frameless')

            primary_output_name = None
            output_qty = 1

            qty_match = re.match(r"^\s*(\d+)\s*(&nbsp;|\s)?", output_col.get_text(strip=False))
            if qty_match:
                output_qty = int(qty_match.group(1))
            
            # Find primary name
            if links:
                primary_output_name = links[0].get('title') or links[0].text
            elif spans:
                 first_span_link = spans[0].find('a')
                 if first_span_link:
                     primary_output_name = first_span_link.get('title') or first_span_link.text
            
            if not primary_output_name:
                continue
            primary_output_name = primary_output_name.strip()
            if not primary_output_name: continue

            # --- Input Materials ---
            inputs = parse_ingredients_from_cell(materials_col)

            if not inputs:
                # print(f"DEBUG (Standard): Skipping row {i+1}, could not parse inputs for {primary_output_name}")
                continue

            # Add to recipes dictionary
            if primary_output_name and inputs:
                 if primary_output_name in recipes:
                     # print(f"Warning (Standard): Duplicate recipe for '{primary_output_name}'. Overwriting.")
                     pass
                 recipes[primary_output_name] = {
                     "output_qty": output_qty,
                     "inputs": inputs
                 }
                 # print(f"  Successfully parsed (Standard): {primary_output_name} -> {inputs}")

    except FileNotFoundError:
        print(f"Error: {filename} not found.")
        return {}
    except Exception as e:
        print(f"Error parsing {filename}: {e}")
        import traceback
        traceback.print_exc()
        return {}
    
    print(f"Found {len(recipes)} recipes in {filename}.")
    return recipes

def parse_additional_recipes_file(filename="AdditionalRecipes.html"):
    """Parses AdditionalRecipes.html, focusing on block-style tables (Refined)."""
    recipes = {}
    print(f"--- Processing file (Refined Block): {filename} ---")
    try:
        with open(filename, 'r', encoding='utf-8') as f:
            soup = BeautifulSoup(f, 'html.parser')

        tables = soup.find_all('table', class_='article-table')
        if not tables:
            print(f"Warning: No 'article-table' tables found in {filename}. Falling back to all tables.")
            tables = soup.find_all('table')
            if not tables:
                print("Warning: No tables found at all.")
                return {}

        print(f"Found {len(tables)} potential recipe tables in {filename}. Processing...")
        file_recipes_found = 0

        for table_index, table in enumerate(tables):
            tbody = table.find('tbody')
            if not tbody: continue

            rows = tbody.find_all('tr')
            block_items_row_data = None # Store data like { "row_index": i, "items": [name1, name2,...] }

            # print(f" Processing Table {table_index + 1}")
            for i, row in enumerate(rows):
                th = row.find('th')
                if th and ('Gear Level' in th.get_text() or 'Crafting Costs' in th.get_text()):
                    block_items_row_data = None # Reset when header found
                    continue
                
                cols = row.find_all('td')
                if not cols:
                    continue

                # --- Try to detect item row (multiple items displayed horizontally) ---
                potential_items = []
                potential_item_cells = [col for col in cols if col.find('a') and col.find('img')]
                if len(potential_item_cells) > 1: 
                    for col in potential_item_cells:
                        link = col.find('a')
                        if link:
                           item_name = (link.get('title') or link.text).strip() 
                           if item_name:
                               potential_items.append(item_name)
                    if potential_items:
                        block_items_row_data = {"row_index": i, "items": potential_items}
                        # print(f"   Detected item row {i+1}: {potential_items}")
                        continue # Expect ingredients in the next row(s)

                # --- Try to detect ingredient row (if we are expecting one) ---
                if block_items_row_data and i > block_items_row_data["row_index"]:
                    ingredient_col = None
                    for col in cols:
                        if (col.find('a') or col.find('span', style=lambda v: v and 'position: relative' in v)) and re.search(r'\d', col.get_text()):
                            ingredient_col = col
                            break 
                    
                    if ingredient_col:
                        # print(f"   Detected ingredient row {i+1} for previous item row {block_items_row_data['row_index']+1}")
                        inputs = parse_ingredients_from_cell(ingredient_col)
                        if inputs:
                            # Check if these are base ingredients or placeholders
                            is_base_recipe = True
                            for ingredient in inputs.keys():
                                if "Tier Weapon" in ingredient or "Gem Stones" in ingredient:
                                    is_base_recipe = False
                                    # print(f"    Detected placeholder ingredient '{ingredient}', treating as upgrade recipe (will be filtered).")
                                    break
                                # Add other placeholder checks if needed
                                
                            # Only add recipes if they seem to be base recipes for now
                            if is_base_recipe:
                                for item_name in block_items_row_data["items"]:
                                    if not item_name: continue
                                    if item_name in recipes:
                                        # print(f"Warning (Block Refined): Duplicate recipe for '{item_name}'. Overwriting.")
                                        pass
                                    recipes[item_name] = {
                                        "output_qty": 1, 
                                        "inputs": inputs.copy() # Use copy
                                    }
                                    file_recipes_found += 1
                                    print(f"  Successfully parsed (Block Base): {item_name} -> {inputs}")
                                    
                        # Regardless of finding ingredients, reset expectation after checking this row
                        block_items_row_data = None 
                    else:
                        # If the next row wasn't ingredients, maybe the block ended?
                        block_items_row_data = None
                
                # --- Fallback: Try parsing as simple row --- (Keep this)
                elif len(cols) >= 2: 
                     # ... (Keep the fallback logic from previous version) ...
                     output_col = None
                     materials_col = None
                     if (cols[0].find('a') or cols[0].find('img')) and (cols[-1].find('a') and re.search(r'\d+', cols[-1].get_text())):
                          output_col = cols[0]
                          materials_col = cols[-1]
                     
                     if output_col and materials_col:
                         primary_output_name = None
                         output_qty = 1
                         links = output_col.find_all('a')
                         spans = output_col.find_all('span', typeof='mw:File/Frameless')
                         img = output_col.find('img')

                         qty_match = re.match(r"^\s*(\d+)\s*(&nbsp;|\s)?", output_col.get_text(strip=False))
                         if qty_match: output_qty = int(qty_match.group(1))

                         if links: primary_output_name = links[0].get('title') or links[0].text
                         elif spans and spans[0].find('a'): primary_output_name = spans[0].find('a').get('title') or spans[0].find('a').text
                         elif img: primary_output_name = img.get('title') or img.get('alt')
                         
                         if primary_output_name:
                             primary_output_name = primary_output_name.strip()
                             if primary_output_name:
                                 inputs = parse_ingredients_from_cell(materials_col)
                                 if inputs:
                                     # Check for placeholders in fallback too
                                     is_base_recipe_fb = True
                                     for ingredient in inputs.keys():
                                         if "Tier Weapon" in ingredient or "Gem Stones" in ingredient:
                                             is_base_recipe_fb = False
                                             break
                                     
                                     if is_base_recipe_fb:
                                         if primary_output_name in recipes:
                                             # print(f"Warning (Block Fallback): Duplicate recipe for '{primary_output_name}'. Overwriting.")
                                             pass
                                         recipes[primary_output_name] = {
                                             "output_qty": output_qty,
                                             "inputs": inputs
                                         }
                                         file_recipes_found += 1
                                         print(f"  Successfully parsed (Block Fallback): {primary_output_name} -> {inputs}")

    except FileNotFoundError:
        print(f"Error: {filename} not found.")
        return {}
    except Exception as e:
        print(f"Error processing file {filename}: {e}")
        import traceback
        traceback.print_exc()
        return {}

    print(f"Found {file_recipes_found} recipes in {filename}.")
    return recipes

def get_safe_filename_from_url(url):
    """Extracts a filename from a URL, keeping it relatively simple."""
    if not url:
        return None
    try:
        # Get the last part of the path
        filename = os.path.basename(url.split('?')[0]) # Handle URLs with query parameters
        # Basic sanitization (allow alphanumeric, underscore, hyphen, period)
        filename = re.sub(r'[^a-zA-Z0-9_.-]', '', filename)
        # Prevent excessively long names
        if len(filename) > 100:
             # Take last 100 chars, ensure extension is preserved if possible
             name_part, ext = os.path.splitext(filename)
             filename = name_part[- (100 - len(ext))] + ext

        # Handle empty or dot-only filenames after sanitization
        if not filename or filename == '.':
            return None 
        return filename
    except Exception as e:
        print(f"Warning: Could not extract filename from URL '{url}': {e}")
        return None

def download_image(url, save_path):
    """Downloads an image from a URL and saves it to save_path."""
    if not url or not save_path:
        return False
    try:
        # Ensure directory exists
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'} # Mimic browser
        response = requests.get(url, stream=True, headers=headers, timeout=15) # Use stream=True
        response.raise_for_status() # Raise HTTPError for bad responses (4xx or 5xx)

        with open(save_path, 'wb') as f:
            for chunk in response.iter_content(1024*8): # Download in chunks
                f.write(chunk)
        # print(f"    Successfully downloaded image to: {save_path}")
        return True
    except requests.exceptions.RequestException as e:
        print(f"    Error downloading image {url}: {e}")
        return False
    except IOError as e:
        print(f"    Error saving image to {save_path}: {e}")
        return False
    except Exception as e:
        print(f"    Unexpected error downloading/saving {url}: {e}")
        return False

def scrape_gaming_tools_recipes_selenium(base_url="https://vrising.gaming.tools", index_path="/recipes"):
    """Scrapes recipe data using Selenium, downloading images locally."""
    recipes = {}
    recipe_links = set()
    index_url = base_url + index_path
    print(f"--- Scraping recipe index from: {index_url} using Selenium ---")

    # Define image directory
    image_base_dir = "images"
    item_image_dir = os.path.join(image_base_dir, "items")
    os.makedirs(item_image_dir, exist_ok=True) # Ensure base dir exists

    # Setup WebDriver using webdriver-manager
    options = webdriver.ChromeOptions()
    # options.add_argument("--headless") # Optional: run headless
    options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1920,1080")
    options.add_argument("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36") # Update user agent
    
    driver = None # Initialize driver variable
    try:
        service = ChromeService(ChromeDriverManager().install())
        driver = webdriver.Chrome(service=service, options=options)
        driver.implicitly_wait(5) # Implicit wait for elements

        # 1. Fetch index page and get links
        print(f"Navigating to index page: {index_url}")
        driver.get(index_url)
        wait = WebDriverWait(driver, 20) # Explicit wait (up to 20 seconds)

        # Wait for the recipe grid to be present
        # Use a simpler, potentially more stable selector
        grid_selector = "main > div.grid.grid-cols-1" 
        try:
             wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, grid_selector)))
             print("Recipe grid located.")
             recipe_grid = driver.find_element(By.CSS_SELECTOR, grid_selector)
             links_elements = recipe_grid.find_elements(By.TAG_NAME, 'a')
             count = 0
             for link_element in links_elements:
                 href = link_element.get_attribute('href')
                 if href and href.startswith(base_url + '/recipes/'):
                     # Get the relative path
                     relative_href = href.replace(base_url, '') 
                     if relative_href.count('/') == 2: # Simple check for /recipes/xxx
                         recipe_links.add(relative_href)
                         count += 1
             print(f"Found {len(recipe_links)} unique potential recipe links.")
             if not recipe_links:
                 print("Error: No recipe links found in the grid. Page source snippet:")
                 print(driver.page_source[:1000]) # Print source if links not found
                 return {}
        except TimeoutException:
             print("Error: Timed out waiting for recipe grid to load.")
             print(f"Page title: {driver.title}")
             print(f"Current URL: {driver.current_url}")
             # print(driver.page_source[:2000]) # Debug: print page source
             return {}

        # 2. Loop through each recipe link and scrape the individual page
        parsed_count = 0
        error_count = 0
        total_links = len(recipe_links)
        for link_num, link in enumerate(list(recipe_links)): 
            recipe_url = base_url + link
            # print(f"  Navigating to recipe {link_num + 1}/{total_links}: {recipe_url}")
            
            try:
                driver.get(recipe_url)
                # Wait for the main content elements: Title and at least one table caption
                wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "h1.header-title")))
                wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "table caption"))) 

                # --- Parse Recipe Page using Selenium's finders --- 
                output_item_name = None
                output_qty = 1
                inputs = {}
                image_url = None
                local_image_path = None # Store local path here
                workstation = "Unknown"
                description = ""
                rarity = "common" # Default rarity

                try:
                    output_item_name = driver.find_element(By.CSS_SELECTOR, "h1.header-title").text.strip()
                except NoSuchElementException:
                    print(f"    Warning: Could not find output item name tag for {recipe_url}")
                    error_count += 1
                    continue
                
                # Get output quantity
                try:
                    outputs_caption = driver.find_element(By.XPATH, "//caption[contains(text(), 'Outputs')]")
                    outputs_table = outputs_caption.find_element(By.XPATH, "./parent::table")
                    output_amount_cell = outputs_table.find_element(By.CSS_SELECTOR, "tbody tr td:last-child")
                    output_qty = int(output_amount_cell.text.strip())
                except (NoSuchElementException, ValueError):
                    # print(f"    Info: Could not find/parse output quantity for {output_item_name}, defaulting to 1.")
                    output_qty = 1
                    
                # Get required ingredients
                try:
                    req_caption = driver.find_element(By.XPATH, "//caption[contains(text(), 'Requirements')]")
                    req_table = req_caption.find_element(By.XPATH, "./parent::table")
                    req_rows = req_table.find_elements(By.CSS_SELECTOR, "tbody tr")
                    for row in req_rows:
                        cols = row.find_elements(By.TAG_NAME, 'td')
                        if len(cols) >= 2:
                            try:
                                ingredient_name_element = cols[0].find_element(By.TAG_NAME, 'a')
                                ingredient_name = ingredient_name_element.text.strip()
                                if not ingredient_name: # Fallback using image alt
                                     img = cols[0].find_element(By.TAG_NAME, 'img')
                                     ingredient_name = img.get_attribute('alt').strip()
                                
                                quantity = int(cols[-1].text.strip())
                                if ingredient_name and quantity > 0:
                                    inputs[ingredient_name] = quantity
                            except (NoSuchElementException, ValueError, IndexError):
                                print(f"    Warning: Could not parse an ingredient row for {output_item_name}")
                except NoSuchElementException:
                    # It's okay if requirements table doesn't exist (e.g., base items)
                    # print(f"    Info: No Requirements table found for {output_item_name}.")
                    pass

                # Get image URL
                try:
                    # Find the specific div containing the main image
                    img_container = driver.find_element(By.CSS_SELECTOR, "div.tooltip-body > div.w-\[128px\].h-\[128px\].absolute")
                    img_element = img_container.find_element(By.TAG_NAME, "img")
                    image_url = img_element.get_attribute('src')
                except NoSuchElementException:
                    # print(f"    Warning: Could not find image for {output_item_name}")
                    image_url = None

                # Get workstation
                try:
                    ws_caption = driver.find_element(By.XPATH, "//caption[contains(text(), 'Workstations')]")
                    ws_table = ws_caption.find_element(By.XPATH, "./parent::table")
                    # Assume first workstation listed is the primary one
                    ws_link = ws_table.find_element(By.CSS_SELECTOR, "tbody tr td a") 
                    workstation = ws_link.text.strip()
                except NoSuchElementException:
                    # print(f"    Info: No workstation table found for {output_item_name}.")
                    workstation = "Unknown" # Or maybe "Inventory" / "By Hand"?
                    
                # Get description
                try:
                     desc_element = driver.find_element(By.CSS_SELECTOR, "p.header-desc")
                     description = desc_element.text.strip()
                except NoSuchElementException:
                     description = "" # Optional

                # Get Image URL and Download Image
                try:
                    if image_url:
                        filename = get_safe_filename_from_url(image_url)
                        if filename:
                            # Use the specific item image directory
                            local_image_path = os.path.join(item_image_dir, filename).replace("\\", "/") # Use forward slashes for consistency
                            if not os.path.exists(local_image_path): # Only download if it doesn't exist
                                if download_image(image_url, local_image_path):
                                    pass # Success message is inside download_image
                                else:
                                    local_image_path = None # Download failed
                            else:
                                # print(f"    Image already exists: {local_image_path}")
                                pass
                        else:
                             print(f"    Warning: Could not generate filename for image URL: {image_url}")
                except NoSuchElementException:
                    image_url = None # Keep image_url as None if not found
                
                # Store the enriched recipe data with local image path
                if output_item_name:
                    if output_item_name in recipes:
                        pass
                    recipes[output_item_name] = {
                        "output_qty": output_qty,
                        "inputs": inputs,
                        "local_image_path": local_image_path, # Changed from image_url
                        "workstation": workstation,
                        "description": description,
                        "rarity": rarity
                    }
                    parsed_count += 1
            
            except TimeoutException:
                 print(f"Error: Timed out waiting for elements on recipe page {recipe_url}")
                 error_count += 1
            except Exception as page_e:
                print(f"Error processing recipe page {recipe_url}: {page_e}")
                error_count += 1
            
            if (parsed_count + error_count) % 50 == 0 and (parsed_count + error_count) > 0:
                 print(f"  Processed {parsed_count + error_count} / {total_links} links (Recipes: {parsed_count}, Errors: {error_count})")

    except Exception as main_e:
        print(f"An error occurred during Selenium setup or index page processing: {main_e}")
        import traceback
        traceback.print_exc()
    finally:
        if driver:
            print("Closing WebDriver.")
            driver.quit()

    print(f"--- Scraping finished. Successfully processed {parsed_count} recipes. Encountered {error_count} errors. ---")
    return recipes

if __name__ == "__main__":
    raw_materials_list = parse_raw_resources()

    scraped_recipes = scrape_gaming_tools_recipes_selenium()

    merged_recipes = scraped_recipes 

    print(f"--- Processing complete. Total recipes found: {len(merged_recipes)} --- ")

    if raw_materials_list:
        with open("raw_materials.json", "w", encoding='utf-8') as f:
            json.dump(raw_materials_list, f, indent=4)
        print("Saved raw_materials.json")
    else:
         with open("raw_materials.json", "w", encoding='utf-8') as f:
            json.dump([], f, indent=4)
         print("Saved empty raw_materials.json")

    if merged_recipes:
         cleaned_recipes = {}
         removed_count = 0
         # Cleanup: Remove recipes with empty inputs (optional), keep others
         for name, data in merged_recipes.items():
             # Check if inputs exist and is a dict. Allow empty inputs dict for now.
             if isinstance(data.get('inputs'), dict) and name not in data.get("inputs",{}):
                 cleaned_recipes[name] = data
             # elif isinstance(data.get('inputs'), dict) and not data['inputs']:
                  # print(f"Info: Recipe for '{name}' has no ingredients listed, keeping.") 
                  # cleaned_recipes[name] = data # Keep items with no ingredients
             else:
                 # print(f"Removing potentially invalid/self-referencing recipe: {name}")
                 removed_count += 1

         print(f"Removed {removed_count} invalid or self-referencing recipes during cleanup.")
         with open("recipes.json", "w", encoding='utf-8') as f:
             json.dump(cleaned_recipes, f, indent=4, sort_keys=True)
         print(f"Saved {len(cleaned_recipes)} recipes to recipes.json")
    else: 
         with open("recipes.json", "w", encoding='utf-8') as f:
            json.dump({}, f, indent=4)
         print("Saved empty recipes.json")

    print("Script finished.") 