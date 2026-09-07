import { expect, type Page } from "@playwright/test";

/** Open the app on the mocked backend with a clean UI state. */
export async function openApp(page: Page): Promise<void> {
  await page.goto("/?mock=1");
  await expect(page.getByRole("heading", { name: "Welcome to Osprey" })).toBeVisible();
}

/** Click a saved connection in the sidebar and wait for it to be open. */
export async function connect(page: Page, name: string): Promise<void> {
  const sidebar = page.locator(".sidebar");
  await sidebar.getByText(name, { exact: true }).click();
  await expect(sidebar.locator(".tree-row.conn", { hasText: name }).locator(".status.open")).toBeVisible();
}

/** Open the data tab of a table from the sidebar tree. */
export async function openTable(page: Page, table: string): Promise<void> {
  await page.locator(".sidebar").getByText(table, { exact: true }).click();
  await expect(page.locator(".tab.active")).toContainText(table);
  await expect(page.locator(".grid-head .g-cell").first()).toBeVisible();
}

const PEOPLE_COLUMNS = ["id", "name", "age", "active", "email", "created_at"];

/** Grid body cell by visible row index (0-based) and column name of the mock `people` table. */
export function cell(page: Page, row: number, column: string) {
  return page.locator(".g-row").nth(row).locator(".g-cell").nth(PEOPLE_COLUMNS.indexOf(column));
}
