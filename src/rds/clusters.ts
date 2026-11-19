import { randomUUID } from "node:crypto";
import { AwsError } from "../errors.js";
import type { RdsDbClusterState } from "../types.js";
import { boolean, integer, namedList, rejectUnsupportedInput, requiredString, tags, validatePassword } from "./query-input.js";

export type ClusterInput = Record<string, unknown>;
export const AURORA_MYSQL_VERSION = "8.0.mysql_aurora.3.08.0";

function scalingConfiguration(value: unknown): NonNullable<RdsDbClusterState["serverlessV2ScalingConfiguration"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AwsError("InvalidParameterValue", "ServerlessV2ScalingConfiguration must specify a capacity range");
  }
  const input = value as ClusterInput;
  rejectUnsupportedInput(input, ["MinCapacity", "MaxCapacity"]);
  const capacity = (name: string): number => {
    const raw = input[name];
    const parsed = typeof raw === "number" || (typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw)) ? Number(raw) : NaN;
    if (!Number.isInteger(parsed * 2) || parsed < 0.5 || parsed > 256) {
      throw new AwsError("InvalidParameterValue", name + " must be between 0.5 and 256 in half-ACU increments");
    }
    return parsed;
  };
  const minCapacity = capacity("MinCapacity");
  const maxCapacity = capacity("MaxCapacity");
  if (minCapacity > maxCapacity) throw new AwsError("InvalidParameterValue", "MinCapacity exceeds MaxCapacity");
  return { minCapacity, maxCapacity };
}

export function newCluster(input: ClusterInput, accountId: string, region: string, now: number) {
  rejectUnsupportedInput(input, [
    "DBClusterIdentifier", "Engine", "EngineVersion", "EngineMode", "MasterUsername", "MasterUserPassword",
    "DatabaseName", "Port", "DeletionProtection", "CopyTagsToSnapshot", "BackupRetentionPeriod",
    "ServerlessV2ScalingConfiguration", "Tags", "DBClusterParameterGroupName", "EnableHttpEndpoint",
    "ManageMasterUserPassword", "StorageEncrypted", "AllocatedStorage", "Iops", "AutoMinorVersionUpgrade",
    "EnableIAMDatabaseAuthentication",
  ]);
  const identifier = requiredString(input.DBClusterIdentifier, "DBClusterIdentifier").toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(identifier) || identifier.endsWith("-") || identifier.includes("--")) {
    throw new AwsError("InvalidParameterValue", "DBClusterIdentifier must start with a letter and contain only letters, digits and single hyphens");
  }
  if (input.Engine !== "aurora-mysql" || (input.EngineMode ?? "provisioned") !== "provisioned" || (input.EngineVersion ?? AURORA_MYSQL_VERSION) !== AURORA_MYSQL_VERSION) {
    throw new AwsError("InvalidParameterCombination", "The cluster profile supports provisioned aurora-mysql version " + AURORA_MYSQL_VERSION);
  }
  for (const field of ["StorageEncrypted", "EnableIAMDatabaseAuthentication"]) {
    if (boolean(input[field])) throw new AwsError("InvalidParameterCombination", field + " is unavailable for local RDS clusters");
  }
  if (input.DBClusterParameterGroupName !== undefined && input.DBClusterParameterGroupName !== "default.aurora-mysql8.0") {
    throw new AwsError("InvalidParameterCombination", "Only default.aurora-mysql8.0 is supported");
  }
  if (integer(input.AllocatedStorage, 0, "AllocatedStorage") !== 0 || integer(input.Iops, 0, "Iops") !== 0) {
    throw new AwsError("InvalidParameterCombination", "The local Aurora profile does not provision storage or IOPS capacity");
  }
  if (integer(input.BackupRetentionPeriod, 1, "BackupRetentionPeriod") !== 1) {
    throw new AwsError("InvalidParameterCombination", "Only the default Aurora backup retention descriptor of 1 is supported");
  }
  const port = integer(input.Port, 3306, "Port");
  if (port < 1150 || port > 65535) throw new AwsError("InvalidParameterValue", "Port must be between 1150 and 65535");
  const databaseName = input.DatabaseName === undefined ? undefined : requiredString(input.DatabaseName, "DatabaseName");
  if (databaseName && !/^[a-z][a-z0-9_]{0,63}$/i.test(databaseName)) throw new AwsError("InvalidParameterValue", "DatabaseName is invalid");
  const masterUsername = requiredString(input.MasterUsername, "MasterUsername");
  if (!/^[a-z][a-z0-9_]{0,15}$/i.test(masterUsername) || /^(root|mysql|mariadb|sqlite)$/i.test(masterUsername)) {
    throw new AwsError("InvalidParameterValue", "MasterUsername is invalid or reserved");
  }
  const managed = boolean(input.ManageMasterUserPassword);
  if (managed && input.MasterUserPassword !== undefined) throw new AwsError("InvalidParameterCombination", "A managed cluster generates its master password");
  const password = managed ? undefined : validatePassword(input.MasterUserPassword);
  const generation = randomUUID().replaceAll("-", "").slice(0, 26);
  const cluster: RdsDbClusterState = {
    dbClusterIdentifier: identifier,
    dbClusterResourceId: "cluster-" + generation,
    dbClusterArn: `arn:aws:rds:${region}:${accountId}:cluster:${identifier}`,
    storageResourceId: "db-" + generation,
    status: "creating",
    engine: "aurora-mysql",
    engineVersion: AURORA_MYSQL_VERSION,
    engineMode: "provisioned",
    ...(databaseName ? { databaseName } : {}),
    masterUsername,
    port,
    deletionProtection: boolean(input.DeletionProtection),
    copyTagsToSnapshot: boolean(input.CopyTagsToSnapshot),
    backupRetentionPeriod: 1,
    storageEncrypted: false,
    httpEndpointEnabled: boolean(input.EnableHttpEndpoint),
    ...(managed ? { manageMasterUserPassword: true } : {}),
    autoMinorVersionUpgrade: boolean(input.AutoMinorVersionUpgrade, true),
    ...(input.ServerlessV2ScalingConfiguration === undefined ? {} : { serverlessV2ScalingConfiguration: scalingConfiguration(input.ServerlessV2ScalingConfiguration) }),
    clusterCreateTime: now,
    members: [],
    tags: tags(input.Tags),
  };
  return { cluster, password };
}

