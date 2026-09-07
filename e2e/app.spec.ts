import { expect, test, type Locator, type Page } from "@playwright/test";
import { cell, connect, openApp, openTable } from "./helpers";

/** Pick an option in an Osprey Dropdown (custom select). */
async function pick(dd: Locator, label: string | RegExp) {
  await dd.locator(".dd-trigger").click();
  await dd.page().locator(".dd-menu .dd-item", { hasText: label }).first().click();
}
const menu = (page: Page) => page.locator(".ctx-menu").first();

test.describe("connections", () => {
  test("welcome screen lists saved connections and creates a new one", async ({ page }) => {
    await openApp(page);
    await expect(page.locator(".sidebar")).toContainText("Demo Postgres");
    await expect(page.locator(".sidebar")).toContainText("Demo Redis");

    await page.locator(".sidebar-head").getByRole("button", { name: /New connection/ }).click();
    const dialog = page.locator(".dialog");
    await expect(dialog.getByRole("heading", { name: "New connection" })).toBeVisible();

    // Redis has no opportunistic TLS: "prefer" disappears and the default is off
    await dialog.getByText("Redis", { exact: true }).click();
    const ssl = dialog.locator(".dd").first();
    await expect(ssl.locator(".dd-value")).toHaveText("Disabled");
    await ssl.locator(".dd-trigger").click();
    await expect(page.locator(".dd-menu .dd-item")).toHaveCount(3);
    await page.keyboard.press("Escape");
    await dialog.getByText("PostgreSQL", { exact: true }).click();
    await expect(ssl.locator(".dd-value")).toContainText("Prefer");

    await dialog.getByPlaceholder("e.g. Production, Local dev…").fill("My PG");
    await dialog.getByRole("button", { name: "Test" }).click();
    await expect(dialog.getByText("Connected to PostgreSQL 16.0 (mock)")).toBeVisible();

    // a wrong password surfaces the translated auth error
    await dialog.locator('input[type="password"]').first().fill("wrong");
    await dialog.getByRole("button", { name: "Test" }).click();
    await expect(dialog.getByText(/Authentication failed/)).toBeVisible();

    await dialog.locator('input[type="password"]').first().fill("ok");
    await dialog.getByRole("button", { name: "Save & connect" }).click();
    await expect(dialog).toBeHidden();
    const sidebar = page.locator(".sidebar");
    await expect(sidebar.locator(".tree-row.conn", { hasText: "My PG" }).locator(".status.open")).toBeVisible();
    await expect(sidebar.getByText("public", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("people", { exact: true })).toBeVisible();
    await expect(page.locator(".toast.success")).toContainText("Connected to My PG");
  });

  test("connection errors are shown in the tree", async ({ page }) => {
    await openApp(page);
    await page.locator(".sidebar-head").getByRole("button", { name: /New connection/ }).click();
    const dialog = page.locator(".dialog");
    await dialog.getByPlaceholder("e.g. Production, Local dev…").fill("Broken");
    await dialog.locator("input.mono").first().fill("bad.host");
    await dialog.getByRole("button", { name: "Save & connect" }).click();
    await expect(page.locator(".sidebar")).toContainText("Could not connect: connection refused");
    await expect(page.locator(".sidebar .tree-row.conn", { hasText: "Broken" }).locator(".status.error")).toBeVisible();
  });

  test("context menu: properties, copy submenu, system objects toggle", async ({ page }) => {
    await openApp(page);
    await connect(page, "Demo Postgres");
    const row = page.locator(".sidebar .tree-row.conn", { hasText: "Demo Postgres" });

    // Properties opens the dialog in edit mode with the saved values
    await row.click({ button: "right" });
    await expect(menu(page)).toContainText("Disconnect");
    await menu(page).getByText("Properties…").click();
    const dialog = page.locator(".dialog");
    await expect(dialog.getByRole("heading", { name: "Connection properties" })).toBeVisible();
    await expect(dialog.getByPlaceholder("e.g. Production, Local dev…")).toHaveValue("Demo Postgres");
    await dialog.getByRole("tab", { name: "Advanced" }).click();
    await expect(dialog.getByText("Connect timeout (seconds)")).toBeVisible();
    await dialog.getByPlaceholder("15").fill("30");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();

    // copy submenu opens on hover
    await row.click({ button: "right" });
    await menu(page).getByText("Copy", { exact: true }).hover();
    await expect(page.locator(".ctx-sub")).toContainText("Copy connection URL");
    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();

    // system objects are hidden until the toggle is on
    const sidebar = page.locator(".sidebar");
    await expect(sidebar.getByText("pg_catalog", { exact: true })).toHaveCount(0);
    await row.click({ button: "right" });
    await menu(page).getByText("Show system databases and schemas").click();
    await expect(sidebar.getByText("pg_catalog", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("information_schema", { exact: true })).toBeVisible();
    // the same toggle lives in Settings, in sync
    await page.keyboard.press("Control+,");
    const switchRow = page.locator(".setting-row", { hasText: "Show system databases and schemas" });
    await expect(switchRow.locator(".toggle")).toHaveClass(/on/);
    await switchRow.locator(".toggle").click();
    await page.keyboard.press("Escape");
    await expect(sidebar.getByText("pg_catalog", { exact: true })).toHaveCount(0);

    // table menu: count rows + copy submenu
    await sidebar.getByText("people", { exact: true }).click({ button: "right" });
    await expect(menu(page)).toContainText("Truncate table…");
    await menu(page).getByText("Count rows").click();
    await expect(page.locator(".toast")).toContainText("people: 240 rows");
  });
});

test.describe("table view", () => {
  test("browses, sorts, filters and pages", async ({ page }) => {
    await openApp(page);
    await connect(page, "Demo Postgres");
    await openTable(page, "people");

    const head = page.locator(".grid-head .g-cell");
    await expect(head.nth(0)).toContainText("id");
    await expect(head.nth(0).locator(".pk")).toBeVisible();
    await expect(cell(page, 0, "name")).toHaveText("Person 1");
    await expect(cell(page, 0, "age").locator(".null")).toHaveText("NULL");
    await expect(page.locator(".statusbar")).toContainText("1–200 of 240");

    // rows start right under the header (regression: a blank strip appeared once)
    const headBox = (await page.locator(".grid-head").boundingBox())!;
    const firstRow = (await page.locator(".g-row").first().boundingBox())!;
    expect(Math.abs(firstRow.y - (headBox.y + headBox.height))).toBeLessThan(2);

    await head.nth(1).click();
    await head.nth(1).click();
    await expect(cell(page, 0, "name")).toHaveText("Person 99");

    await page.locator(".statusbar").getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".statusbar")).toContainText("201–240 of 240");
    await page.locator(".statusbar").getByRole("button", { name: "Previous page" }).click();

    await page.locator(".toolbar").getByRole("button", { name: "Filter" }).click();
    const bar = page.locator(".filterbar");
    await bar.getByRole("button", { name: "Filter" }).click();
    await pick(bar.locator(".f-col"), "name");
    await pick(bar.locator(".f-op"), "contains");
    await bar.getByPlaceholder("Value").fill("12");
    await bar.getByRole("button", { name: "Apply" }).click();
    await expect(page.locator(".statusbar")).toContainText("1–13 of 13");
    await expect(page.locator(".g-row .g-cell:nth-child(3)").first()).toContainText("12");

    await bar.getByRole("button", { name: "Clear filters" }).click();
    await bar.getByRole("button", { name: "Apply" }).click();
    await expect(page.locator(".statusbar")).toContainText("of 240");
    await cell(page, 0, "age").click({ button: "right" });
    await menu(page).getByText("Filter by this value").click();
    await expect(bar.locator(".f-op .dd-value")).toHaveText("is empty (NULL)");
    await expect(page.locator(".statusbar")).toContainText("of 35");
  });

  test("edits cells, previews the SQL and applies in one transaction", async ({ page }) => {
    await openApp(page);
    await connect(page, "Demo Postgres");
    await openTable(page, "people");

    await cell(page, 1, "name").dblclick();
    await page.locator(".cell-editor").fill("Renamed person");
    await page.keyboard.press("Enter");
    await expect(cell(page, 1, "name")).toHaveClass(/modified/);
    await expect(page.locator(".changes-bar")).toContainText("1 pending change");
    await expect(page.locator(".tab.active")).toHaveClass(/dirty/);

    await cell(page, 2, "email").click({ button: "right" });
    await menu(page).getByText("Set NULL").click();
    await page.locator(".toolbar").getByRole("button", { name: "Add row" }).click();
    await expect(page.locator(".changes-bar")).toContainText("3 pending changes");
    await cell(page, 3, "id").click({ button: "right" });
    await menu(page).getByText("Delete row").click();
    await expect(page.locator(".g-row").nth(3)).toHaveClass(/deleted/);
    await expect(page.locator(".changes-bar")).toContainText("4 pending changes");

    await page.locator(".changes-bar").getByRole("button", { name: "Preview SQL" }).click();
    const preview = page.locator(".dialog .sql-preview");
    await expect(preview).toContainText(`UPDATE "public"."people" SET "name" = 'Renamed person' WHERE "id" = 2`);
    await expect(preview).toContainText(`UPDATE "public"."people" SET "email" = NULL WHERE "id" = 3`);
    await expect(preview).toContainText(`INSERT INTO "public"."people" DEFAULT VALUES`);
    await expect(preview).toContainText(`DELETE FROM "public"."people" WHERE "id" = 4`);
    await page.locator(".dialog .dialog-foot").getByRole("button", { name: "Close" }).click();

    await page.keyboard.press("Control+s");
    await expect(page.locator(".dialog")).toContainText("Including 1 DELETE");
    await page.locator(".dialog").getByRole("button", { name: "Apply" }).click();
    await expect(page.locator(".toast.success")).toContainText("4 rows affected");
    await expect(page.locator(".changes-bar")).toBeHidden();
    await expect(cell(page, 1, "name")).toHaveText("Renamed person");
    await expect(cell(page, 2, "email").locator(".null")).toBeVisible();
    await expect(page.locator(".statusbar")).toContainText("of 240");
    await expect(page.locator(".tab.active")).not.toHaveClass(/dirty/);
  });

  test("tables without a primary key are read-only", async ({ page }) => {
    await openApp(page);
    await connect(page, "Demo Postgres");
    await openTable(page, "orders");
    await expect(page.locator(".toolbar").getByRole("button", { name: "Add row" })).toHaveCount(1);
    await page.locator(".tab.active").locator(".t-close").click();
    await openTable(page, "adults");
    await expect(page.locator(".statusbar")).toContainText("no primary key");
    await expect(page.locator(".toolbar").getByRole("button", { name: "Add row" })).toHaveCount(0);
  });

  test("structure tab shows columns, indexes and clickable foreign keys", async ({ page }) => {
    await openApp(page);
    await connect(page, "Demo Postgres");
    await page.locator(".sidebar").getByText("orders", { exact: true }).click({ button: "right" });
    await menu(page).getByText("Structure").click();
    const view = page.locator(".structure");
    await expect(view).toContainText("orders_person_idx");
    await expect(view).toContainText("CASCADE");
    await view.getByRole("button", { name: "public.people" }).click();
    await expect(page.locator(".tab.active")).toContainText("people");
    await expect(page.locator(".grid-head")).toContainText("email");
  });
});

