import { AwsError } from "../errors.js";
import type { RdsDbParameterGroupState } from "../types.js";

export interface RdsParameterDefinition {
  name: string;
  defaultValue: string;
  description: string;
  applyType: "dynamic" | "static";
  dataType: "integer" | "string";
  allowedValues: string;
  modifiable: boolean;
  validate(value: string): boolean;
}

const integerRange = (minimum: number, maximum: number) => (value: string) => /^\d+$/.test(value) && Number(value) >= minimum && Number(value) <= maximum;
const oneOf = (...values: string[]) => (value: string) => values.includes(value);

export const RDS_PARAMETER_DEFINITIONS: readonly RdsParameterDefinition[] = [
  { name: "max_connections", defaultValue: "100", description: "Maximum simultaneous local client connections.", applyType: "dynamic", dataType: "integer", allowedValues: "10-1000", modifiable: true, validate: integerRange(10, 1_000) },
  { name: "wait_timeout", defaultValue: "28800", description: "Idle noninteractive connection timeout in seconds.", applyType: "dynamic", dataType: "integer", allowedValues: "60-28800", modifiable: true, validate: integerRange(60, 28_800) },
  { name: "max_allowed_packet", defaultValue: "16777216", description: "Maximum client packet size in bytes.", applyType: "dynamic", dataType: "integer", allowedValues: "1048576-67108864", modifiable: true, validate: integerRange(1_048_576, 67_108_864) },
  { name: "innodb_flush_log_at_trx_commit", defaultValue: "1", description: "InnoDB transaction-log durability mode.", applyType: "dynamic", dataType: "integer", allowedValues: "0,1,2", modifiable: true, validate: oneOf("0", "1", "2") },
  { name: "collation_server", defaultValue: "utf8mb4_unicode_ci", description: "Default collation for newly created schemas and objects.", applyType: "static", dataType: "string", allowedValues: "utf8mb4_unicode_ci,utf8mb4_general_ci", modifiable: true, validate: oneOf("utf8mb4_unicode_ci", "utf8mb4_general_ci") },
  { name: "character_set_server", defaultValue: "utf8mb4", description: "Provider-owned UTF-8 server character set.", applyType: "static", dataType: "string", allowedValues: "utf8mb4", modifiable: false, validate: oneOf("utf8mb4") },
] as const;

export function parameterDefinition(name: string): RdsParameterDefinition {
  const definition = RDS_PARAMETER_DEFINITIONS.find(candidate => candidate.name === name);
  if (!definition) throw new AwsError("InvalidParameterValue", `Parameter ${name || "(missing)"} is outside the safe RDS development allowlist`);
  return definition;
}

export function validateParameterValue(name: string, value: unknown): { definition: RdsParameterDefinition; value: string } {
  const definition = parameterDefinition(name);
  const normalized = String(value ?? "");
  if (!definition.modifiable) throw new AwsError("InvalidParameterValue", `Parameter ${name} is provider-owned and cannot be modified`);
  if (!definition.validate(normalized)) throw new AwsError("InvalidParameterValue", `Parameter ${name} must match ${definition.allowedValues}`);
  return { definition, value: normalized };
}

export function effectiveParameterValues(group?: RdsDbParameterGroupState): Record<string, string> {
  return Object.fromEntries(RDS_PARAMETER_DEFINITIONS.filter(definition => definition.modifiable).map(definition => [definition.name, group?.parameters[definition.name]?.value ?? definition.defaultValue]));
}
