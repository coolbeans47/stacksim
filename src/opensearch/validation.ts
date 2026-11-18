import capabilities from "../../docs/opensearch-capabilities.json" with { type: "json" };
import { AwsError } from "../errors.js";
import { policyDocumentValidationError } from "../iam/policy-validation.js";
import { validatePassword } from "./security.js";

export const ENGINE_VERSION = capabilities.engineVersion;
export const INSTANCE_TYPE = capabilities.instanceType;
export function reject(message: string): never { throw new AwsError("ValidationException", message); }
export function object(value: any, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(`${label} must be an object`);
  return value;
}
export function exact(value: Record<string, any>, keys: string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) reject(`${label}.${key} is not supported by the embedded OpenSearch provider`);
}
export function tags(value: any, existing: Record<string, string> = {}, cloudFormation = false): Record<string, string> {
  const result = { ...existing };
  if (!Array.isArray(value)) reject("TagList must be an array");
  const seen = new Set<string>();
  for (const item of value) {
    object(item, "Tag"); exact(item, ["Key", "Value"], "Tag");
    const reservedAllowed = cloudFormation && ["aws:cloudformation:stack-id", "aws:cloudformation:stack-name", "aws:cloudformation:logical-id"].includes(item.Key);
    if (typeof item.Key !== "string" || !item.Key.length || item.Key.length > 128 || item.Key.toLowerCase().startsWith("aws:") && !reservedAllowed || seen.has(item.Key)) reject("Tag keys must be unique, nonempty, at most 128 characters, and must not start with aws:");
    if (typeof item.Value !== "string" || item.Value.length > 256) reject("Tag values must be strings of at most 256 characters");
    seen.add(item.Key); Object.defineProperty(result, item.Key, { value: item.Value, enumerable: true, configurable: true, writable: true });
  }
  if (Object.keys(result).filter(key => !key.toLowerCase().startsWith("aws:")).length > 50) reject("At most 50 user tags are supported");
  return result;
}

