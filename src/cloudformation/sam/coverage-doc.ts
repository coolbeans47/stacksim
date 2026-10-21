import { SAM_GLOBALS_SECTIONS, SAM_RESOURCE_ATTRIBUTE_COVERAGE, SAM_RESOURCE_COVERAGE, type Coverage } from "./coverage.js";
import { SAM_SCHEMA_EVENT_PROPERTIES, SAM_SCHEMA_GLOBALS, SAM_SCHEMA_RESOURCE_PROPERTIES } from "./generated/schema.js";

const label = (coverage: Coverage): string => coverage === "implemented" ? "Implemented" : coverage === "non-goal" ? "Not supported (non-goal)" : `Planned: ${coverage}`;

/** Render docs/sam-coverage.md from the coverage table. */
export function renderSamCoverageMarkdown(): string {
  const lines: string[] = [
    "# AWS SAM coverage",
    "",
    "<!-- Generated from src/cloudformation/sam/coverage.ts by `node --import tsx scripts/generate-sam-coverage-doc.mjs`. Do not edit by hand. -->",
    "",
    "StackSim expands the `AWS::Serverless-2016-10-31` transform itself. Every SAM resource type, property, event type, and Globals key in SAM v1.115.0 is listed here. Anything that is not implemented fails the whole transform with an explicit error naming the phase that will add it, or saying it is not supported; nothing is silently dropped. See [the SAM guide](sam-guide.md) for how to deploy.",
    "",
    "## Resource types",
    "",
    "| Resource type | Status |",
    "|---|---|",
  ];
  for (const type of Object.keys(SAM_SCHEMA_RESOURCE_PROPERTIES)) lines.push(`| \`${type}\` | ${label(SAM_RESOURCE_COVERAGE[type]?.resource ?? "non-goal")} |`);
  lines.push("", "## Resource attributes", "", "| Attribute | Status |", "|---|---|");
  for (const [attribute, coverage] of Object.entries(SAM_RESOURCE_ATTRIBUTE_COVERAGE)) lines.push(`| \`${attribute}\` | ${label(coverage)} |`);
  for (const [type, entry] of Object.entries(SAM_RESOURCE_COVERAGE)) {
    if (entry.resource !== "implemented") continue;
    lines.push("", `## \`${type}\` properties`, "", "| Property | Status | Notes |", "|---|---|---|");
    for (const property of SAM_SCHEMA_RESOURCE_PROPERTIES[type] ?? []) lines.push(`| \`${property}\` | ${label(entry.properties?.[property] ?? entry.resource)} | ${entry.notes?.[property] ?? ""} |`);
    if (!entry.events) continue;
    lines.push("", `### \`${type}\` event types`, "", "| Event type | Status | Properties not yet implemented | Notes |", "|---|---|---|---|");
    for (const eventType of Object.keys(SAM_SCHEMA_EVENT_PROPERTIES[type] ?? {})) {
      const event = entry.events[eventType];
      const implemented = event?.event === "implemented";
      const pending = implemented ? Object.entries(event.properties ?? {}).filter(([, coverage]) => coverage !== "implemented").map(([property, coverage]) => `\`${property}\` (${label(coverage)})`).join(", ") : "";
      const extra = implemented ? Object.entries(event.extraProperties ?? {}) : [];
      const accepted = extra.filter(([, coverage]) => coverage === "implemented").map(([property]) => `\`${property}\``);
      const rejected = extra.filter(([, coverage]) => coverage !== "implemented").map(([property]) => `\`${property}\``);
      const notes = [
        ...(accepted.length ? [`Also implemented: ${accepted.join(", ")}, which SAM accepts although its schema omits them.`] : []),
        ...(rejected.length ? [`SAM's translator also accepts ${rejected.join(", ")}; not supported (non-goal).`] : []),
        ...(event?.note ? [event.note] : []),
      ];
      lines.push(`| \`${eventType}\` | ${label(event?.event ?? "non-goal")} | ${pending} | ${notes.join(" ")} |`);
    }
  }
  lines.push("", "## Globals", "", "A Globals key has the status of the same property on its resource type.", "", "| Section | Status |", "|---|---|");
  for (const section of Object.keys(SAM_SCHEMA_GLOBALS)) lines.push(`| \`${section}\` | ${label(SAM_RESOURCE_COVERAGE[SAM_GLOBALS_SECTIONS[section]]?.resource ?? "non-goal")} |`);
  lines.push("");
  return lines.join("\n");
}
