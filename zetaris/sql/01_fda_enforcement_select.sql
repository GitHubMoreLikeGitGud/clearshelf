-- Verification for 01_fda_enforcement_create.sql
-- Expect 1000: the same as `curl <endpoint> | jq '.results|length'`.
SELECT COUNT(*) AS n FROM clearshelf_fda.enforcement_undeclared LATERAL VIEW explode(results) x AS r;

-- Report-date range of the page (openFDA dates are yyyymmdd strings).
SELECT MIN(r.report_date) AS first_report, MAX(r.report_date) AS last_report FROM clearshelf_fda.enforcement_undeclared LATERAL VIEW explode(results) x AS r;

-- Spot check: Frankie's Plant-Based Puffs, UPC 816929000119 (expect H-1328-2026, Class I, Terminated).
SELECT r.recall_number, r.report_date, r.classification, r.status, r.recalling_firm FROM clearshelf_fda.enforcement_undeclared LATERAL VIEW explode(results) x AS r WHERE r.code_info LIKE '%816929000119%' OR r.product_description LIKE '%816929000119%';

-- Schema as inferred by Zetaris.
DESCRIBE clearshelf_fda.enforcement_undeclared;

-- The four recalls named in the spec, and which UPC each description carries.
SELECT r.recall_number, r.report_date, r.classification, r.status, substr(r.code_info,1,120) AS code_info_head, substr(r.product_description,1,80) AS product_head FROM clearshelf_fda.enforcement_undeclared LATERAL VIEW explode(results) x AS r WHERE r.recall_number IN ('H-1328-2026','H-1274-2026','H-1275-2026','H-0011-2027');
SELECT r.recall_number, CASE WHEN r.product_description LIKE '%816929000119%' THEN '816929000119' WHEN r.product_description LIKE '%4056489125846%' THEN '4056489125846' WHEN r.product_description LIKE '%4056489125839%' THEN '4056489125839' WHEN r.product_description LIKE '%850041392103%' THEN '850041392103' ELSE 'not in description' END AS upc_found, CASE WHEN r.product_description LIKE '%coconut%' THEN 'coconut' ELSE '' END AS coconut FROM clearshelf_fda.enforcement_undeclared LATERAL VIEW explode(results) x AS r WHERE r.recall_number IN ('H-1328-2026','H-1274-2026','H-1275-2026','H-0011-2027');

-- === Refresh (gate G2c), run deliberately: each re-fetch is one openFDA request ===
-- UNCACHE TABLE clearshelf_fda.enforcement_undeclared;
-- CACHE TABLE clearshelf_fda.enforcement_undeclared;
-- SHOW CACHE TABLES;   -- returned no rows on 2.4.3.1; read the Spark UI storage API instead
