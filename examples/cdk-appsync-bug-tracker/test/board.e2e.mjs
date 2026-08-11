import { expect, test } from "@playwright/test";

test("board supports refresh, move, create, edit, resolve, reopen, assignment, and delete", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "Triage board" })).toBeVisible();
  await expect(page.getByText("Explicit refresh only")).toBeVisible();
  await expect(page.locator("[data-testid^=bug-card-]")).toHaveCount(12);
  await page.getByRole("button", { name: /Refresh/ }).click();

  await page.getByLabel("Move BUG-104").selectOption("TRIAGE");
  await expect(page.locator(".status-triage").getByTestId("bug-card-BUG-104")).toBeVisible();

  await page.getByRole("button", { name: /New bug/ }).click();
  const dialog = page.getByRole("dialog", { name: "Create a bug" });
  await dialog.getByLabel("Title").fill("E2E accessible control check");
  await dialog.getByLabel("Description").fill("Created through the browser and persisted through AppSync GraphQL.");
  await dialog.getByLabel("Severity").selectOption("HIGH");
  await dialog.getByLabel("Component").fill("Accessibility");
  await dialog.getByLabel("Environment").fill("Local");
  await dialog.getByLabel("Assignee").selectOption("USR-005");
  await dialog.getByRole("button", { name: "Create bug" }).click();
  const created = page.getByText("E2E accessible control check", { exact: true });
  await expect(created).toBeVisible();
  await created.click();

  const detail = page.getByRole("dialog", { name: "Bug detail" });
  await detail.getByLabel("Title").fill("E2E edited control check");
  await detail.getByLabel("Status").selectOption("RESOLVED");
  await detail.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".status-resolved").getByText("E2E edited control check", { exact: true })).toBeVisible();
  await page.getByText("E2E edited control check", { exact: true }).click();
  await detail.getByLabel("Status").selectOption("BACKLOG");
  await detail.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".status-backlog").getByText("E2E edited control check", { exact: true })).toBeVisible();
  await page.getByText("E2E edited control check", { exact: true }).click();
  page.once("dialog", prompt => prompt.accept());
  await detail.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("E2E edited control check", { exact: true })).toHaveCount(0);
});

test("workload and 390px board remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");
  await page.getByRole("button", { name: /Workload/ }).click();
  await expect(page.getByRole("heading", { name: "Team workload" })).toBeVisible();
  await expect(page.locator(".person-card")).toHaveCount(6);
  await page.locator(".person-card").first().click();
  await expect(page.getByRole("heading", { name: "Triage board" })).toBeVisible();
  await expect(page.locator(".board")).toHaveCSS("grid-template-columns", /[0-9.]+px/);
});
