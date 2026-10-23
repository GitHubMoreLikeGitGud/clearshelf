-- =============================================================================
-- Source: UK Food Standards Agency allergy alerts (type AA), newest first, 200.
-- Licence: Open Government Licence v3.0. Contains public sector information
-- licensed under the Open Government Licence v3.0.
-- Docs: https://data.food.gov.uk/food-alerts/ui/reference
-- Shape: {meta, items[]}; each item has problem[] and each problem has
-- allergen[] -> double explode (items, then problem, then allergen).
-- List items carry productName only, no GTIN: matching is by name.
-- Etiquette: modest polling; the table is cached right away.
-- =============================================================================

CREATE LIGHTNING REST TABLE allergy_alerts FROM CLEARSHELF_FSA REQUEST(
    endpoint "https://data.food.gov.uk/food-alerts/id?type=AA&_sort=-created&_limit=200",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CACHE TABLE clearshelf_fsa.allergy_alerts;