export function clusterChanges(input: ClusterInput): Partial<RdsDbClusterState> {
  rejectUnsupportedInput(input, ["DBClusterIdentifier", "ApplyImmediately", "DeletionProtection", "CopyTagsToSnapshot", "ServerlessV2ScalingConfiguration", "AutoMinorVersionUpgrade", "ManageMasterUserPassword", "MasterUserPassword", "RotateMasterUserPassword"]);
  boolean(input.ApplyImmediately);
  return {
    ...(input.DeletionProtection === undefined ? {} : { deletionProtection: boolean(input.DeletionProtection) }),
    ...(input.CopyTagsToSnapshot === undefined ? {} : { copyTagsToSnapshot: boolean(input.CopyTagsToSnapshot) }),
    ...(input.AutoMinorVersionUpgrade === undefined ? {} : { autoMinorVersionUpgrade: boolean(input.AutoMinorVersionUpgrade) }),
    ...(input.ServerlessV2ScalingConfiguration === undefined ? {} : { serverlessV2ScalingConfiguration: scalingConfiguration(input.ServerlessV2ScalingConfiguration) }),
  };
}

export function clusterMatches(input: ClusterInput): (cluster: RdsDbClusterState) => boolean {
  rejectUnsupportedInput(input, ["DBClusterIdentifier", "Filters", "MaxRecords", "Marker", "IncludeShared"]);
  if (input.Marker !== undefined || boolean(input.IncludeShared)) throw new AwsError("InvalidParameterValue", "The cluster catalog has no additional pages or shared resources");
  const max = integer(input.MaxRecords, 100, "MaxRecords");
  if (max < 20 || max > 100) throw new AwsError("InvalidParameterValue", "MaxRecords must be between 20 and 100");
  const filters = namedList(input.Filters, "Filter").map(filter => {
    const values = namedList(filter?.Values, "Value");
    const name = filter?.Name;
    if (!values.length || !["db-cluster-id", "db-cluster-resource-id", "engine"].includes(name)) throw new AwsError("InvalidParameterValue", "Invalid cluster filter");
    return (cluster: RdsDbClusterState) => {
      if (name === "engine") return values.includes(cluster.engine);
      if (name === "db-cluster-resource-id") return values.includes(cluster.dbClusterResourceId);
      return values.includes(cluster.dbClusterIdentifier) || values.includes(cluster.dbClusterArn);
    };
  });
  return cluster => filters.every(matches => matches(cluster));
}
