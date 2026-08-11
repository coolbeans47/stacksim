import type { InsightsValue } from "./cloudwatch-insights.js";

export const DISCOVERED_FIELD_LIMIT = 200;

function escapedName(name: string): string { return name.startsWith("@") ? `@${name}` : name; }

function firstJsonObject(message: string): unknown {
  for (let start = message.indexOf("{"); start >= 0; start = message.indexOf("{", start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < message.length; index++) {
      const character = message[index];
      if (quoted) { if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') quoted = false; continue; }
      if (character === '"') { quoted = true; continue; } if (character === "{") depth++; else if (character === "}" && --depth === 0) { try { return JSON.parse(message.slice(start, index + 1)); } catch { break; } }
    }
  }
  return undefined;
}

export function discoverLogFields(message: string, logGroupName = "", maximum = DISCOVERED_FIELD_LIMIT): Record<string, Exclude<InsightsValue, symbol>> {
  const fields: Record<string, Exclude<InsightsValue, symbol>> = {};
  const add = (name: string, value: Exclude<InsightsValue, symbol>) => { if (Object.keys(fields).length < maximum && !Object.hasOwn(fields, name)) fields[name] = value; };
  const flatten = (value: unknown, prefix: string) => {
    if (Object.keys(fields).length >= maximum) return;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") { if (prefix) add(prefix, value); return; }
    if (Array.isArray(value)) { for (let index = 0; index < value.length && Object.keys(fields).length < maximum; index++) flatten(value[index], prefix ? `${prefix}.${index}` : String(index)); return; }
    if (value && typeof value === "object") { for (const [raw, child] of Object.entries(value as Record<string, unknown>)) flatten(child, prefix ? `${prefix}.${escapedName(raw)}` : escapedName(raw)); }
  };
  let parsed: unknown; try { parsed = JSON.parse(message); } catch { if (/lambda/i.test(logGroupName)) parsed = firstJsonObject(message); }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.hasOwn(parsed, "Entity")) { const { Entity, ...rest } = parsed as Record<string, unknown>; flatten(Entity, "@entity"); flatten(rest, ""); } else if (parsed !== undefined) flatten(parsed, "");

  const lambda = message.match(/^REPORT RequestId:\s*([^\s]+)\s+Duration:\s*([\d.]+) ms\s+Billed Duration:\s*(\d+) ms\s+Memory Size:\s*(\d+) MB\s+Max Memory Used:\s*(\d+) MB(?:\s+Init Duration:\s*([\d.]+) ms)?(?:\s+XRAY TraceId:\s*([^\s]+))?/);
  if (lambda) { add("@type", "REPORT"); add("@requestId", lambda[1]); add("@duration", Number(lambda[2])); add("@billedDuration", Number(lambda[3])); add("@memorySize", Number(lambda[4]) * 1024 * 1024); add("@maxMemoryUsed", Number(lambda[5]) * 1024 * 1024); if (lambda[6]) add("@initDuration", Number(lambda[6])); }
  if (/lambda/i.test(logGroupName)) { const typed = message.match(/^(START|END) RequestId:\s*([^\s]+)/); if (typed) { add("@type", typed[1]); add("@requestId", typed[2]); } const trace = message.match(/TraceId:\s*([^\s]+)/); const segment = message.match(/SegmentId:\s*([^\s]+)/); if (trace) add("@xrayTraceId", trace[1]); if (segment) add("@xraySegmentId", segment[1]); }

  if (/(?:vpc|flow)/i.test(logGroupName) && !Object.keys(fields).length) {
    const values = message.trim().split(/\s+/); const names = ["version", "accountId", "interfaceId", "srcAddr", "dstAddr", "srcPort", "dstPort", "protocol", "packets", "bytes", "startTime", "endTime", "action", "logStatus"];
    if (values.length >= names.length && /^\d+$/.test(values[0])) names.forEach((name, index) => add(name, /^\d+$/.test(values[index]) ? Number(values[index]) : values[index]));
  }
  if (/(?:route.?53|dns.?quer)/i.test(logGroupName) && !Object.keys(fields).length) {
    const values = message.trim().split(/\s+/); const names = ["version", "queryTimestamp", "hostZoneId", "queryName", "queryType", "responseCode", "protocol", "edgeLocation", "resolverIp", "ednsClientSubnet"];
    if (values.length >= names.length && /^\d+\.\d+$/.test(values[0]) && Number.isFinite(Date.parse(values[1]))) names.forEach((name, index) => add(name, values[index]));
  }
  return fields;
}

export function logFieldType(value: Exclude<InsightsValue, symbol>): string {
  if (value === null) return "NULL";
  if (Array.isArray(value)) return "LIST";
  if (typeof value === "object") return "MAP";
  if (typeof value === "number") return "NUMBER";
  if (typeof value === "boolean") return "BOOLEAN";
  return "STRING";
}