export function domainConfiguration(input: Record<string, any>, previous?: Record<string, any>): Record<string, any> {
  exact(input, ["DomainName", "EngineVersion", "ClusterConfig", "EBSOptions", "AccessPolicies", "TagList", "DomainEndpointOptions", "AdvancedOptions", "AdvancedSecurityOptions", "EncryptionAtRestOptions", "NodeToNodeEncryptionOptions", "AutoTuneOptions", "LogPublishingOptions", "VPCOptions", "CognitoOptions", "SnapshotOptions", "OffPeakWindowOptions", "SoftwareUpdateOptions", "IPAddressType", "DryRun", "DryRunMode", "EngineMode", "UseCase"], "Create/UpdateDomain");
  if (!/^[a-z][a-z0-9-]{2,27}$/.test(input.DomainName)) reject("DomainName must be 3–28 lowercase letters, digits or hyphens, starting with a letter");
  if (input.DryRun !== undefined && typeof input.DryRun !== "boolean") reject("DryRun must be boolean");
  const config = structuredClone(previous ?? {
    EngineVersion: ENGINE_VERSION, ClusterConfig: { InstanceType: INSTANCE_TYPE, InstanceCount: 1, DedicatedMasterEnabled: false, ZoneAwarenessEnabled: false, WarmEnabled: false, MultiAZWithStandbyEnabled: false },
    EBSOptions: { EBSEnabled: false }, AccessPolicies: "", AdvancedOptions: { "rest.action.multi.allow_explicit_index": "true" },
    DomainEndpointOptions: { EnforceHTTPS: true, TLSSecurityPolicy: "Policy-Min-TLS-1-2-2019-07", CustomEndpointEnabled: false },
    AdvancedSecurityOptions: { Enabled: false, InternalUserDatabaseEnabled: false }, EncryptionAtRestOptions: { Enabled: false }, NodeToNodeEncryptionOptions: { Enabled: false },
    AutoTuneOptions: { DesiredState: "DISABLED" }, LogPublishingOptions: {}, IPAddressType: "ipv4",
  });
  for (const [key, value] of Object.entries(input)) {
    if (["DomainName", "TagList", "DryRun", "DryRunMode"].includes(key)) continue;
    if (key === "EngineVersion" && value !== ENGINE_VERSION) reject(`Only the ${ENGINE_VERSION} embedded compatibility profile is supported`);
    if (key === "AccessPolicies") {
      if (typeof value !== "string") reject("AccessPolicies must be a JSON string");
      if (value) {
        let policy; try { policy = JSON.parse(value); } catch { reject("AccessPolicies must contain valid JSON"); }
        const invalid = policyDocumentValidationError(policy, "resource"); if (invalid) reject(invalid);
      }
    } else if (key === "ClusterConfig") {
      exact(object(value, key), ["InstanceType", "InstanceCount", "DedicatedMasterEnabled", "ZoneAwarenessEnabled", "WarmEnabled", "MultiAZWithStandbyEnabled"], key);
      for (const [field, option] of Object.entries(value)) if (option !== (field === "InstanceType" ? INSTANCE_TYPE : field === "InstanceCount" ? 1 : false)) reject("The embedded profile supports one local node; AWS instance performance and multi-node topology are unavailable");
    } else if (key === "DomainEndpointOptions") {
      exact(object(value, key), ["EnforceHTTPS", "TLSSecurityPolicy", "CustomEndpointEnabled"], key);
      for (const field of ["EnforceHTTPS", "CustomEndpointEnabled"]) if (value[field] !== undefined && typeof value[field] !== "boolean") reject(`${key}.${field} must be boolean`);
      if (value.TLSSecurityPolicy !== undefined && typeof value.TLSSecurityPolicy !== "string") reject(`${key}.TLSSecurityPolicy must be a string`);
      if (value.CustomEndpointEnabled || value.EnforceHTTPS === false || (value.TLSSecurityPolicy && value.TLSSecurityPolicy !== "Policy-Min-TLS-1-2-2019-07")) reject("The local resource endpoint requires HTTPS with TLS 1.2 or later; custom certificates are unavailable");
    } else if (key === "AdvancedOptions") {
      exact(object(value, key), ["rest.action.multi.allow_explicit_index"], key);
      if (Object.values(value).some(item => item !== "true" && item !== "false")) reject("Advanced option values must be true or false strings");
    } else if (key === "EncryptionAtRestOptions") {
      exact(object(value, key), ["Enabled"], key);
      if (typeof value.Enabled !== "boolean") reject("EncryptionAtRestOptions.Enabled must be boolean");
      if (previous?.EncryptionAtRestOptions.Enabled && !value.Enabled) reject("Storage encryption cannot be disabled");
    } else if (key === "NodeToNodeEncryptionOptions") {
      exact(object(value, key), ["Enabled"], key);
      if (typeof value.Enabled !== "boolean") reject(`${key}.Enabled must be boolean`);
      if (previous?.NodeToNodeEncryptionOptions.Enabled && !value.Enabled) reject("Node-to-node protection cannot be disabled");
    } else if (key === "CognitoOptions") {
      exact(object(value, key), ["Enabled"], key);
      if (value.Enabled !== false) reject(`${key} requires a protection/identity provider that is unavailable locally`);
    } else if (key === "AdvancedSecurityOptions") {
      exact(object(value, key), ["Enabled", "InternalUserDatabaseEnabled", "MasterUserOptions"], key);
      for (const option of ["Enabled", "InternalUserDatabaseEnabled"]) if (value[option] !== undefined && typeof value[option] !== "boolean") reject(`${key}.${option} must be boolean`);
      if (previous?.AdvancedSecurityOptions.Enabled && value.Enabled === false) reject("Fine-grained access control cannot be disabled");
      if (value.MasterUserOptions !== undefined) {
        const master = object(value.MasterUserOptions, "MasterUserOptions"); exact(master, ["MasterUserARN", "MasterUserName", "MasterUserPassword"], "MasterUserOptions");
        if (master.MasterUserARN !== undefined) {
          if (typeof master.MasterUserARN !== "string" || !/^arn:(aws|aws-cn|aws-us-gov):iam::\d{12}:(root|user\/.+|role\/.+)$/.test(master.MasterUserARN) || master.MasterUserName !== undefined || master.MasterUserPassword !== undefined) reject("Specify an IAM master ARN or an internal master username/password");
        } else {
          if (typeof master.MasterUserName !== "string" || !/^[a-zA-Z0-9_.@-]{1,64}$/.test(master.MasterUserName)) reject("MasterUserName requires 1–64 letters, digits, dots, hyphens, underscores or @");
          try { validatePassword(master.MasterUserPassword); } catch (error) { reject((error as Error).message); }
        }
      }
    } else if (key === "EBSOptions") {
      exact(object(value, key), ["EBSEnabled"], key);
      if (value.EBSEnabled !== false) reject("EBS allocation is unavailable; embedded indexes use persistent local storage");
    } else if (key === "AutoTuneOptions") {
      exact(object(value, key), ["DesiredState"], key); if (value.DesiredState !== "DISABLED") reject("Auto-Tune is unavailable");
    } else if (key === "LogPublishingOptions") {
      exact(object(value, key), ["INDEX_SLOW_LOGS", "SEARCH_SLOW_LOGS", "ES_APPLICATION_LOGS", "AUDIT_LOGS"], key);
      for (const [type, raw] of Object.entries(value)) {
        const option = object(raw, `LogPublishingOptions.${type}`); exact(option, ["Enabled", "CloudWatchLogsLogGroupArn"], `LogPublishingOptions.${type}`);
        if (typeof option.Enabled !== "boolean") reject("Log publishing requires an explicit Enabled boolean");
        if (option.Enabled && typeof option.CloudWatchLogsLogGroupArn !== "string" || option.CloudWatchLogsLogGroupArn !== undefined && !/^arn:(aws|aws-cn|aws-us-gov):logs:[a-z0-9-]+:\d{12}:log-group:[.\-_/#A-Za-z0-9]+(?::\*)?$/.test(option.CloudWatchLogsLogGroupArn)) reject("A valid CloudWatch Logs log group ARN is required");
      }
    } else if (key === "VPCOptions") {
      if (Object.keys(object(value, key)).length) reject(`${key} is not implemented`);
    } else if (key === "IPAddressType" && value !== "ipv4") reject("The local gateway uses IPv4 loopback");
    else if (key === "EngineMode" && value !== "GENERAL") reject("Optimized engine mode is unavailable");
    else if (key === "UseCase" && value !== "SEARCH") reject("Only the SEARCH use case is implemented");
    else if (["SnapshotOptions", "OffPeakWindowOptions", "SoftwareUpdateOptions"].includes(key)) reject(`${key} is not implemented`);
    config[key] = value && typeof value === "object" ? { ...config[key], ...structuredClone(value) } : value;
  }
  const security = config.AdvancedSecurityOptions;
  if (config.LogPublishingOptions?.AUDIT_LOGS?.Enabled && !security.Enabled) reject("Audit log publishing requires fine-grained access control");
  if (security.Enabled) {
    if (!config.EncryptionAtRestOptions.Enabled || !config.NodeToNodeEncryptionOptions.Enabled || !config.DomainEndpointOptions.EnforceHTTPS) reject("Fine-grained access requires encrypted storage, node-to-node protection and HTTPS");
    if (!previous?.AdvancedSecurityOptions.Enabled && !security.MasterUserOptions) reject("Enabling fine-grained access requires MasterUserOptions");
    if (previous?.AdvancedSecurityOptions.Enabled && previous.AdvancedSecurityOptions.InternalUserDatabaseEnabled !== security.InternalUserDatabaseEnabled && !security.MasterUserOptions) reject("Changing authentication mode requires new MasterUserOptions");
    if (security.MasterUserOptions && Boolean(security.InternalUserDatabaseEnabled) !== Boolean(security.MasterUserOptions.MasterUserName)) reject("Internal-user mode requires an internal master; IAM mode requires an IAM master ARN");
  } else if (security.InternalUserDatabaseEnabled || security.MasterUserOptions) reject("Master users and the internal database require fine-grained access");
  // Passwords and master credentials never enter public configuration/status or
  // state.json. The service publishes their verifier to protected material.
  delete security.MasterUserOptions;
  return config;
}
