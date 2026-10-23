"""The intake manifest (data/manifest/skus.json) as the gateway reads it.

Onboarding and the cache warm-up select SKUs here, so both always cover the
same OFF tables. Recall links derived from the manifest are validated here too:
openFDA food recall numbers start with H- or F- (7 of the 18 recall-matched
manifest SKUs are F-).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .sqlgen import gtin_check_digit_ok

ROLES = ("demo", "eval_only")
# The demo catalogue: the roles that onboarding activates and the warm-up keeps
# cached. Eval-only SKUs never enter it; the eval runner registers or replays them.
CATALOGUE_ROLES = ("demo",)
RECALL_NUMBER = re.compile(r"^[FH]-\d{4}-\d{4}$")
LINK_SOURCE = "manifest"  # recall_product_link.extracted_by for links measured at curation time


class ManifestError(ValueError):
    pass


@dataclass(frozen=True)
class ManifestSku:
    gtin: str
    role: str
    markets: tuple[str, ...]
    name: str = ""
    recalls: tuple[dict, ...] = field(default_factory=tuple)


def load(path: Path) -> list[ManifestSku]:
    """Every SKU in the manifest, in manifest order. Raises ManifestError on a
    malformed entry (bad GTIN, unknown role or market, duplicate GTIN)."""
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    items = doc.get("skus", []) if isinstance(doc, dict) else doc
    out: list[ManifestSku] = []
    seen: set[str] = set()
    for i in items:
        if not isinstance(i, dict) or "gtin" not in i:
            raise ManifestError(f"manifest entry without a gtin: {str(i)[:80]}")
        g = str(i["gtin"])
        if not gtin_check_digit_ok(g):
            raise ManifestError(f"not a valid GTIN-13: {g!r}")
        if g in seen:
            raise ManifestError(f"duplicate GTIN: {g}")
        seen.add(g)
        role = i.get("role", "demo")
        if role not in ROLES:
            raise ManifestError(f"{g}: unknown role {role!r}")
        markets = tuple(i.get("markets") or ([i["market"]] if i.get("market") else ["UK"]))
        if not markets or any(m not in ("UK", "US") for m in markets):
            raise ManifestError(f"{g}: markets must be UK and/or US: {markets}")
        name = str(i.get("display_name") or "")
        out.append(ManifestSku(g, role, markets, name, tuple(r for r in i.get("recalls") or [] if isinstance(r, dict))))
    return out


def select(skus: list[ManifestSku], roles: tuple[str, ...] = ROLES, gtins: tuple[str, ...] = ()) -> list[ManifestSku]:
    chosen = [s for s in skus if s.role in roles]
    if gtins:
        chosen = [s for s in chosen if s.gtin in gtins]
    return chosen


def recall_links(skus: list[ManifestSku]) -> list[dict]:
    """recall_product_link rows for the manifest's recall-matched SKUs, all
    fields strings (the ops JSON contract). Raises ManifestError on a recall
    number that is neither H- nor F-, or a raw code too long for the column."""
    rows: list[dict] = []
    for s in skus:
        for r in s.recalls:
            number = str(r.get("recall_number", ""))
            if not RECALL_NUMBER.match(number):
                raise ManifestError(f"{s.gtin}: recall number {number!r} is not H-/F-####-####")
            raw = str(r.get("upc_as_published") or "")
            transform = str(r.get("transform") or "")
            if len(raw) > 40 or len(transform) > 30:
                raise ManifestError(f"{s.gtin}: raw code or transform too long for recall_product_link")
            rows.append({"link_key": f"{number}|{s.gtin}", "recall_number": number, "gtin": s.gtin,
                         "raw_code": raw, "transform": transform, "extracted_by": LINK_SOURCE})
    return rows
