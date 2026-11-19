import { randomUUID } from "node:crypto";
import { AwsError } from "../errors.js";
import type { RdsDbClusterState, RdsDbInstanceState } from "../types.js";
import { boolean, integer, rejectUnsupportedInput, requiredString, tags } from "./query-input.js";
import { effectiveParameterValues } from "./parameters.js";

type Input = Record<string, unknown>;

function promotionTier(value: unknown): number {
  const result = integer(value, 1, "PromotionTier");
  if (result < 0 || result > 15) throw new AwsError("InvalidParameterValue", "PromotionTier must be between 0 and 15");
  return result;
}

export function createWriterDescriptor(input: Input, cluster: RdsDbClusterState, account: string, region: string, now: number): RdsDbInstanceState {
  rejectUnsupportedInput(input, [
    "DBClusterIdentifier", "DBInstanceIdentifier", "Engine", "EngineVersion", "DBInstanceClass", "DBParameterGroupName", "AvailabilityZone",
    "PromotionTier", "PubliclyAccessible", "AutoMinorVersionUpgrade", "CopyTagsToSnapshot", "Tags",
  ]);
  const id = requiredString(input.DBInstanceIdentifier, "DBInstanceIdentifier").toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(id) || id.endsWith("-") || id.includes("--")) throw new AwsError("InvalidParameterValue", "DBInstanceIdentifier is invalid");
  if (input.Engine !== cluster.engine || (input.EngineVersion ?? cluster.engineVersion) !== cluster.engineVersion) {
    throw new AwsError("InvalidParameterCombination", "The writer engine and version must match the DB cluster");
  }
  if (input.DBInstanceClass !== "db.serverless" || !cluster.serverlessV2ScalingConfiguration) {
    throw new AwsError("InvalidParameterCombination", "Use db.serverless with ServerlessV2ScalingConfiguration on the parent cluster");
  }
  if (boolean(input.PubliclyAccessible)) throw new AwsError("InvalidParameterCombination", "The local cluster writer is accessible only on loopback");
  const availabilityZone = String(input.AvailabilityZone ?? region + "a");
  if (availabilityZone.slice(0, -1) !== region || !/[a-z]$/.test(availabilityZone)) throw new AwsError("InvalidParameterValue", "AvailabilityZone must be in the cluster Region");
  const group = "default.aurora-mysql8.0";
  if ((input.DBParameterGroupName ?? group) !== group) throw new AwsError("InvalidParameterCombination", "Only the default Aurora MySQL parameter group is supported");
  return {
    dbInstanceIdentifier: id,
    dbiResourceId: "db-" + randomUUID().replaceAll("-", "").slice(0, 26),
    dbInstanceArn: `arn:aws:rds:${region}:${account}:db:${id}`,
    dbClusterIdentifier: cluster.dbClusterIdentifier,
    dbClusterResourceId: cluster.dbClusterResourceId,
    dbInstanceClass: "db.serverless",
    dbInstanceStatus: "creating",
    engine: cluster.engine,
    engineVersion: cluster.engineVersion,
    dbName: cluster.databaseName,
    masterUsername: cluster.masterUsername,
    port: cluster.port,
    allocatedStorage: 1,
    storageType: "aurora",
    backupRetentionPeriod: cluster.backupRetentionPeriod,
    deletionProtection: false,
    publiclyAccessible: false,
    multiAZ: false,
    promotionTier: promotionTier(input.PromotionTier),
    autoMinorVersionUpgrade: boolean(input.AutoMinorVersionUpgrade, true),
    copyTagsToSnapshot: boolean(input.CopyTagsToSnapshot),
    dbParameterGroupName: group,
    parameterApplyStatus: "in-sync",
    appliedParameters: effectiveParameterValues(),
    availabilityZone,
    instanceCreateTime: now,
    tags: tags(input.Tags),
    providerEngine: "sqlite",
  };
}

export function writerChanges(input: Input, writer: RdsDbInstanceState): Partial<RdsDbInstanceState> {
  rejectUnsupportedInput(input, [
    "DBInstanceIdentifier", "ApplyImmediately", "PromotionTier", "AutoMinorVersionUpgrade", "CopyTagsToSnapshot",
    "PubliclyAccessible", "DBInstanceClass", "EngineVersion", "DBParameterGroupName",
  ]);
  boolean(input.ApplyImmediately);
  if (boolean(input.PubliclyAccessible) || (input.DBInstanceClass ?? writer.dbInstanceClass) !== writer.dbInstanceClass ||
    (input.EngineVersion ?? writer.engineVersion) !== writer.engineVersion || (input.DBParameterGroupName ?? writer.dbParameterGroupName) !== writer.dbParameterGroupName) {
    throw new AwsError("InvalidParameterCombination", "The writer must keep its supported class, engine, parameter group and local network settings");
  }
  return {
    ...(input.PromotionTier === undefined ? {} : { promotionTier: promotionTier(input.PromotionTier) }),
    ...(input.AutoMinorVersionUpgrade === undefined ? {} : { autoMinorVersionUpgrade: boolean(input.AutoMinorVersionUpgrade) }),
    ...(input.CopyTagsToSnapshot === undefined ? {} : { copyTagsToSnapshot: boolean(input.CopyTagsToSnapshot) }),
  };
}
