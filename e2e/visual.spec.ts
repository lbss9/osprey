import { expect, test } from "@playwright/test";
import { connect, openApp } from "./helpers";

/**
 * Visual regression: pixel snapshots of the main screens, per platform.
 * Baselines live in e2e/__screenshots__/<platform>/ and are generated with
 * `npm run test:visual -- --update-snapshots`. Fonts differ between OSes, so
 * the "visual" project is opt-in (`npm run test:visual`) and not part of CI.
 */
test.describe("visual", () => {
  test("welcome", async ({ page }) => {
    await openApp(page);
    await expect(page).toHaveScreenshot("welcome.png", { maxDiffPixelRatio: 0.01 });
  });

  test("table grid", async ({ page }) => {
    await openApp(page);
    await connect(page, "Demo Postgres");
    await page.locator(".sidebar").getByText("people", { exact: true }).click();
    await expect(page.locator(".g-row").first()).toBeVisible();
    await expect(page).toHaveScreenshot("table.png", { maxDiffPixelRatio: 0.01 });
  });

  test("query with results", async ({ page }) => {
    await openApp(page);
    await connect(page, "Demo Postgres");
    await page.keyboard.press("Control+t");
    await page.locator(".cm-content").click();
    await page.keyboard.type("SELECT * FROM people LIMIT 20;");
    await page.keyboard.press("Control+Enter");
    await expect(page.locator(".g-row").first()).toBeVisible();
    await expect(page).toHaveScreenshot("query.png", { maxDiffPixelRatio: 0.01 });
  });

  test("settings appearance, light theme", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("Control+,");
    const dialog = page.locator(".dialog");
    await dialog.getByRole("button", { name: "Appearance" }).click();
    await dialog.getByRole("button", { name: "Light" }).click();
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot("settings-light.png", { maxDiffPixelRatio: 0.01 });
  });
});
