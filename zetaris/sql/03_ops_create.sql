-- =============================================================================
-- Source: the ClearShelf ops store. nginx (ops/docker-compose.ops.yml) serves
-- data/ops/*.json, written atomically by the agent, as http://clearshelf-ops
-- on the zetaris_default Docker network. Shape {"data":[...]}; every file
-- carries a sentinel row whose key is "__schema__" so schema inference never
-- sees an empty array. Activation queries filter the sentinel out.
-- These tables are NOT cached: each query re-reads the latest file.
-- =============================================================================

CREATE LIGHTNING REST TABLE health FROM CLEARSHELF_OPS REQUEST(
    endpoint "http://clearshelf-ops/health.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER () BODY ();

CREATE LIGHTNING REST TABLE market_allergens FROM CLEARSHELF_OPS REQUEST(
    endpoint "http://clearshelf-ops/market_allergens.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER () BODY ();

CREATE LIGHTNING REST TABLE decisions FROM CLEARSHELF_OPS REQUEST(
    endpoint "http://clearshelf-ops/decisions.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER () BODY ();

CREATE LIGHTNING REST TABLE recall_links FROM CLEARSHELF_OPS REQUEST(
    endpoint "http://clearshelf-ops/recall_links.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER () BODY ();

CREATE LIGHTNING REST TABLE extractions FROM CLEARSHELF_OPS REQUEST(
    endpoint "http://clearshelf-ops/extractions.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER () BODY ();
