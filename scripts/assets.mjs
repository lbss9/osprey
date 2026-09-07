/**
 * Renders docs assets with the same Chromium Playwright uses:
 *   node scripts/assets.mjs icon         -> docs/assets/app-icon.png (1024²), then run `npx tauri icon docs/assets/app-icon.png`
 *   node scripts/assets.mjs screenshots  -> docs/assets/screenshot-{dark,light}.png (needs `npm run dev` on :1430)
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mode = process.argv[2] ?? "screenshots";
const out = (name) => resolve("docs/assets", name);
const browser = await chromium.launch();

if (mode === "icon") {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  const svg = readFileSync(resolve("docs/assets/app-icon.svg"), "utf8");
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg}`);
  await page.screenshot({ path: out("app-icon.png"), omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
  console.log("wrote", out("app-icon.png"));
} else {
  const base = process.env.OSPREY_URL ?? "http://localhost:1430/?mock=1";
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, locale: "en-US", colorScheme: theme });
    await page.goto(base);
    await page.evaluate((th) => localStorage.setItem("osprey-ui", JSON.stringify({ state: { theme: th, sidebarWidth: 250 }, version: 0 })), theme);
    await page.reload();
    await page.locator(".tree-row.conn", { hasText: "Demo Postgres" }).click();
    await page.locator(".sidebar").getByText("people", { exact: true }).click();
    await page.locator(".g-row").first().waitFor();
    await page.locator(".sidebar").getByText("orders", { exact: true }).click();
    await page.keyboard.press("Control+t");
    await page.locator(".cm-content").click();
    const sql = ["SELECT id, name, age, active, email, created_at", "FROM people", "WHERE active", "ORDER BY created_at DESC", "LIMIT 50;"];
    for (const [i, line] of sql.entries()) {
      await page.keyboard.type(line);
      if (i < sql.length - 1) await page.keyboard.press("Enter");
    }
    await page.keyboard.press("Control+Enter");
    await page.locator(".g-row").first().waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: out(`screenshot-${theme}.png`) });
    console.log("wrote", out(`screenshot-${theme}.png`));
    await page.close();
  }
}
await browser.close();
