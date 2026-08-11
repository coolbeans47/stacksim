import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

test("FND-02 exposes the required reusable console components and one active navigation destination", async () => {
  const components: Record<string, unknown> = await import(pathToFileURL(join(process.cwd(), "web/components.js")).href);
  const required = [
    "appLayout", "pageHeader", "breadcrumbGroup", "sideNavigation", "tabs", "container", "keyValuePairs",
    "collectionTable", "propertyFilter", "pagination", "statusIndicator", "flashbar", "alert", "formField",
    "select", "autosuggest", "codeEditor", "textarea", "modal", "wizard", "splitPanel", "copyButton",
    "confirmationDialog", "loadingSkeleton", "emptyState", "chartPlaceholder",
  ];
  for (const name of required) assert.equal(typeof components[name], "function", `${name} must be reusable`);

  const navigation = (components.sideNavigation as Function)({
    key: "dynamodb", name: "DynamoDB", cls: "db", icon: "D",
    links: [["Overview", "#/dynamodb"], ["Tables", "#/dynamodb/tables"], ["Backups", "#/dynamodb/backups", true]],
  }, "#/dynamodb/tables/LearningNotes", []);
  assert.equal((navigation.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(navigation, /class="side-link active" href="#\/dynamodb\/tables"/);
  assert.doesNotMatch(navigation, /class="side-link active" href="#\/dynamodb"/);

  const breadcrumbs = (components.breadcrumbGroup as Function)(
    "cloudwatch",
    ["CloudWatch", "Log groups", "/stacksim/example", "seed"],
    "#/cloudwatch/log-groups/%2Fstacksim%2Fexample/streams/seed",
  );
  assert.match(breadcrumbs, /^<nav aria-label="Breadcrumbs">/);
  assert.match(breadcrumbs, /href="#\/cloudwatch\/log-groups\/%2Fstacksim%2Fexample"/);
  assert.doesNotMatch(breadcrumbs, /%252F/);

  const pagination = (components.pagination as Function)(false, true);
  assert.match(pagination, /aria-label="Previous page"/);
  assert.match(pagination, /aria-label="Next page"/);

  const tabMarkup = (components.tabs as Function)([
    { label: "Overview", href: "#/example/overview", active: true },
    { label: "Details", href: "#/example/details", active: false },
  ]);
  assert.equal((tabMarkup.match(/tabindex="0"/g) ?? []).length, 1);
  assert.equal((tabMarkup.match(/tabindex="-1"/g) ?? []).length, 1);
});

test("FND-02 navigation guards normalize routes and isolate page and modal dirty state", async () => {
  const router: any = await import(`${pathToFileURL(join(process.cwd(), "web/router.js")).href}?test=${Date.now()}`);
  assert.equal(router.normalizeHash("dynamodb/tables"), "#/dynamodb/tables");
  assert.equal(router.normalizeHash(""), "#/home");
  assert.equal(router.shouldGuardNavigation(true, "#/home", "#/lambda"), true);
  assert.equal(router.shouldGuardNavigation(true, "#/home", "home"), false);

  const previousStorage = (globalThis as any).localStorage;
  (globalThis as any).localStorage = { getItem: () => null, setItem: () => undefined };
  try {
    const state: any = await import(`${pathToFileURL(join(process.cwd(), "web/state.js")).href}?test=${Date.now()}`);
    state.setDirty(true, "page");
    state.setDirty(true, "modal");
    state.setDirty(false, "modal");
    assert.equal(state.session.pageDirty, true);
    assert.equal(state.session.modalDirty, false);
    assert.equal(state.session.dirty, true);
    state.setDirty(false, "all");
    assert.equal(state.session.dirty, false);
  } finally {
    if (previousStorage === undefined) delete (globalThis as any).localStorage;
    else (globalThis as any).localStorage = previousStorage;
  }
});
