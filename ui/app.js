// The officer UI shell: hash routing between the four screens, the replay banner, the shared
// evidence drawer and "why" trace, the connection status and the telemetry footer.

import { api, on, onConnection, replayBanner } from "./lib.js";
import { drawerIsOpen } from "./views/drawer.js";
import { openEvidence } from "./views/evidence.js";
import { openWhy } from "./views/why.js";
import { mountFooter } from "./views/telemetry.js";
import * as intake from "./views/intake.js";
import * as card from "./views/card.js";
import * as watch from "./views/watch.js";
import * as memory from "./views/memory.js";
import * as evaluation from "./views/eval.js";

const VIEWS = { intake, sku: card, watch, memory, eval: evaluation };
const TITLES = { intake: "Intake and catalogue", sku: "SKU card", watch: "Recall watch", memory: "Memory and why", eval: "Evaluation" };
const LAST_CARD = "clearshelf.lastCard";

let cleanup = null;

function remember(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* storage can be unavailable; the UI works without it */
  }
}
function recall(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function parseRoute(hash) {
  const m = /^#\/([a-z]+)(?:\/(\d{13})(?:\/(UK|US))?)?\/?$/u.exec(hash ?? "");
  if (!m || !VIEWS[m[1]]) return null;
  return { view: m[1], params: { gtin: m[2] ?? null, market: m[3] ?? (m[2] ? "UK" : null) } };
}

function announce(text) {
  const a = document.getElementById("announcer");
  a.textContent = "";
  setTimeout(() => {
    a.textContent = text;
  }, 30);
}

let bannerText = null;

/**
 * The replay banner stays on screen (it sticks under the top bar, and the drawer repeats it),
 * so no scrolled frame of replayed data can look live. It is rewritten, and announced, only
 * when its text changes.
 */
async function refreshBanner() {
  const r = await api("/api/health");
  const text = r.ok ? (r.data?.watch?.banner ?? null) : null;
  if (text === bannerText) return;
  const was = bannerText;
  bannerText = text;
  document.getElementById("banner").innerHTML = replayBanner(text);
  document.body.classList.toggle("is-replay", !!text);
  const dr = document.getElementById("drawer-replay");
  if (dr) {
    dr.hidden = !text;
    dr.textContent = text ? `${text}: replayed data, not live` : "";
  }
  if (was !== null || text) announce(text ? `${text}. The data shown is a replay.` : "The replay has ended; the watch is live.");
}

function route() {
  if (!location.hash.startsWith("#/")) {
    if (!location.hash) location.replace("#/intake");
    return;
  }
  let r = parseRoute(location.hash);
  if (!r) {
    location.replace("#/intake");
    return;
  }
  if (r.view === "sku" && !r.params.gtin) {
    const last = recall(LAST_CARD);
    const lr = last ? parseRoute(last) : null;
    if (lr?.params.gtin) {
      location.replace(last);
      return;
    }
  }
  if (r.view === "sku" && r.params.gtin) remember(LAST_CARD, `#/sku/${r.params.gtin}/${r.params.market}`);
  cleanup?.();
  const offs = [];
  const ctx = {
    params: r.params,
    on: (type, fn) => {
      const off = on(type, fn);
      offs.push(off);
      return off;
    },
    announce,
    refreshBanner,
    setTitle: (t) => {
      document.title = `${t} | ClearShelf`;
    },
  };
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.tab === r.view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.title = `${TITLES[r.view]} | ClearShelf`;
  const el = document.getElementById("view");
  el.className = `view view--${r.view}`;
  const own = VIEWS[r.view].mount(el, ctx);
  cleanup = () => {
    offs.forEach((f) => f());
    if (typeof own === "function") own();
  };
  window.scrollTo(0, 0);
  refreshBanner();
}

function delegate() {
  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const chip = t.closest(".ev[data-ev]");
    if (chip) {
      e.preventDefault();
      const group = chip.closest(".evs");
      const ids = (group?.getAttribute("data-ids") ?? chip.getAttribute("data-ev")).split(" ").filter(Boolean);
      const inDrawer = !!chip.closest("#drawer");
      openEvidence(chip.getAttribute("data-run") || group?.getAttribute("data-run") || null, ids, { start: chip.getAttribute("data-ev"), push: inDrawer && drawerIsOpen() });
      return;
    }
    const why = t.closest("[data-why]");
    if (why) {
      e.preventDefault();
      const [gtin, market] = why.getAttribute("data-why").split("/");
      openWhy(gtin, market, { push: !!why.closest("#drawer") && drawerIsOpen() });
      return;
    }
    const skip = t.closest("[data-skip]");
    if (skip) {
      e.preventDefault();
      document.getElementById("main").focus();
    }
  });
}

/** The sticky offsets follow the real heights of the top bar and the banner (they wrap on narrow screens). */
function trackHeights() {
  const top = document.querySelector("header.top");
  const banner = document.getElementById("banner");
  const footer = document.getElementById("telemetry");
  const set = () => {
    document.documentElement.style.setProperty("--top-h", `${top.offsetHeight}px`);
    document.documentElement.style.setProperty("--banner-h", `${banner.offsetHeight}px`);
    if (getComputedStyle(footer).position === "fixed" && footer.offsetHeight) document.documentElement.style.setProperty("--footer-h", `${footer.offsetHeight}px`);
  };
  set();
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(set);
    ro.observe(top);
    ro.observe(banner);
    ro.observe(footer);
  } else {
    window.addEventListener("resize", set);
  }
}

function start() {
  trackHeights();
  delegate();
  window.addEventListener("hashchange", route);
  onConnection((s) => {
    const el = document.getElementById("conn");
    el.dataset.state = s;
    el.textContent = s === "live" ? "Live updates on" : s === "reconnecting" ? "Live updates reconnecting" : s === "closed" ? "Live updates off" : "Live updates connecting";
  });
  on("watch.state", refreshBanner);
  on("watch.sweep_done", refreshBanner);
  mountFooter(document.getElementById("telemetry"));
  route();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}
