-- Verification for 12_clearance_dq_create.sql. Run each RUN DQ with a bounded
-- wait (120 s); never relaunch DQ while an earlier run may still be going.
LIST DQ USL lightning.metastore.clearshelf.clearance_usl;

RUN DQ has_ingredients TABLE lightning.metastore.clearshelf.clearance_usl.product;
RUN DQ english_label TABLE lightning.metastore.clearshelf.clearance_usl.product;
RUN DQ market_code TABLE lightning.metastore.clearshelf.clearance_usl.declared_allergen;
RUN DQ known_relation TABLE lightning.metastore.clearshelf.clearance_usl.extracted_allergen;
RUN DQ gtin TABLE lightning.metastore.clearshelf.clearance_usl.recall_product_link;

-- The DQ gate reads these per GTIN.
SHOW DQ INVALID RECORD has_ingredients TABLE lightning.metastore.clearshelf.clearance_usl.product;
SHOW DQ INVALID RECORD english_label TABLE lightning.metastore.clearshelf.clearance_usl.product;
SHOW DQ INVALID RECORD market_code TABLE lightning.metastore.clearshelf.clearance_usl.declared_allergen;
SHOW DQ INVALID RECORD market_code TABLE lightning.metastore.clearshelf.clearance_usl.extracted_allergen;
SHOW DQ INVALID RECORD gtin TABLE lightning.metastore.clearshelf.clearance_usl.recall_product_link;
SHOW DQ ALL INVALID TABLE lightning.metastore.clearshelf.clearance_usl.product;

-- DQ-equivalent plain SQL, used when DQ does not return within the bounded wait.
SELECT gtin FROM lightning.metastore.clearshelf.clearance_usl.product WHERE NOT (ingredients_text IS NOT NULL AND length(trim(ingredients_text)) > 0);
SELECT gtin FROM lightning.metastore.clearshelf.clearance_usl.product WHERE NOT (lang = 'en' OR (ingredients_text_en IS NOT NULL AND length(trim(ingredients_text_en)) > 0));
SELECT d.gtin, d.market_code FROM lightning.metastore.clearshelf.clearance_usl.declared_allergen d LEFT JOIN lightning.metastore.clearshelf.clearance_usl.market_allergen m ON d.market_code = m.market_code WHERE m.market_code IS NULL;
