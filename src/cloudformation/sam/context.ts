import type { JsonObject } from "./common.js";

/** Shared state for one AWS::Serverless-2016-10-31 expansion. */
export interface SamContext {
  readonly region: string;
  readonly partition: string;
  readonly accountId: string;
  /** Template parameter values SAM may resolve (supplied, defaults, pseudo). */
  readonly parameters: Readonly<Record<string, unknown>>;
  /** The working SAM template. Function events edit API definitions in place. */
  readonly template: JsonObject;
  /** Resources of the working template, keyed by logical ID. */
  readonly resources: Record<string, JsonObject>;
  /** Generated CloudFormation resources. */
  readonly output: Record<string, JsonObject>;
  /** SAM resource references such as MyApi.Stage, by logical ID then property. */
  readonly references: Map<string, Map<string, string>>;
  /** FunctionName values of functions with Api events, per REST API, for deployment hashes. */
  readonly functionNames: Map<string, string[]>;
  /** Milliseconds since the epoch, used only by AlwaysDeploy. */
  readonly now: number;
}

export function addReference(context: SamContext, logicalId: string, property: string, target: string): void {
  const properties = context.references.get(logicalId) ?? new Map<string, string>();
  properties.set(property, target);
  context.references.set(logicalId, properties);
}
