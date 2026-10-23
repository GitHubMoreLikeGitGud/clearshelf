-- =============================================================================
-- ClearShelf base objects: four Lightning databases, the SchemaStore
-- container and the USL namespace lightning.metastore.clearshelf.
-- Run once. CREATE SCHEMASTORE CONTAINER has no IF NOT EXISTS, so a re-run
-- needs --skip-exists.
-- DESCRIBE BY accepts only letters, digits, spaces and _ . - ,
-- =============================================================================

CREATE LIGHTNING DATABASE CLEARSHELF_OFF DESCRIBE BY "ClearShelf - Open Food Facts product lookups, one REST table per SKU";
CREATE LIGHTNING DATABASE CLEARSHELF_FDA DESCRIBE BY "ClearShelf - openFDA food enforcement reports mentioning undeclared";
CREATE LIGHTNING DATABASE CLEARSHELF_FSA DESCRIBE BY "ClearShelf - UK FSA allergy alerts";
CREATE LIGHTNING DATABASE CLEARSHELF_OPS DESCRIBE BY "ClearShelf - ops store, decisions, links, extractions, reference";
CREATE SCHEMASTORE CONTAINER clearshelf;
CREATE NAMESPACE IF NOT EXISTS lightning.metastore;
CREATE NAMESPACE IF NOT EXISTS lightning.metastore.clearshelf;
