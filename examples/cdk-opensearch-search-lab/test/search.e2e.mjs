import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiRequest, readManifest } from "../scripts/common.mjs";
const manifest = await readManifest();

test("search, filter, sort, paginate, inspect and edit indexed products", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Thoughtfully indexed." }),
  ).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(6);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("catalog.png"),
    fullPage: true,
  });
  const firstTitle = await page.locator(".product-card h3").first().innerText();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(
    page.getByRole("navigation", { name: "Result pages" }),
  ).toContainText("Page 2");
  await expect(page.locator(".product-card h3").first()).not.toHaveText(
    firstTitle,
  );
  await page.getByRole("button", { name: "wireless", exact: true }).click();
  await expect(page.locator(".results-toolbar")).toContainText("“wireless”");
  await expect(page.locator(".product-card")).toHaveCount(5);
  await page.getByRole("radio", { name: /^Audio/ }).check();
  await page.getByLabel("Maximum price").selectOption("100");
  await page.getByRole("checkbox", { name: "In stock only" }).check();
  await expect(page.locator(".product-card")).toHaveCount(1);
  await expect(page.locator(".product-card")).toContainText(
    "Pebble portable speaker",
  );
  await page.getByRole("button", { name: "View query" }).click();
  await expect(page.getByRole("tabpanel")).toContainText("multi_match");
  await expect(page.getByRole("tabpanel")).toContainText("post_filter");
  await page.getByRole("tab", { name: "Response JSON" }).click();
  await expect(page.getByRole("tabpanel")).toContainText(
    "Pebble portable speaker",
  );
  await page.screenshot({
    path: testInfo.outputPath("query.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByLabel("Sort results").selectOption("price-asc");
  await expect(page.locator(".product-card h3").first()).toHaveText(
    "Grid dotted notebook",
  );
  await page
    .getByRole("textbox", { name: "Search products" })
    .fill("zznothingmatcheszz");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No finds this time." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear search and filters" }).click();
  const unique = `Browser ${randomUUID().replaceAll("-", "")}`;
  let createdId;
  try {
    await page
      .getByRole("button", { name: "Add product", exact: true })
      .click();
    await page.getByLabel("Product name").fill(unique);
    await page
      .getByLabel("Description")
      .fill("A browser-created wireless product.");
    await page.getByLabel("Price (£)").fill("42");
    await page.getByRole("button", { name: "Index product" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("textbox", { name: "Search products" }).fill(unique);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator(".product-card")).toHaveCount(1);
    const result = await apiRequest(
      manifest,
      `/search?q=${encodeURIComponent(unique)}`,
    );
    createdId = result.response.hits.hits[0]._id;
    await page.getByRole("button", { name: unique, exact: true }).click();
    await page.getByLabel("Price (£)").fill("84");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator(".product-card")).toContainText("£84.00");
    await page.getByRole("button", { name: unique, exact: true }).click();
    await page.getByRole("button", { name: "Delete product" }).click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await expect(
      page.getByRole("heading", { name: "No finds this time." }),
    ).toBeVisible();
    createdId = undefined;
  } finally {
    if (createdId)
      await apiRequest(manifest, `/products/${createdId}`, {
        method: "DELETE",
      });
  }
  expect(errors).toEqual([]);
});

test("shows API errors and retries without displaying stale results", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.locator(".product-card")).toHaveCount(6);
  await page.route("**/prod/search?**", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ message: "Test search outage." }),
    }),
  );
  await page.getByRole("button", { name: "travel", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Test search outage.");
  await expect(page.locator(".product-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "View query" })).toBeDisabled();
  await page.unroute("**/prod/search?**");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".product-card").first()).toBeVisible();
});
