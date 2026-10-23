-- Verification for 04_off_products_create.sql: each OFF table returns exactly 1 row.

SELECT COUNT(*) AS n FROM clearshelf_off.off_0816929000119;
-- No brands field in this record (DESCRIBE): a direct product.brands fails with FIELD_NOT_FOUND.
SELECT code, status, product.product_name AS product_name, CAST(NULL AS STRING) AS brands, product.lang AS lang, size(product.allergens_tags) AS n_allergens, size(product.traces_tags) AS n_traces, product.last_modified_t AS last_modified_t FROM clearshelf_off.off_0816929000119;

SELECT COUNT(*) AS n FROM clearshelf_off.off_4056489125846;
SELECT code, status, product.product_name AS product_name, product.brands AS brands, product.lang AS lang, size(product.allergens_tags) AS n_allergens, size(product.traces_tags) AS n_traces, product.last_modified_t AS last_modified_t FROM clearshelf_off.off_4056489125846;

SELECT COUNT(*) AS n FROM clearshelf_off.off_5000254020408;
SELECT code, status, product.product_name AS product_name, product.brands AS brands, product.lang AS lang, size(product.allergens_tags) AS n_allergens, size(product.traces_tags) AS n_traces, product.last_modified_t AS last_modified_t FROM clearshelf_off.off_5000254020408;

-- Labels on the Puffs record (vegan claims), as read during gate G5.
SELECT code, status, product.product_name AS product_name, CAST(NULL AS STRING) AS brands, product.lang AS lang, size(product.allergens_tags) AS n_allergens, size(product.traces_tags) AS n_traces, product.last_modified_t AS last_modified_t, array_join(product.labels_tags, ',') AS labels FROM clearshelf_off.off_0816929000119;
