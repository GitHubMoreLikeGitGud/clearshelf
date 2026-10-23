-- Verification for 14_decision_writeback_create.sql: LIST DQ, write-back parity,
-- current decision, closed-loop recheck, RUN/SHOW DQ and plain-SQL equivalents.

-- Expects 22 rules once pair 14 has run (20 Day-0 + signed_clear + known_status).
LIST DQ USL lightning.metastore.clearshelf.clearance_usl;

-- Write-back parity: ops decisions (minus __schema__) must equal the USL decision count.
SELECT COUNT(*) AS n FROM clearshelf_ops.decisions LATERAL VIEW explode(data) x AS d WHERE d.decision_id <> '__schema__';
SELECT COUNT(*) AS n FROM lightning.metastore.clearshelf.clearance_usl.decision;

-- Current decision per (gtin, market): latest decided_at, with product_name
-- (LEFT JOIN, so a decision on a GTIN that left the catalogue is still listed).
SELECT d.decision_id, d.gtin, d.market, d.status, d.statement, d.decided_at, d.decided_date, d.actor, d.contract_id, p.product_name
FROM lightning.metastore.clearshelf.clearance_usl.decision d
JOIN (
    SELECT gtin, market, MAX(decided_at) AS decided_at
    FROM lightning.metastore.clearshelf.clearance_usl.decision
    GROUP BY gtin, market
) latest ON d.gtin = latest.gtin AND d.market = latest.market AND d.decided_at = latest.decided_at
LEFT JOIN lightning.metastore.clearshelf.clearance_usl.product p ON d.gtin = p.gtin;

-- Closed-loop recheck on the current decision only (>= so a same-day recall is flagged; superseded CLEAR rows are excluded).
SELECT d.gtin, d.market, d.status, d.decided_at, d.decided_date, f.recall_number, f.report_date, f.classification, f.status AS recall_status
FROM lightning.metastore.clearshelf.clearance_usl.decision d
JOIN (
    SELECT gtin, market, MAX(decided_at) AS decided_at
    FROM lightning.metastore.clearshelf.clearance_usl.decision
    GROUP BY gtin, market
) latest ON d.gtin = latest.gtin AND d.market = latest.market AND d.decided_at = latest.decided_at
JOIN lightning.metastore.clearshelf.clearance_usl.recall_product_link l ON d.gtin = l.gtin
JOIN lightning.metastore.clearshelf.clearance_usl.fda_recall f ON l.recall_number = f.recall_number
WHERE d.status IN ('CLEAR','CLEAR_WITH_STATEMENT') AND f.report_date >= d.decided_date;

RUN DQ signed_clear TABLE lightning.metastore.clearshelf.clearance_usl.decision;
RUN DQ known_status TABLE lightning.metastore.clearshelf.clearance_usl.decision;

SHOW DQ INVALID RECORD signed_clear TABLE lightning.metastore.clearshelf.clearance_usl.decision;
SHOW DQ INVALID RECORD known_status TABLE lightning.metastore.clearshelf.clearance_usl.decision;

-- DQ-equivalent plain SQL when DQ does not return within the bounded wait.
SELECT decision_id, gtin, market, status, contract_id FROM lightning.metastore.clearshelf.clearance_usl.decision WHERE NOT (status NOT IN ('CLEAR','CLEAR_WITH_STATEMENT') OR (contract_id IS NOT NULL AND length(trim(contract_id)) > 0));
SELECT decision_id, gtin, market, status, contract_id FROM lightning.metastore.clearshelf.clearance_usl.decision WHERE NOT (status IN ('CLEAR','CLEAR_WITH_STATEMENT','HOLD','BLOCK'));
