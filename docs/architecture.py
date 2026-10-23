"""Draws docs/architecture.svg (standard library only).

    python docs/architecture.py

docs/architecture.png is a 2x render of the SVG.
"""

from __future__ import annotations

from pathlib import Path
from xml.sax.saxutils import escape

W, H = 1480, 990
FONT = "Segoe UI, Helvetica Neue, Arial, sans-serif"
INK, MUTED = "#1F2933", "#52606D"

# stroke, fill, tag colour
ZETARIS = ("#0E7C86", "#E7F4F5", "#0B6670")
METERLESS = ("#6B4FBB", "#F1EDFA", "#5A3FA8")
NVIDIA = ("#76B900", "#F2F8E6", "#4B7700")
CORE = ("#3B5B85", "#EAF0F7", "#2F4A6E")
OFFICER = ("#B26A00", "#FFF4E2", "#8A5200")
SOURCE = ("#8A8F98", "#F5F6F8", "#5F6670")

out: list[str] = []


def text(x, y, s, size=14, weight="normal", fill=INK, anchor="start", style="normal", spacing=0.0):
    ls = f' letter-spacing="{spacing}"' if spacing else ""
    out.append(
        f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" font-style="{style}" '
        f'fill="{fill}" text-anchor="{anchor}"{ls}>{escape(s)}</text>'
    )


def rect(x, y, w, h, stroke, fill, dash=False, r=10, sw=2.0):
    d = ' stroke-dasharray="7 5"' if dash else ""
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')


def box(x, y, w, h, colours, title, lines, tag=None):
    stroke, fill, tagc = colours
    rect(x, y, w, h, stroke, fill)
    ty = y + 30
    if tag:
        text(x + 14, y + 22, tag, size=11, weight="bold", fill=tagc, spacing=1.2)
        ty = y + 45
    text(x + 14, ty, title, size=17, weight="bold")
    for i, line in enumerate(lines):
        strong = line.startswith("!")
        text(x + 14, ty + 23 + 19 * i, line.lstrip("!"), size=14, fill=INK if strong else MUTED,
             weight="bold" if strong else "normal")


def arrow(points, label=None, at=None, both=False, colour="#4A5563", anchor="start", lsize=12.5):
    pts = " ".join(f"{x},{y}" for x, y in points)
    start = ' marker-start="url(#arrow-start)"' if both else ""
    out.append(f'<polyline points="{pts}" fill="none" stroke="{colour}" stroke-width="2"{start} marker-end="url(#arrow)"/>')
    if label and at:
        text(at[0], at[1], label, size=lsize, fill=MUTED, anchor=anchor)


out.append(
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
    f'font-family="{FONT}" role="img" aria-labelledby="t d">'
)
out.append('<title id="t">ClearShelf architecture</title>')
out.append(
    '<desc id="d">Open Food Facts, openFDA and UK FSA are read only through Zetaris Lightning REST tables and the '
    'clearance_usl Unified Semantic Layer. A gateway exposes named SQL templates to the agent server, where a Markovian '
    'investigation loop planned by Nemotron 3 Nano 4B on local Ollama gathers evidence, H-MEM and the World Model keep memory '
    'and history, deterministic verifiers and policy decide, and actions are executed only under a signed contract. Decisions '
    'are written to an ops store that Zetaris federates back, and the officer works in the UI.</desc>'
)
out.append(
    '<defs>'
    '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
    '<path d="M0,0 L10,5 L0,10 z" fill="#4A5563"/></marker>'
    '<marker id="arrow-start" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
    '<path d="M0,0 L10,5 L0,10 z" fill="#4A5563"/></marker>'
    '</defs>'
)
out.append(f'<rect width="{W}" height="{H}" fill="#FFFFFF"/>')

text(30, 46, "ClearShelf: from public data to a signed clearance decision", size=26, weight="bold")
text(30, 74, "One machine: Zetaris in local Docker, the gateway and agent on 127.0.0.1, Nemotron in local Ollama. No cloud model calls.",
     size=15, fill=MUTED)

# Containers first, so arrows and labels sit on top of them
rect(280, 110, 360, 540, ZETARIS[0], "#F6FBFB", dash=True, r=14)
rect(990, 110, 460, 680, "#9AA3AF", "#FAFAFC", dash=True, r=14)

# Public sources
text(30, 150, "PUBLIC SOURCES", size=11, weight="bold", fill=SOURCE[2], spacing=1.2)
box(30, 165, 200, 84, SOURCE, "Open Food Facts", ["product API v2", "ODbL 1.0"])
box(30, 265, 200, 84, SOURCE, "openFDA", ["food recall reports", "public domain (CC0)"])
box(30, 365, 200, 84, SOURCE, "UK FSA", ["food allergy alerts", "Open Government Licence"])
text(30, 478, "Zetaris is the only", size=13, fill=MUTED, style="italic")
text(30, 496, "runtime path to them.", size=13, fill=MUTED, style="italic")