test.describe("structure editor", () => {
  test("adds, edits and drops a column with DDL preview", async ({ page }) => {
    await openApp(page);
    await connect(page, "Demo Postgres");
    await page.locator(".sidebar").getByText("people", { exact: true }).click({ button: "right" });
    await menu(page).getByText("Structure").click();
    const view = page.locator(".structure");
    await expect(view).toContainText("email");

    await page.locator(".toolbar").getByRole("button", { name: "Add column" }).click();
    const dlg = page.locator(".dialog");
    await dlg.getByPlaceholder("Column name").fill("nickname");
    await dlg.getByPlaceholder("Type", { exact: true }).fill("text");
    await dlg.getByRole("button", { name: "Preview SQL" }).click();
    await expect(dlg.locator(".sql-preview")).toContainText('ALTER TABLE "public"."people" ADD COLUMN "nickname" text');
    await dlg.getByRole("button", { name: "Run" }).click();
    await expect(page.locator(".toast.success")).toContainText("Structure updated");
    await expect(view).toContainText("nickname");

    // rename it through the row menu, then drop it
    await view.locator("tr", { hasText: "nickname" }).click({ button: "right" });
    await menu(page).getByText("Edit column").click();
    await dlg.getByPlaceholder("Column name").fill("alias");
    await dlg.getByRole("button", { name: "Preview SQL" }).click();
    await expect(dlg.locator(".sql-preview")).toContainText('RENAME COLUMN "nickname" TO "alias"');
    await dlg.getByRole("button", { name: "Run" }).click();
    await expect(view).toContainText("alias");
    page.once("dialog", (d) => d.accept());
    await view.locator("tr", { hasText: "alias" }).click({ button: "right" });
    await menu(page).getByText("Drop column").click();
    await expect(view).not.toContainText("alias");

    // create table from the schema menu shows the full CREATE TABLE
    await page.locator(".sidebar").getByText("public", { exact: true }).click({ button: "right" });
    await menu(page).getByText("Create table…").click();
    await dlg.locator("input.mono").first().fill("events");
    await dlg.getByPlaceholder("Column name").fill("id");
    await dlg.getByPlaceholder("Type", { exact: true }).fill("integer");
    await dlg.locator(".ddl-flag", { hasText: "PK" }).locator(".toggle").click();
    await dlg.locator(".ddl-flag", { hasText: "auto" }).locator(".toggle").click();
    await dlg.getByRole("button", { name: "Preview SQL" }).click();
    await expect(dlg.locator(".sql-preview")).toContainText('CREATE TABLE "public"."events"');
    await expect(dlg.locator(".sql-preview")).toContainText('"id" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY');
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
  });
});

