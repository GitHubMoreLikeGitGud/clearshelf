-- =============================================================================
-- Custom DQ rules on the USL decision table (ops write-back contract). Same
-- table only, no alias, no window functions. decided_at is an ISO 8601 string
-- with one fixed offset; decided_date and fda_recall.report_date are YYYY-MM-DD,
-- so string comparison orders them. The table is an append-only log: the current
-- decision per (gtin, market) is the row with the latest decided_at.
-- signed_clear: no CLEAR or CLEAR_WITH_STATEMENT without a signed contract_id.
-- A signed RELEASE is not a stored status: the writer stores the CLEAR or
-- CLEAR_WITH_STATEMENT row it results in, with that contract_id, so the
-- recheck sees released products like any other clearance.
-- known_status: only the four decision states (a RELEASE row is invalid).
-- =============================================================================

REGISTER DQ signed_clear TABLE lightning.metastore.clearshelf.clearance_usl.decision AS status NOT IN ('CLEAR','CLEAR_WITH_STATEMENT') OR (contract_id IS NOT NULL AND length(trim(contract_id)) > 0);
REGISTER DQ known_status TABLE lightning.metastore.clearshelf.clearance_usl.decision AS status IN ('CLEAR','CLEAR_WITH_STATEMENT','HOLD','BLOCK');