# Zetaris
text(300, 138, "ZETARIS", size=11, weight="bold", fill=ZETARIS[2], spacing=1.2)
text(300, 160, "Lightning 2.4.3.1, local Docker", size=17, weight="bold")
box(300, 175, 320, 110, ZETARIS, "REST tables, cached", ["CLEARSHELF_OFF.off_<gtin13>", "30 catalogue + 10 eval-only products",
                                                         "CLEARSHELF_FDA, CLEARSHELF_FSA"])
box(300, 330, 320, 150, ZETARIS, "clearance_usl",
    ["Unified Semantic Layer, 9 tables:", "products, recalls, alerts, allergens,", "recall links, decisions",
     "!PK/FK + custom DQ rules gate CLEAR"])
box(300, 530, 320, 100, ZETARIS, "Ops REST tables, read live", ["CLEARSHELF_OPS: decisions, recall links,", "extractions, market allergens"])
for y in (207, 307, 407):
    out.append(f'<line x1="230" y1="{y}" x2="256" y2="{y}" stroke="#4A5563" stroke-width="2"/>')
out.append('<line x1="256" y1="207" x2="256" y2="407" stroke="#4A5563" stroke-width="2"/>')
arrow([(256, 230), (300, 230)])
arrow([(460, 285), (460, 330)], "ACTIVATE USL TABLE", (472, 312))
arrow([(460, 530), (460, 480)], "decisions read back", (472, 510))

# Ops store
box(300, 680, 320, 90, CORE, "Ops store", ["data/ops/*.json, atomic writes", "nginx, served as http://clearshelf-ops"])
arrow([(460, 680), (460, 630)])

# Gateway
box(700, 330, 190, 150, CORE, "Zetaris gateway",
    ["FastAPI + JDBC", "named SQL templates", "allowlist, registrar", "every query logged"])
arrow([(620, 405), (700, 405)], "JDBC", (660, 395), both=True, anchor="middle")
arrow([(890, 405), (1010, 405)], "tool call", (940, 395), both=True, anchor="middle")
text(940, 425, "rows + SQL", size=12.5, fill=MUTED, anchor="middle")

# Agent server
text(1010, 138, "AGENT SERVER", size=11, weight="bold", fill="#5F6670", spacing=1.2)
text(1010, 160, "Node 22 + TypeScript, 127.0.0.1:8790", size=17, weight="bold")
box(1010, 175, 205, 120, METERLESS, "H-MEM", ["facts + officer rulings", "conflicts always queued", "ledger, approved dreams"],
    tag="METERLESS")
box(1225, 175, 205, 120, METERLESS, "World Model", ["products, brands, firms,", "notices, allergens", "timeline: what we knew"],
    tag="METERLESS")
box(1010, 330, 420, 150, METERLESS, "Markovian investigation loop",
    ["bounded chunks, carried state of at most 768 tokens", "planner: Nemotron chooses the next tool",
     "NEEDS_TOOL executor runs it through the gateway", "untrusted text wrapped by the Scout guard"],
    tag="METERLESS  +  NVIDIA")
box(1010, 510, 205, 120, NVIDIA, "Nemotron 3 Nano 4B", ["local Ollama, Q4_K_M", "plans, extracts spans", "0 cloud model calls"],
    tag="NVIDIA")
box(1225, 510, 205, 120, CORE, "Verifiers + policy", ["lexicon, jurisdiction,", "GTIN, claim tester", "!rules R0 to R6 decide"],
    tag="DETERMINISTIC")
box(1010, 660, 420, 110, METERLESS, "Signed actions",
    ["HOLD, BLOCK: applied automatically (the safe side)", "!CLEAR, RELEASE: officer-signed, single-use contract"],
    tag="SCOUT INTENT SUBSET, REIMPLEMENTED")
arrow([(1112, 295), (1112, 330)], both=True)
arrow([(1327, 295), (1327, 330)], both=True)
arrow([(1112, 480), (1112, 510)], both=True)
arrow([(1327, 480), (1327, 510)])
arrow([(1327, 630), (1327, 660)])
arrow([(1010, 715), (620, 715)], "decision write-back", (815, 705), anchor="middle")

# Officer
box(1010, 820, 420, 100, OFFICER, "Officer UI",
    ["SKU card, evidence drawer (the SQL is the citation),", "recall watch, memory, “Why was this held?”"],
    tag="OFFICER")
arrow([(1220, 820), (1220, 770)], both=True)
text(1232, 806, "approve with a reason", size=12.5, fill=MUTED)

# Legend
lx, ly = 30, 960
for label, (stroke, fill, _) in [("Zetaris", ZETARIS), ("Meterless", METERLESS), ("NVIDIA", NVIDIA),
                                 ("ClearShelf code, deterministic", CORE), ("Officer", OFFICER), ("Public source", SOURCE)]:
    rect(lx, ly - 13, 16, 16, stroke, fill, r=4)
    text(lx + 24, ly, label, size=13, fill=MUTED)
    lx += 24 + int(len(label) * 5.9) + 34

out.append("</svg>")

if __name__ == "__main__":
    target = Path(__file__).with_name("architecture.svg")
    target.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"wrote {target} ({W}x{H})")