test.describe("csv import", () => {
  test("previews, maps columns and imports into people", async ({ page }) => {
    await openApp(page);
    await connect(page, "Demo Postgres");
    await page.locator(".sidebar").getByText("people", { exact: true }).click({ button: "right" });
    await menu(page).getByText("Import CSV…").click();
    const dlg = page.locator(".dialog");
    // in the browser the file picker is a prompt
    page.once("dialog", (d) => d.accept("C:/tmp/people.csv"));
    await dlg.getByRole("button", { name: "Browse…" }).click();
    await expect(dlg.locator(".import-map-row")).toHaveCount(3);
    // auto-mapped by name: Name → name, Age → age, Email → email
    await expect(dlg.locator(".import-map-row").nth(0).locator(".dd-value")).toHaveText("name");
    await expect(dlg.locator(".import-map-row").nth(2).locator(".dd-value")).toHaveText("email");
    await expect(dlg.locator(".badge", { hasText: "2 rows" })).toBeVisible();
    await expect(dlg.locator(".g-row")).toHaveCount(2);
    await dlg.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.locator(".toast.success")).toContainText("2 rows imported");
    await expect(dlg).toBeHidden();
    await openTable(page, "people");
    await expect(page.locator(".statusbar")).toContainText("of 242");
  });
});

