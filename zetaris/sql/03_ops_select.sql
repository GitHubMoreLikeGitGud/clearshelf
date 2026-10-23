-- Verification for 03_ops_create.sql. Counts include the sentinel row.
SELECT d.name, d.status, d.at FROM clearshelf_ops.health LATERAL VIEW explode(data) x AS d;
SELECT COUNT(*) AS n FROM clearshelf_ops.market_allergens LATERAL VIEW explode(data) x AS d WHERE d.market_code <> '__schema__';
SELECT COUNT(*) AS n FROM clearshelf_ops.recall_links LATERAL VIEW explode(data) x AS d WHERE d.link_key <> '__schema__';
SELECT COUNT(*) AS n FROM clearshelf_ops.decisions LATERAL VIEW explode(data) x AS d WHERE d.decision_id <> '__schema__';
SELECT COUNT(*) AS n FROM clearshelf_ops.extractions LATERAL VIEW explode(data) x AS d WHERE d.extracted_key <> '__schema__';
DESCRIBE clearshelf_ops.decisions;

-- Write-back check: after an atomic rewrite of data/ops/health.json, the next query shows the new row.
SELECT d.name, d.status, d.at FROM clearshelf_ops.health LATERAL VIEW explode(data) x AS d WHERE d.name <> '__schema__';
