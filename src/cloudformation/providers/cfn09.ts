import type { EventBridgeService } from "../../eventbridge.js";
import type { LambdaService } from "../../lambda.js";
import type { SqsService } from "../../sqs.js";
import type { ProductionResourceProvider } from "./contract.js";
import { createEventBridgeCloudFormationProviders } from "./eventbridge-resources.js";
import { createLambdaEventConfigurationProviders } from "./lambda-event-configuration.js";
import { createSqsQueueProvider } from "./sqs-queue.js";

export * from "./eventbridge-resources.js";
export * from "./lambda-event-configuration.js";
export * from "./sqs-queue.js";

/** Providers added by the CFN-09 resource-family increment. */
export function createCfn09CloudFormationProviders(
  sqs: SqsService,
  eventbridge: EventBridgeService,
  lambda: LambdaService,
): readonly ProductionResourceProvider<any>[] {
  return [
    createSqsQueueProvider(sqs),
    ...createEventBridgeCloudFormationProviders(eventbridge),
    ...createLambdaEventConfigurationProviders(lambda),
  ];
}
