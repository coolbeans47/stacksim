import type { Clock } from "../../core/clock.js";
import type { IamService } from "../../iam.js";
import type { ProductionResourceProvider } from "./contract.js";
import { createIamManagedPolicyProvider } from "./iam-managed-policy.js";
import { createIamPolicyProvider } from "./iam-policy.js";
import { createIamRoleProvider } from "./iam-role.js";

export * from "./iam-role.js";
export * from "./iam-policy.js";
export * from "./iam-managed-policy.js";

/**
 * Construct the direct-IAM-backed CFN-06 provider set. The optional clock is
 * reserved for future asynchronous stabilization without changing the factory
 * signature; current IAM operations complete synchronously in the simulator.
 */
export function createIamCloudFormationProviders(iam: IamService, _clock?: Pick<Clock, "now">): readonly ProductionResourceProvider<any>[] {
  return Object.freeze([
    createIamRoleProvider(iam),
    createIamPolicyProvider(iam),
    createIamManagedPolicyProvider(iam),
  ]);
}
