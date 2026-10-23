-- Verification for 13_reactivate_probe_create.sql: product is active with the 3 gate SKUs.
SHOW NAMESPACES OR TABLES IN lightning.metastore.clearshelf.clearance_usl;
SELECT gtin, product_name FROM lightning.metastore.clearshelf.clearance_usl.product ORDER BY gtin;
