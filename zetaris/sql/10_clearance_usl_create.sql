-- =============================================================================
-- USL clearance_usl in lightning.metastore.clearshelf: nine tables, keys and
-- foreign keys. The COMPILE USL statement is sent as ONE statement (the
-- runner merges the CREATE TABLE parts back into it). Prerequisite:
-- 00_clearshelf_base_create.sql (namespace). Activation: 11_*; DQ: 12_*.
-- =============================================================================

COMPILE USL IF NOT EXISTS clearance_usl DEPLOY NAMESPACE lightning.metastore.clearshelf DDL
CREATE TABLE market_allergen (
    market_code varchar(40) NOT NULL PRIMARY KEY,
    market varchar(2) NOT NULL,
    allergen varchar(30) NOT NULL,
    display_name varchar(80),
    statute varchar(200),
    edition varchar(80),
    citation_url varchar(300)
);
CREATE TABLE product (
    gtin varchar(14) NOT NULL PRIMARY KEY,
    product_name varchar(300),
    brand varchar(200),
    lang varchar(8),
    ingredients_text varchar(8000),
    ingredients_text_en varchar(8000),
    labels varchar(2000),
    vegan_claim varchar(3),
    last_modified varchar(20),
    source_url varchar(300)
);
CREATE TABLE declared_allergen (
    declared_key varchar(120) NOT NULL PRIMARY KEY,
    gtin varchar(14) NOT NULL FOREIGN KEY REFERENCES product(gtin),
    market_code varchar(40) NOT NULL FOREIGN KEY REFERENCES market_allergen(market_code),
    relation varchar(12) NOT NULL,
    source_tag varchar(60)
);
CREATE TABLE extracted_allergen (
    extracted_key varchar(160) NOT NULL PRIMARY KEY,
    gtin varchar(14) NOT NULL FOREIGN KEY REFERENCES product(gtin),
    market_code varchar(40) NOT NULL FOREIGN KEY REFERENCES market_allergen(market_code),
    relation varchar(16) NOT NULL,
    evidence_text varchar(400),
    verifier varchar(16),
    run_id varchar(40)
);
CREATE TABLE fda_recall (
    recall_number varchar(20) NOT NULL PRIMARY KEY,
    report_date varchar(10) NOT NULL,
    classification varchar(12),
    status varchar(12),
    firm varchar(200),
    distribution varchar(1000),
    product_description varchar(4000),
    reason varchar(2000),
    code_info varchar(2000)
);
CREATE TABLE fsa_alert (
    notation varchar(20) NOT NULL PRIMARY KEY,
    created varchar(10) NOT NULL,
    title varchar(400),
    business varchar(200),
    alert_url varchar(300)
);
CREATE TABLE fsa_alert_allergen (
    alert_allergen_key varchar(80) NOT NULL PRIMARY KEY,
    notation varchar(20) NOT NULL FOREIGN KEY REFERENCES fsa_alert(notation),
    allergen_label varchar(60) NOT NULL
);
CREATE TABLE recall_product_link (
    link_key varchar(60) NOT NULL PRIMARY KEY,
    recall_number varchar(20) NOT NULL FOREIGN KEY REFERENCES fda_recall(recall_number),
    gtin varchar(14) NOT NULL FOREIGN KEY REFERENCES product(gtin),
    raw_code varchar(40),
    transform varchar(30),
    extracted_by varchar(20)
);
CREATE TABLE decision (
    decision_id varchar(60) NOT NULL PRIMARY KEY,
    gtin varchar(14) NOT NULL FOREIGN KEY REFERENCES product(gtin),
    market varchar(2) NOT NULL,
    status varchar(24) NOT NULL,
    statement varchar(1000),
    decided_at varchar(25) NOT NULL,
    decided_date varchar(10) NOT NULL,
    actor varchar(60),
    contract_id varchar(60),
    reason varchar(1000)
);