test.describe("query view", () => {
  test("runs SQL with Ctrl+Enter, shows results, messages and errors", async ({ page }) => {
    await openApp(page);
    await connect(page, "Demo Postgres");
    await page.locator(".tabbar").getByRole("button", { name: /New query/ }).click();
    await expect(page.locator(".tab.active")).toContainText("Query");

    const editor = page.locator(".cm-content");
    await editor.click();
    await page.keyboard.type("SELECT * FROM people LIMIT 5; UPDATE people SET note = 'x'");
    await page.keyboard.press("Control+Enter");
    await expect(page.locator(".g-row").first()).toBeVisible();
    await expect(cell(page, 0, "name")).toHaveText("Person 1");
    await expect(page.locator(".result-tabs")).toContainText("Results");
    await page.locator(".result-tabs").getByRole("tab", { name: "Messages" }).click();
    await expect(page.locator(".messages")).toContainText("3 rows affected");

    await editor.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("SELECT * FROM nope");
    await page.locator(".toolbar").getByRole("button", { name: "Run" }).click();
    await expect(page.locator(".messages .err")).toContainText('Query error: relation "nope" does not exist (position 15)');

    await page.locator(".toolbar").getByRole("button", { name: "History" }).click();
    const hist = page.locator(".side-panel");
    await expect(hist.locator(".hist-item")).toHaveCount(2);
    await expect(hist.locator(".hist-item").first()).toContainText("Error");
    await hist.locator(".hist-item").nth(1).click();
    await expect(editor).toContainText("SELECT * FROM people LIMIT 5");

    // EXPLAIN renders the plan tree with costs
    await editor.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("SELECT * FROM people ORDER BY name");
    await page.locator(".toolbar").getByRole("button", { name: "Explain", exact: true }).click();
    const plan = page.locator(".explain");
    await expect(plan.locator(".plan-row").first()).toContainText("Sort");
    await expect(plan.locator(".plan-row").nth(1)).toContainText("Seq Scan · people");
    await expect(plan.locator(".plan-row").nth(1)).toContainText("(age > 30)");
    await plan.locator(".plan-row").first().click(); // collapse
    await expect(plan.locator(".plan-row")).toHaveCount(1);
    await page.locator(".toolbar").getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.locator(".g-row").first()).toBeVisible();

    // save the query, find it in the Saved tab and in the palette
    await page.keyboard.press("Control+Shift+s");
    const prompt = page.locator(".dialog", { hasText: "Save query" });
    await prompt.getByRole("textbox").fill("Five people");
    await prompt.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".tab.active")).toContainText("Five people");
    await hist.getByRole("tab", { name: "Saved queries" }).click();
    await expect(hist.locator(".hist-item", { hasText: "Five people" })).toBeVisible();
    await hist.locator(".hist-item", { hasText: "Five people" }).click({ button: "right" });
    await menu(page).getByText("Rename").click();
    await page.locator(".dialog", { hasText: "Rename" }).getByRole("textbox").fill("Five folks");
    await page.locator(".dialog", { hasText: "Rename" }).getByRole("button", { name: "Save" }).click();
    await expect(hist.locator(".hist-item", { hasText: "Five folks" })).toBeVisible();
    await page.keyboard.press("Control+k");
    await page.locator(".palette").getByPlaceholder(/Type a table/).fill("folks");
    await expect(page.locator(".palette-item.active")).toContainText("Five folks");
    await page.keyboard.press("Enter");
    await expect(page.locator(".tab.active")).toContainText("Five folks");
  });
});

