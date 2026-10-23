// Renders docs/deck/src/ClearShelf.html to docs/deck/ClearShelf.pdf (16:9, 1920x1080 px pages).
// Needs the `playwright` package and its Chromium build (not a dependency of the agent):
//   npm install --no-save playwright && npx playwright install chromium
//   node docs/deck/src/render.cjs [--png <dir>]
// or point NODE_PATH at a node_modules folder that already holds playwright.
// With --png <dir>, it also writes one PNG per slide for checking the layout.
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

(async () => {
  const src = path.join(__dirname, "ClearShelf.html");
  const out = path.join(__dirname, "..", "ClearShelf.pdf");
  const pngIdx = process.argv.indexOf("--png");
  const pngDir = pngIdx > 0 ? process.argv[pngIdx + 1] : null;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto("file:///" + src.replace(/\\/g, "/"), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);

  const overflow = await page.evaluate(() => {
    const issues = [];
    document.querySelectorAll(".slide").forEach((s, i) => {
      const sr = s.getBoundingClientRect();
      s.querySelectorAll("*").forEach((e) => {
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (r.right > sr.right + 0.5 || r.bottom > sr.bottom + 0.5) issues.push(`slide ${i + 1}: <${e.tagName.toLowerCase()} class="${e.className}"> ends at ${Math.round(r.right - sr.left)}x${Math.round(r.bottom - sr.top)}`);
      });
      const body = s.querySelector(".body");
      const foot = s.querySelector(".foot");
      if (body && foot) {
        const fr = foot.getBoundingClientRect();
        body.querySelectorAll("*").forEach((e) => {
          const r = e.getBoundingClientRect();
          if (r.height > 0 && r.bottom > fr.top + 0.5) issues.push(`slide ${i + 1}: <${e.tagName.toLowerCase()} class="${e.className}"> runs into the footer by ${Math.round(r.bottom - fr.top)} px`);
        });
      }
    });
    return issues;
  });
  overflow.forEach((m) => console.log("LAYOUT " + m));

  if (pngDir) {
    fs.mkdirSync(pngDir, { recursive: true });
    const n = await page.locator(".slide").count();
    for (let i = 0; i < n; i++) {
      await page.locator(".slide").nth(i).screenshot({ path: path.join(pngDir, `slide-${String(i + 1).padStart(2, "0")}.png`) });
    }
  }

  await page.emulateMedia({ media: "print" });
  await page.pdf({ path: out, width: "1920px", height: "1080px", printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await browser.close();
  console.log("wrote " + out);
})().catch((e) => { console.error(e); process.exit(1); });
