// The side drawer (a modal dialog) shared by the evidence view and the why trace.
// Entries stack: a citation opened from inside the drawer pushes, Back pops.
// Only functions touch the DOM; importing this module does not.

const stack = [];
let lastFocus = null;
let wired = false;

const $ = (id) => document.getElementById(id);

function wire() {
  if (wired) return;
  wired = true;
  const drawer = $("drawer");
  drawer.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("[data-drawer-close]")) return closeDrawer();
    if (t.closest("[data-drawer-back]")) return popDrawer();
    const jump = t.closest("[data-jump]");
    if (jump) {
      const el = document.getElementById(jump.getAttribute("data-jump"));
      if (el) {
        el.scrollIntoView({ block: "start" });
        el.focus({ preventScroll: true });
      }
      return;
    }
    const copy = t.closest("[data-copy]");
    if (copy) {
      const src = document.getElementById(copy.getAttribute("data-copy"));
      if (src && navigator.clipboard) {
        navigator.clipboard.writeText(src.textContent ?? "").then(
          () => flash(copy, "Copied"),
          () => flash(copy, "Copy failed"),
        );
      }
    }
  });
  $("drawer-scrim").addEventListener("click", () => closeDrawer());
  document.addEventListener("keydown", (e) => {
    if ($("drawer").hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeDrawer();
    } else if (e.key === "Tab") {
      trapTab(e);
    }
  });
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = old;
  }, 1400);
}

function focusables() {
  return [...$("drawer").querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(
    (el) => !el.closest("[hidden]") && el.getClientRects().length,
  );
}

function trapTab(e) {
  const f = focusables();
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  } else if (!$("drawer").contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
  }
}

function paint(focusTarget) {
  const top = stack[stack.length - 1];
  const drawer = $("drawer");
  if (!top) {
    drawer.hidden = true;
    $("drawer-scrim").hidden = true;
    document.body.classList.remove("has-drawer");
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
    return;
  }
  $("drawer-title").textContent = top.title;
  $("drawer-kicker").textContent = top.kicker ?? "";
  $("drawer-body").innerHTML = top.html;
  drawer.querySelector("[data-drawer-back]").hidden = stack.length < 2;
  drawer.hidden = false;
  $("drawer-scrim").hidden = false;
  document.body.classList.add("has-drawer");
  $("drawer-body").scrollTop = 0;
  if (top.after) top.after($("drawer-body"));
  const target = focusTarget ? $("drawer-body").querySelector(focusTarget) : null;
  if (target) {
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  } else {
    $("drawer-body").focus();
  }
}

/** Opens the drawer with one entry, replacing whatever it showed. Returns the entry handle. */
export function openDrawer(entry) {
  wire();
  if ($("drawer").hidden) lastFocus = document.activeElement;
  stack.length = 0;
  stack.push(entry);
  paint(entry.focus);
  return entry;
}

/** Opens an entry on top of the current one (Back returns to it). */
export function pushDrawer(entry) {
  wire();
  if ($("drawer").hidden) return openDrawer(entry);
  stack.push(entry);
  paint(entry.focus);
  return entry;
}

/** Replaces the content of an entry that is still showing (after its data arrived). */
export function updateDrawer(entry, patch) {
  Object.assign(entry, patch);
  if (stack[stack.length - 1] === entry) paint(entry.focus);
}

export function popDrawer() {
  stack.pop();
  paint();
}

export function closeDrawer() {
  stack.length = 0;
  paint();
}

export function drawerIsOpen() {
  return stack.length > 0;
}