test.describe("redis", () => {
  test("browses keys as a tree and edits values", async ({ page }) => {
    await openApp(page);
    await connect(page, "Demo Redis");
    await page.locator(".sidebar").getByText("Keys", { exact: true }).click();
    const keys = page.locator(".redis-keys");
    await expect(keys.locator(".key-row.folder", { hasText: "user" })).toContainText("2");
    await keys.locator(".key-row.folder", { hasText: "user" }).click();
    await keys.locator(".key-row.folder", { hasText: /^1\d*$/ }).first().click();
    await keys.locator(".key-row", { hasText: "profile" }).first().click();

    const panel = page.locator(".redis-value");
    await expect(panel.locator(".keyname")).toHaveText("user:1:profile");
    await expect(panel.locator(".badge").first()).toHaveText("hash");
    await expect(panel.locator(".g-row")).toHaveCount(3);
    await expect(panel.locator(".g-row").first()).toContainText("Ana");

    await panel.getByPlaceholder("Field").fill("email");
    await panel.getByPlaceholder("Value").fill("ana@example.com");
    await panel.getByRole("button", { name: "Add field" }).click();
    await expect(panel.locator(".g-row")).toHaveCount(4);
    await panel.locator(".g-row", { hasText: "email" }).locator(".g-cell").nth(1).dblclick();
    await page.locator(".cell-editor").fill("ana@osprey.dev");
    await page.keyboard.press("Enter");
    await expect(panel.locator(".g-row", { hasText: "email" })).toContainText("ana@osprey.dev");
    await panel.locator(".g-row", { hasText: "email" }).locator(".g-cell").first().click({ button: "right" });
    await menu(page).getByText("Delete row").click();
    await expect(panel.locator(".g-row")).toHaveCount(3);

    await keys.locator(".foot").getByRole("button").first().click(); // flat list
    await keys.locator(".key-row", { hasText: "session:abc123" }).click();
    await expect(panel.locator(".badge", { hasText: "expires in" })).toBeVisible();
    await expect(panel.locator("textarea")).toHaveValue("token-xyz");
    await panel.locator("textarea").fill("token-new");
    await panel.getByRole("button", { name: "Save value" }).click();
    await expect(panel.getByRole("button", { name: "Save value" })).toBeDisabled();

    await keys.getByPlaceholder(/Key pattern/).fill("user:*");
    await keys.getByPlaceholder(/Key pattern/).press("Enter");
    await expect(keys.locator(".foot")).toContainText("2 keys loaded");
  });

  test("console runs commands and shows JSON replies", async ({ page }) => {
    await openApp(page);
    await connect(page, "Demo Redis");
    await page.locator(".sidebar").getByText("Console", { exact: true }).click();
    const input = page.getByPlaceholder(/Type a command/);
    await input.fill("HGETALL user:2:profile");
    await input.press("Enter");
    await expect(page.locator(".console .log")).toContainText('"name": "Bob"');
    await input.fill("FLY away");
    await input.press("Enter");
    await expect(page.locator(".console .log .reply.err")).toContainText("unknown command");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("FLY away");
  });

  test("tools: slow log, memory by prefix, pub/sub monitor", async ({ page }) => {
    await openApp(page);
    await connect(page, "Demo Redis");
    await page.locator(".sidebar").getByText("Tools", { exact: true }).click();
    await expect(page.locator(".g-row").first()).toContainText("KEYS *");
    await page.locator(".pill-tabs").getByRole("tab", { name: "Memory" }).click();
    await expect(page.locator(".memory-row").first()).toContainText("user");
    await expect(page.locator(".badge", { hasText: "keys sampled" })).toBeVisible();
    await page.locator(".pill-tabs").getByRole("tab", { name: "Pub/Sub" }).click();
    await page.getByPlaceholder(/channels or patterns/).fill("events:*");
    await page.getByRole("button", { name: "Subscribe" }).click();
    await expect(page.locator(".badge", { hasText: "listening" })).toBeVisible();
    await expect(page.locator(".console .log .cmd").first()).toContainText("events:1");
    await page.getByPlaceholder("channel", { exact: true }).fill("alerts");
    await page.getByPlaceholder("message").fill("hello");
    await page.getByRole("button", { name: "Publish" }).click();
    await expect(page.locator(".console .log")).toContainText("hello");
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.locator(".badge", { hasText: "listening" })).toHaveCount(0);
  });

  test("info dashboard shows server stats", async ({ page }) => {
    await openApp(page);
    await connect(page, "Demo Redis");
    await page.locator(".sidebar").getByText("Server info", { exact: true }).click();
    await expect(page.locator(".stat-cards")).toContainText("7.4.0");
    await expect(page.locator(".stat-cards")).toContainText("90.0%");
  });
});

