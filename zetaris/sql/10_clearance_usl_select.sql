-- Verification and agent queries for clearance_usl (after 11_* activations).
-- The planner prompt is built from this model description.
LOAD USL clearance_usl NAMESPACE lightning.metastore.clearshelf;

-- Join map (measured GTIN crosswalk): links per transform, links that match a
-- catalogue product, and FK orphans (recalled codes we do not list).
SELECT l.transform, COUNT(*) AS links, COUNT(p.gtin) AS in_catalogue
FROM lightning.metastore.clearshelf.clearance_usl.recall_product_link l
LEFT JOIN lightning.metastore.clearshelf.clearance_usl.product p ON l.gtin = p.gtin
GROUP BY l.transform;

-- Catalogue products joined to their FDA recalls through the link table, all inside Zetaris.
SELECT p.gtin, p.product_name, p.vegan_claim, f.recall_number, f.report_date, f.classification, f.status AS recall_status, substr(f.reason, 1, 120) AS reason
FROM lightning.metastore.clearshelf.clearance_usl.product p
JOIN lightning.metastore.clearshelf.clearance_usl.recall_product_link l ON p.gtin = l.gtin
JOIN lightning.metastore.clearshelf.clearance_usl.fda_recall f ON l.recall_number = f.recall_number
ORDER BY p.gtin;

-- Declared allergens per product, with the statutory name for the market (FK orphans drop out of the inner join).
SELECT d.gtin, m.market, m.display_name, d.relation, d.source_tag
FROM lightning.metastore.clearshelf.clearance_usl.declared_allergen d
JOIN lightning.metastore.clearshelf.clearance_usl.market_allergen m ON d.market_code = m.market_code
ORDER BY d.gtin, m.market, d.relation;

-- Closed-loop recheck: cleared decisions with a newer recall for the same GTIN.
SELECT d.gtin, d.market, d.status, d.decided_date, f.recall_number, f.report_date, f.classification, f.status AS recall_status
FROM lightning.metastore.clearshelf.clearance_usl.decision d
JOIN lightning.metastore.clearshelf.clearance_usl.recall_product_link l ON d.gtin = l.gtin
JOIN lightning.metastore.clearshelf.clearance_usl.fda_recall f ON l.recall_number = f.recall_number
WHERE d.status IN ('CLEAR','CLEAR_WITH_STATEMENT') AND f.report_date > d.decided_date;
