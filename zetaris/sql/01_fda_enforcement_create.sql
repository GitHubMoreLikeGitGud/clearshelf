-- =============================================================================
-- Source: openFDA food enforcement reports whose reason mentions "undeclared",
-- newest first, one page of 1,000 (the API maximum per request).
-- Licence: openFDA data is public domain / CC0. No FDA endorsement implied.
-- Docs: https://open.fda.gov/apis/food/enforcement/
-- Shape: {meta, results[]}; results is an array of structs -> explode(results).
-- Etiquette: at most 1,000 requests a day without an API key. A REST table
-- may call the source on every query, so the table is cached right away.
-- The user-agent placeholder is replaced from CLEARSHELF_USER_AGENT at run time.
-- =============================================================================

CREATE LIGHTNING REST TABLE enforcement_undeclared FROM CLEARSHELF_FDA REQUEST(
    endpoint "https://api.fda.gov/food/enforcement.json?search=reason_for_recall:undeclared&sort=report_date:desc&limit=1000",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CACHE TABLE clearshelf_fda.enforcement_undeclared;