-- Descriptions: the planner prompt is built from LOAD USL output, so these are the agent's map.
-- Unquoted text: a quoted string is stored with its quotes. No semicolons in the text.
UPDATE USL lightning.metastore.clearshelf.clearance_usl SET DESCRIPTION ClearShelf allergen clearance model - catalogue products from Open Food Facts, openFDA undeclared-allergen recalls, UK FSA allergy alerts, the market allergen reference and the agent ops store. Foreign keys and DQ rules gate CLEAR decisions.;
UPDATE USL lightning.metastore.clearshelf.clearance_usl.market_allergen SET TABLE DESCRIPTION Statutory allergen list per market. market_code is MARKET:allergen, for example UK:milk or US:wheat, with statute, edition and citation URL.;
UPDATE USL lightning.metastore.clearshelf.clearance_usl.product SET TABLE DESCRIPTION One row per catalogue GTIN-13, read from its Open Food Facts REST table. Crowd-sourced label data standing in for the supplier feed.;
UPDATE USL lightning.metastore.clearshelf.clearance_usl.declared_allergen SET TABLE DESCRIPTION Allergens declared by Open Food Facts tags, per product and market. relation is contains or may_contain. Unmapped tags surface as foreign-key DQ orphans.;
UPDATE USL lightning.metastore.clearshelf.clearance_usl.extracted_allergen SET TABLE DESCRIPTION Allergens extracted from ingredient text by the model and checked by the deterministic verifier, written by the agent to the ops store.;
UPDATE USL lightning.metastore.clearshelf.clearance_usl.fda_recall SET TABLE DESCRIPTION openFDA food enforcement reports whose reason mentions undeclared, latest 1000. report_date is yyyy-mm-dd.;
UPDATE USL lightning.metastore.clearshelf.clearance_usl.fsa_alert SET TABLE DESCRIPTION UK FSA allergy alerts, latest 200. Alerts carry no GTIN, so product matching is by name only.;
UPDATE USL lightning.metastore.clearshelf.clearance_usl.fsa_alert_allergen SET TABLE DESCRIPTION One row per FSA allergy alert and allergen label.;
UPDATE USL lightning.metastore.clearshelf.clearance_usl.recall_product_link SET TABLE DESCRIPTION Links an FDA recall to a GTIN found literally in the notice text, with the normalisation transform used. Foreign-key orphans are recalled codes not in the catalogue.;
UPDATE USL lightning.metastore.clearshelf.clearance_usl.decision SET TABLE DESCRIPTION Clearance decisions per GTIN and market, written back by the agent. CLEAR and CLEAR_WITH_STATEMENT need a signed officer approval, HOLD and BLOCK may be automatic.;
UPDATE USL lightning.metastore.clearshelf.clearance_usl.product.gtin SET COLUMN DESCRIPTION GTIN-13 with a valid check digit, zero padded from UPC-A.;
UPDATE USL lightning.metastore.clearshelf.clearance_usl.market_allergen.market_code SET COLUMN DESCRIPTION MARKET:allergen key, for example UK:gluten_cereal or US:wheat.;
UPDATE USL lightning.metastore.clearshelf.clearance_usl.fda_recall.recall_number SET COLUMN DESCRIPTION FDA recall number, for example H-1328-2026.;
UPDATE USL lightning.metastore.clearshelf.clearance_usl.fsa_alert.notation SET COLUMN DESCRIPTION FSA alert id, for example FSA-AA-48-2026.;
UPDATE USL lightning.metastore.clearshelf.clearance_usl.recall_product_link.transform SET COLUMN DESCRIPTION How the raw code became a GTIN-13, for example upc12_pad13 or ean13_exact.;
UPDATE USL lightning.metastore.clearshelf.clearance_usl.decision.status SET COLUMN DESCRIPTION CLEAR, CLEAR_WITH_STATEMENT, HOLD or BLOCK. A signed release is stored as the CLEAR or CLEAR_WITH_STATEMENT row it results in.;
