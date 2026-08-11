import type { LambdaService } from "../../lambda.js";
import type { StateStore } from "../../state.js";
import type { LambdaState } from "../../types.js";
import { CustomResourceCallbackBroker, type CustomResourceCallbackRecord, type CustomResourceRequestType } from "../custom-resource-callbacks.js";
import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderJsonValue,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderSuccess,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";

export const CLOUDFORMATION_CUSTOM_RESOURCE_TYPE = "AWS::CloudFormation::CustomResource";
const PROVIDER_DEADLINE_SECONDS = 15 * 60;
const MINIMUM_TIMEOUT_SECONDS = 1;

export interface LambdaCustomResourceModel {
  readonly ServiceToken: string;
  readonly ServiceTimeout?: number;
  readonly [name: string]: ProviderJsonValue | undefined;
}

interface TokenTarget { readonly functionName: string; readonly qualifier?: string; readonly functionArn: string; readonly state: LambdaState }

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stable(value: any): any { if (Array.isArray(value)) return value.map(stable); if (record(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])); return value; }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }

function schema(typeName: string): ProviderSchema {
  return Object.freeze({
    typeName,
    unknownProperties: "ALLOW" as const,
    properties: Object.freeze({
      ServiceToken: Object.freeze({ valueType: "string" as const, required: true, updateBehavior: "MUTABLE" as const }),
      ServiceTimeout: Object.freeze({ valueType: "number" as const, updateBehavior: "MUTABLE" as const }),
    }),
    ref: Object.freeze({ supported: true, valueType: "string" as const, description: "Provider-returned physical resource ID" }),
    attributes: Object.freeze({}),
    additionalAttributes: true,
    replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" as const }),
    retention: Object.freeze({ deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const), updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const), snapshotSupported: false }),
    tags: Object.freeze({ behavior: "NONE" as const, propagatesCloudFormationTags: false }),
  });
}

function validateServiceTokenFormat(value: unknown, context: ProviderContext, issues: ProviderValidationIssue[]): void {
  if (typeof value !== "string") return;
  const match = value.match(/^arn:(aws):lambda:([^:]+):(\d{12}):function:([A-Za-z0-9-_]{1,64})(?::([A-Za-z0-9-_.$]+))?$/);
  if (!match) { issues.push({ code: "InvalidProperty", path: "Properties.ServiceToken", message: "ServiceToken must be a local Lambda function, version, or alias ARN" }); return; }
  if (match[2] !== context.region || match[3] !== context.accountId) issues.push({ code: "InvalidProperty", path: "Properties.ServiceToken", message: "ServiceToken must use the stack account and Region" });
}

function resolveTarget(store: StateStore, context: ProviderContext, serviceToken: string): TokenTarget {
  const match = serviceToken.match(/^arn:aws:lambda:([^:]+):(\d{12}):function:([A-Za-z0-9-_]{1,64})(?::([A-Za-z0-9-_.$]+))?$/);
  if (!match || match[1] !== context.region || match[2] !== context.accountId) throw new Error("ServiceToken must resolve to a Lambda function in the stack account and Region");
  const [, , , functionName, qualifier] = match;
  const fn = store.regionState(context.region).functions[functionName];
  if (!fn) throw new Error(`ServiceToken Lambda function ${functionName} does not exist`);
  if ((fn.packageType ?? "Zip") !== "Zip") throw new Error("Image-backed Lambda custom-resource providers are not supported");
  if (qualifier && qualifier !== "$LATEST" && !fn.versions?.[qualifier] && !fn.aliases?.[qualifier]) throw new Error(`ServiceToken Lambda qualifier ${qualifier} does not exist`);
  return { functionName, ...(qualifier ? { qualifier } : {}), functionArn: serviceToken, state: fn };
}

