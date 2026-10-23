-- Verification for 11_clearance_usl_activate_create.sql
SHOW NAMESPACES OR TABLES IN lightning.metastore.clearshelf.clearance_usl;

-- Row counts per USL table. The latest full-onboarding counts are in zetaris/README.md
-- (product = one row per manifest SKU; fda_recall 1000, fsa_alert 200, market_allergen 23).
SELECT COUNT(*) AS n FROM lightning.metastore.clearshelf.clearance_usl.market_allergen;
SELECT COUNT(*) AS n FROM lightning.metastore.clearshelf.clearance_usl.product;
SELECT COUNT(*) AS n FROM lightning.metastore.clearshelf.clearance_usl.declared_allergen;
SELECT COUNT(*) AS n FROM lightning.metastore.clearshelf.clearance_usl.extracted_allergen;
SELECT COUNT(*) AS n FROM lightning.metastore.clearshelf.clearance_usl.fda_recall;
SELECT COUNT(*) AS n FROM lightning.metastore.clearshelf.clearance_usl.fsa_alert;
SELECT COUNT(*) AS n FROM lightning.metastore.clearshelf.clearance_usl.fsa_alert_allergen;
SELECT COUNT(*) AS n FROM lightning.metastore.clearshelf.clearance_usl.recall_product_link;
SELECT COUNT(*) AS n FROM lightning.metastore.clearshelf.clearance_usl.decision;

-- Spot checks.
SELECT gtin, product_name, brand, lang, length(ingredients_text) AS ingredients_len, length(ingredients_text_en) AS ingredients_en_len, vegan_claim, last_modified FROM lightning.metastore.clearshelf.clearance_usl.product ORDER BY gtin;
SELECT declared_key, market_code, relation, source_tag FROM lightning.metastore.clearshelf.clearance_usl.declared_allergen ORDER BY declared_key;
SELECT recall_number, report_date, classification, status, firm FROM lightning.metastore.clearshelf.clearance_usl.fda_recall WHERE recall_number IN ('H-1328-2026', 'H-1275-2026', 'H-1274-2026', 'H-0011-2027') ORDER BY recall_number;
-- openFDA food recall numbers also start with F- (7 of the 18 manifest recalls).
SELECT l.recall_number, l.gtin, l.transform, f.report_date, f.classification, f.status FROM lightning.metastore.clearshelf.clearance_usl.recall_product_link l JOIN lightning.metastore.clearshelf.clearance_usl.fda_recall f ON l.recall_number = f.recall_number WHERE l.recall_number LIKE 'F-%' ORDER BY l.recall_number;

-- Encoding check: unmapped OFF tag de:blé arrives as UTF-8 (hex ...C3A9).
SELECT DISTINCT market_code, hex(market_code) AS hx FROM lightning.metastore.clearshelf.clearance_usl.declared_allergen WHERE market_code LIKE '%bl%';

-- market_allergen after the ops file is generated from data/reference/market_allergens.json.
SELECT COUNT(*) AS n, SUM(CASE WHEN citation_url IS NULL OR citation_url = '' THEN 1 ELSE 0 END) AS no_citation, MAX(length(statute)) AS max_statute, MAX(length(edition)) AS max_edition, MAX(length(citation_url)) AS max_url FROM lightning.metastore.clearshelf.clearance_usl.market_allergen;
