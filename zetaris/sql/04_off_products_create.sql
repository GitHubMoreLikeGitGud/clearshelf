-- =============================================================================
-- Source: Open Food Facts live product API, one REST table per SKU
-- (clearshelf_off.off_<gtin13>). Day-0 gate set: three SKUs. The full set is
-- generated from data/manifest/skus.json by the gateway registrar.
-- Licence: ODbL 1.0. Data from Open Food Facts (https://world.openfoodfacts.org/),
-- licensed under the Open Database License (ODbL). Attribution required.
-- Pattern: open_data/rest_apis/sql/rate_limited/03_open_food_facts_live_create.sql
-- in the Zetaris getting-started repository (top-level object, product struct).
-- Etiquette: at least 2.5 s between statements that call OFF (CREATE, CACHE),
-- with an identifying User-Agent from CLEARSHELF_USER_AGENT.
-- Per SKU: CREATE, DESCRIBE (which optional fields exist), CACHE.
-- =============================================================================

-- Frankie's Organic Plant-Based Puffs Vegan Cheddar (FDA H-1328-2026)
CREATE LIGHTNING REST TABLE off_0816929000119 FROM CLEARSHELF_OFF REQUEST(
    endpoint "https://world.openfoodfacts.org/api/v2/product/0816929000119.json?fields=code,product_name,brands,lang,ingredients_text,ingredients_text_en,allergens_tags,traces_tags,labels_tags,countries_tags,last_modified_t",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

DESCRIBE clearshelf_off.off_0816929000119;

CACHE TABLE clearshelf_off.off_0816929000119;

-- Lidl Eridanous Greek style shortbread, coconut variant (FDA H-1275-2026)
CREATE LIGHTNING REST TABLE off_4056489125846 FROM CLEARSHELF_OFF REQUEST(
    endpoint "https://world.openfoodfacts.org/api/v2/product/4056489125846.json?fields=code,product_name,brands,lang,ingredients_text,ingredients_text_en,allergens_tags,traces_tags,labels_tags,countries_tags,last_modified_t",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

DESCRIBE clearshelf_off.off_4056489125846;

CACHE TABLE clearshelf_off.off_4056489125846;

-- Dr. Oetker Extra dark chocolate, UK
CREATE LIGHTNING REST TABLE off_5000254020408 FROM CLEARSHELF_OFF REQUEST(
    endpoint "https://world.openfoodfacts.org/api/v2/product/5000254020408.json?fields=code,product_name,brands,lang,ingredients_text,ingredients_text_en,allergens_tags,traces_tags,labels_tags,countries_tags,last_modified_t",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

DESCRIBE clearshelf_off.off_5000254020408;

CACHE TABLE clearshelf_off.off_5000254020408;