function responseFailure(record: CustomResourceCallbackRecord, responseUrl: string): string {
  const reason = record.response?.Reason ?? record.invocationFailure ?? "Custom-resource provider reported failure";
  const token = new URL(responseUrl).pathname.split("/").at(-1) ?? "";
  return reason
    .replaceAll(responseUrl, "[redacted callback URL]")
    .replace(/https:\/\/[^\s"']+\/_stacksim\/cloudformation\/custom-resource-response\/[^\s"']+/gi, "[redacted callback URL]")
    .replaceAll(token, "[redacted callback token]")
    .slice(0, 4096);
}

function callbackAttributes(record: CustomResourceCallbackRecord): Record<string, unknown> {
  return { ...(record.response?.Data ?? {}), __stackSimCustomResourceNoEcho: record.response?.NoEcho === true };
}

function success(model: LambdaCustomResourceModel, record: CustomResourceCallbackRecord): ProviderSuccess<LambdaCustomResourceModel> {
  const physicalId = record.response!.PhysicalResourceId;
  return { status: "SUCCESS", physicalId, model: { physicalId, properties: model, attributes: callbackAttributes(record) } };
}

function customEvent(
  typeName: string,
  requestType: CustomResourceRequestType,
  model: LambdaCustomResourceModel,
  context: ProviderContext,
  responseUrl: string,
  physicalId?: string,
  previous?: LambdaCustomResourceModel,
): Record<string, unknown> {
  return {
    RequestType: requestType,
    ResponseURL: responseUrl,
    StackId: context.stackId,
    RequestId: context.resourceOperationId,
    LogicalResourceId: context.logicalId,
    ResourceType: typeName,
    ResourceProperties: model,
    ...(physicalId ? { PhysicalResourceId: physicalId } : {}),
    ...(previous ? { OldResourceProperties: previous } : {}),
  };
}

export function createLambdaCustomResourceProvider(
  typeName: string,
  store: StateStore,
  lambda: LambdaService,
  callbacks: CustomResourceCallbackBroker,
  declaration?: { readonly schema: ProviderSchema; readonly validate?: (properties: Record<string, unknown>) => readonly ProviderValidationIssue[] },
): ProductionResourceProvider<LambdaCustomResourceModel> {
  if (typeName !== CLOUDFORMATION_CUSTOM_RESOURCE_TYPE && (!/^Custom::[A-Za-z0-9][A-Za-z0-9._-]*$/.test(typeName) || typeName === "Custom::CDKBucketDeployment")) throw new TypeError(`${typeName} is not a general custom-resource type`);
  const providerSchema = declaration?.schema ?? schema(typeName);

  const invoke = async (
    requestType: CustomResourceRequestType,
    model: LambdaCustomResourceModel,
    context: ProviderContext,
    physicalId?: string,
    previous?: LambdaCustomResourceModel,
  ): Promise<ProviderSuccess<LambdaCustomResourceModel> | ProviderUpdateResult<LambdaCustomResourceModel> | ProviderDeleteResult> => {
    let target: TokenTarget;
    try { target = resolveTarget(store, context, model.ServiceToken); }
    catch (error) { return { status: "FAILED", errorCode: "InvalidServiceToken", message: error instanceof Error ? error.message : String(error) }; }
    const priorCallback = await callbacks.read(context.region, context.resourceOperationId);
    const expiresAt = priorCallback?.expiresAt ?? Math.min(context.deadlineAt, callbacks.now() + (model.ServiceTimeout ?? PROVIDER_DEADLINE_SECONDS) * 1000);
    let callback = await callbacks.prepare({ region: context.region, resourceType: typeName, requestType, operationId: context.operationId, resourceOperationId: context.resourceOperationId, stackId: context.stackId, logicalId: context.logicalId, serviceToken: model.ServiceToken, expiresAt });
    if (callback.invocationStatus === "INTENT") {
      const responseUrl = callbacks.responseUrl(context.region, context.resourceOperationId, expiresAt);
      const event = customEvent(typeName, requestType, model, context, responseUrl, physicalId, previous);
      const completion = callbacks.watchCompletion(context.region, context.resourceOperationId);
      try {
        const result = await lambda.invokeCloudFormationCustomResource(target.functionArn, Buffer.from(JSON.stringify(event)), context.resourceOperationId.slice(0, 24), callbacks.caCertificatePath, callbacks.port(), Math.max(1, expiresAt - callbacks.now()), completion.completed);
        callback = await callbacks.read(context.region, context.resourceOperationId) ?? callback;
        if (callback.invocationStatus !== "COMPLETED" && result.interrupted) {
          // Graceful shutdown deliberately leaves the durable INTENT open.  On
          // restart the same resource operation and RequestId are reinvoked.
        }
        else if (callback.invocationStatus !== "COMPLETED" && result.functionError && callbacks.now() < expiresAt) callback = await callbacks.markInvocationFailed(callback, "The custom-resource Lambda invocation failed before returning a valid callback");
        else if (callback.invocationStatus === "INTENT") callback = await callbacks.markInvoked(callback);
      } catch {
        callback = await callbacks.read(context.region, context.resourceOperationId) ?? callback;
        if (callback.invocationStatus !== "COMPLETED") callback = await callbacks.markInvocationFailed(callback, "The custom-resource Lambda could not be invoked through the local ZIP runtime");
      }
      finally { completion.cancel(); }
    } else callback = await callbacks.read(context.region, context.resourceOperationId) ?? callback;

    if (callback.invocationStatus === "COMPLETED") {
      if (callback.response!.Status === "FAILED") return { status: "FAILED", errorCode: "CustomResourceFailure", message: responseFailure(callback, callbacks.responseUrl(context.region, context.resourceOperationId, expiresAt)), physicalId: callback.response!.PhysicalResourceId };
      if (requestType === "Delete") return { status: "SUCCESS", physicalId: callback.response!.PhysicalResourceId };
      return success(model, callback);
    }
    if (callback.invocationStatus === "INVOCATION_FAILED") return { status: "FAILED", errorCode: "CustomResourceInvocationFailure", message: responseFailure(callback, callbacks.responseUrl(context.region, context.resourceOperationId, expiresAt)) };
    if (callbacks.now() >= expiresAt) return { status: "FAILED", errorCode: "CustomResourceTimeout", message: "The custom-resource callback expired before a valid response was received" };
    return { status: "IN_PROGRESS", callbackAfterMs: Math.min(250, Math.max(25, expiresAt - callbacks.now())), checkpoint: { schemaVersion: 1, ...(physicalId ? { physicalId } : {}), callbackContext: { phase: "await-callback", requestType } } };
  };

  return {
    typeName,
    providerVersion: 1,
    visibility: "production",
    schema: providerSchema,
    validate(properties: unknown, context: ProviderContext): readonly ProviderValidationIssue[] {
      const issues = validateDeclaredProperties(properties ?? {}, providerSchema);
      if (!record(properties)) return issues;
      validateServiceTokenFormat(properties.ServiceToken, context, issues);
      const timeout = properties.ServiceTimeout;
      if (timeout !== undefined && (!Number.isSafeInteger(timeout) || Number(timeout) < MINIMUM_TIMEOUT_SECONDS || Number(timeout) > PROVIDER_DEADLINE_SECONDS)) issues.push({ code: "InvalidProperty", path: "Properties.ServiceTimeout", message: `ServiceTimeout must be an integer from ${MINIMUM_TIMEOUT_SECONDS} through ${PROVIDER_DEADLINE_SECONDS}` });
      if (declaration?.validate) issues.push(...declaration.validate(properties));
      return issues;
    },
    canonicalize(properties: unknown, context: ProviderContext): LambdaCustomResourceModel {
      if (!record(properties)) throw new TypeError(`${typeName} Properties must be an object`);
      const issues = this.validate(properties, context); if (issues.length) throw new TypeError(issues.map(issue => `${issue.path}: ${issue.message}`).join("; "));
      return stable({ ...properties, ServiceToken: String(properties.ServiceToken), ...(properties.ServiceTimeout !== undefined ? { ServiceTimeout: Number(properties.ServiceTimeout) } : {}) }) as LambdaCustomResourceModel;
    },
    plan(previous: LambdaCustomResourceModel | undefined, desired: LambdaCustomResourceModel): ProviderPlan<LambdaCustomResourceModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const differences = [...new Set([...Object.keys(previous), ...Object.keys(desired)])].filter(key => !same(previous[key], desired[key])).sort();
      return differences.length ? { action: "UPDATE", desired, changedProperties: differences, replacementProperties: [] } : { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
    },
    async create(desired, context) { return invoke("Create", desired, context) as Promise<any>; },
    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<LambdaCustomResourceModel>> {
      const resource = store.regionState(context.region).cloudformation.stacks[context.stackId]?.resources[context.logicalId];
      if (!resource || resource.resourceType !== typeName || resource.physicalResourceId !== physicalId) return { status: "NOT_FOUND", physicalId };
      return { status: "SUCCESS", physicalId, model: { physicalId, properties: stable(resource.properties) as unknown as LambdaCustomResourceModel, attributes: structuredClone(resource.attributes) } };
    },
    async update(physicalId, previous, desired, context) { return invoke("Update", desired, context, physicalId, previous) as Promise<any>; },
    async delete(physicalId, previous, context) { return invoke("Delete", previous, context, physicalId) as Promise<any>; },
    ref(model: ProviderReadModel<LambdaCustomResourceModel>): unknown { return model.physicalId; },
    getAtt(model: ProviderReadModel<LambdaCustomResourceModel>, attribute: string): unknown {
      if (attribute !== "__stackSimCustomResourceNoEcho" && Object.hasOwn(model.attributes, attribute)) return model.attributes[attribute];
      throw new ProviderReferenceError(typeName, `Fn::GetAtt ${attribute}`);
    },
  };
}