test.describe("shell", () => {
  test("settings switch theme and language; shortcuts toggle the sidebar", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("Control+,");
    const dialog = page.locator(".dialog");
    await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
    await dialog.getByRole("button", { name: "Appearance" }).click();
    await dialog.getByRole("button", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await dialog.getByRole("button", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await dialog.getByRole("button", { name: "General" }).click();
    await pick(dialog.locator(".setting-row", { hasText: "Language" }).locator(".dd"), "Português");
    await expect(dialog.getByRole("heading", { name: "Configurações" })).toBeVisible();
    await pick(dialog.locator(".setting-row", { hasText: "Idioma" }).locator(".dd"), "English");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await expect(page.locator(".sidebar")).toBeVisible();
    await page.keyboard.press("Control+b");
    await expect(page.locator(".sidebar")).toBeHidden();
    await page.keyboard.press("Control+b");
    await expect(page.locator(".sidebar")).toBeVisible();
  });

  test("command palette opens tables, tabs and actions", async ({ page }) => {
    await openApp(page);
    await connect(page, "Demo Postgres");
    await page.keyboard.press("Control+k");
    const palette = page.locator(".palette");
    await expect(palette).toBeVisible();
    await palette.getByPlaceholder(/Type a table/).fill("peo");
    await expect(palette.locator(".palette-item.active")).toContainText("people");
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    await expect(page.locator(".tab.active")).toContainText("people");

    await page.keyboard.press("Control+p");
    await palette.getByPlaceholder(/Type a table/).fill("theme light");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.keyboard.press("Control+k");
    await palette.getByPlaceholder(/Type a table/).fill("zzzz");
    await expect(palette).toContainText("Nothing matches");
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  test("tabs close with confirmation when dirty", async ({ page }) => {
    await openApp(page);
    await connect(page, "Demo Postgres");
    await openTable(page, "people");
    await cell(page, 0, "name").dblclick();
    await page.locator(".cell-editor").fill("x");
    await page.keyboard.press("Enter");
    page.once("dialog", (d) => d.dismiss());
    await page.locator(".tab.active .t-close").click();
    await expect(page.locator(".tab")).toHaveCount(1);
    page.once("dialog", (d) => d.accept());
    await page.locator(".tab.active .t-close").click();
    await expect(page.locator(".tab")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Welcome to Osprey" })).toBeVisible();
  });
});
