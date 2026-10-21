import { cfnResource, fnSub, getAtt, passthroughAttributes, type JsonObject } from "../common.js";
import { eventPermission, readEventProperties, type EventSpec, type EventTarget } from "./common.js";

const CLOUDWATCH_LOGS_SPEC: EventSpec = {
  LogGroupName: { type: "string", required: true },
  FilterPattern: { type: "string", required: true },
};

export const readLogsEvent = (eventLogicalId: string, event: JsonObject): JsonObject => readEventProperties(eventLogicalId, "CloudWatchLogs", event, CLOUDWATCH_LOGS_SPEC);

/** CloudWatchLogs event: `<F><Event>Permission` and the `<F><Event>` subscription filter that depends on it. */
export function translateLogsEvent(target: EventTarget, eventId: string, properties: JsonObject): Record<string, JsonObject> {
  const logicalId = `${target.functionLogicalId}${eventId}`;
  const sourceArn = fnSub(`arn:${target.partition}:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:\${__LogGroupName__}:*`, { __LogGroupName__: properties.LogGroupName });
  const [permissionId, permission] = eventPermission(target, logicalId, "logs.amazonaws.com", { SourceArn: sourceArn });
  return {
    [permissionId]: permission,
    [logicalId]: cfnResource("AWS::Logs::SubscriptionFilter", {
      LogGroupName: properties.LogGroupName,
      FilterPattern: properties.FilterPattern,
      DestinationArn: target.functionArn,
    }, { DependsOn: [permissionId], ...passthroughAttributes(target.fn) }),
  };
}
