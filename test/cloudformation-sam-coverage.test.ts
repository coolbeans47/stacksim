import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { SAM_GLOBALS_SECTIONS, SAM_RESOURCE_COVERAGE } from "../src/cloudformation/sam/coverage.js";
import { renderSamCoverageMarkdown } from "../src/cloudformation/sam/coverage-doc.js";
import { SAM_SCHEMA_EVENT_PROPERTIES, SAM_SCHEMA_GLOBALS, SAM_SCHEMA_RESOURCE_PROPERTIES } from "../src/cloudformation/sam/generated/schema.js";

test("the coverage table classifies every resource type, property, event, and Globals section in the pinned SAM schema", () => {
  assert.deepEqual(Object.keys(SAM_RESOURCE_COVERAGE).sort(), Object.keys(SAM_SCHEMA_RESOURCE_PROPERTIES).sort());
  for (const [type, entry] of Object.entries(SAM_RESOURCE_COVERAGE)) {
    // Implemented resource types list every property explicitly.
    if (entry.resource === "implemented") assert.deepEqual(Object.keys(entry.properties ?? {}).sort(), [...SAM_SCHEMA_RESOURCE_PROPERTIES[type]].sort(), type);
    const schemaEvents = SAM_SCHEMA_EVENT_PROPERTIES[type];
    if (schemaEvents) {
      assert.deepEqual(Object.keys(entry.events ?? {}).sort(), Object.keys(schemaEvents).sort(), `${type} events`);
      for (const [eventType, event] of Object.entries(entry.events ?? {})) {
        if (event.event === "implemented") assert.deepEqual(Object.keys(event.properties ?? {}).sort(), [...schemaEvents[eventType]].sort(), `${type} ${eventType}`);
      }
    }
  }
  assert.deepEqual(Object.keys(SAM_GLOBALS_SECTIONS).sort(), Object.keys(SAM_SCHEMA_GLOBALS).sort());
  for (const [section, type] of Object.entries(SAM_GLOBALS_SECTIONS)) {
    const entry = SAM_RESOURCE_COVERAGE[type];
    if (entry.resource === "implemented") for (const key of SAM_SCHEMA_GLOBALS[section]) assert.ok(entry.properties?.[key], `Globals ${section}.${key} has a coverage state`);
  }
});

test("docs/sam-coverage.md is generated from the coverage table", () => {
  const committed = readFileSync(resolve("docs", "sam-coverage.md"), "utf8").replaceAll("\r\n", "\n");
  assert.equal(committed, renderSamCoverageMarkdown(), "run: node --import tsx scripts/generate-sam-coverage-doc.mjs");
});
