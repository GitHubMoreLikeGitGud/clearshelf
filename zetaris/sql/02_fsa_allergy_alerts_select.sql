-- Verification for 02_fsa_allergy_alerts_create.sql
-- Expect 200 alerts: the same as `curl <endpoint> | jq '.items|length'`.
SELECT COUNT(*) AS n FROM clearshelf_fsa.allergy_alerts LATERAL VIEW explode(items) x AS a;

-- Double explode: one row per alert and allergen. Expect the jq count of
-- [.items[] | .problem[]? | .allergen[]?] | length (349 on 2026-10-23).
SELECT COUNT(*) AS n FROM clearshelf_fsa.allergy_alerts LATERAL VIEW explode(items) x AS a LATERAL VIEW explode(a.problem) y AS p LATERAL VIEW explode(p.allergen) z AS al;

-- Distinct notation|allergen keys (the fsa_alert_allergen primary key).
SELECT COUNT(DISTINCT concat(a.notation, '|', lower(al.label))) AS n FROM clearshelf_fsa.allergy_alerts LATERAL VIEW explode(items) x AS a LATERAL VIEW explode(a.problem) y AS p LATERAL VIEW explode(p.allergen) z AS al;

-- Created range and the newest alert (FSA-AA-48-2026 on 2026-10-23).
SELECT MIN(a.created) AS first_created, MAX(a.created) AS last_created FROM clearshelf_fsa.allergy_alerts LATERAL VIEW explode(items) x AS a;
SELECT a.notation, a.created, a.title, a.reportingBusiness.commonName AS business, a.alertURL AS alert_url FROM clearshelf_fsa.allergy_alerts LATERAL VIEW explode(items) x AS a WHERE a.notation = 'FSA-AA-48-2026';

-- Schema as inferred by Zetaris.
DESCRIBE clearshelf_fsa.allergy_alerts;

-- === Refresh (gate G2c), run deliberately: each re-fetch is one FSA request ===
-- UNCACHE TABLE clearshelf_fsa.allergy_alerts;
-- CACHE TABLE clearshelf_fsa.allergy_alerts;
