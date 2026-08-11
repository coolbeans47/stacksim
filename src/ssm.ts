import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "./core/clock.js";
import type { Scheduler } from "./core/scheduler.js";
import { SystemClock } from "./core/clock.js";
import { AwsError } from "./errors.js";
import { PARAMETER_STORE_ACTIONS } from "./ssm/action-inventory.js";
import { parameterArn, ParameterStore, type ParameterStoreEventPublisher } from "./ssm/parameter-store.js";
import type { StateStore } from "./state.js";
import type { CloudFormationBootstrapState } from "./types.js";
import type { ParameterState } from "./types.js";
import { json, readJson } from "./util.js";

const TARGET_PREFIX = "AmazonSSM.";

export function ssmParameterArn(region: string, accountId: string, name: string): string {
  if (name.startsWith("arn:")) {
    const selector = name.match(/^(arn:(?:aws|aws-cn|aws-us-gov):ssm:[^:]+:\d{12}:parameter\/.+):(?:[1-9]\d*|[^:]+)$/);
    return selector?.[1] ?? name;
  }
  return parameterArn(region, accountId, name.replace(/:(?:[1-9]\d*|[^:]+)$/, ""));
}

export function sendSsmError(res: ServerResponse, error: unknown): void {
  const aws = error instanceof AwsError
    ? error
    : new AwsError("InternalServerError", error instanceof Error ? error.message : "Parameter Store failed safely.", 500);
  res.statusCode = aws.status;
  res.setHeader("content-type", "application/x-amz-json-1.1");
  res.setHeader("x-amzn-errortype", aws.code);
  res.end(JSON.stringify({ __type: `com.amazonaws.ssm#${aws.code}`, message: aws.message, ...aws.details }));
}

export class SsmService {
  readonly parameterStore: ParameterStore;

  constructor(store: StateStore, region: string, clock: Clock = new SystemClock(), scheduler?: Scheduler, publishEvent?: ParameterStoreEventPublisher) {
    this.parameterStore = new ParameterStore(store, region, clock, scheduler, publishEvent);
  }

  start(): Promise<void> {
    return this.parameterStore.start();
  }

  stop(): void { this.parameterStore.stop(); }

  reconcileBootstrapRecord(bootstrap: CloudFormationBootstrapState): boolean {
    return this.parameterStore.reconcileBootstrapRecord(bootstrap);
  }

  validateBootstrapRecord(bootstrap: CloudFormationBootstrapState): void {
    this.parameterStore.validateBootstrapRecord(bootstrap);
  }

  resolveBootstrapPlain(name: string): string | undefined {
    return this.parameterStore.resolveBootstrapPlain(name);
  }

  resolveCloudFormationPlain(name: string): string | undefined { return this.parameterStore.resolveCloudFormationPlain(name); }
  getParameterForService(name: string, withDecryption: boolean): Promise<any> { return this.parameterStore.getParameterForService(name, withDecryption); }

  localMetadata(): ReturnType<ParameterStore["localMetadata"]> {
    return this.parameterStore.localMetadata();
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = String(req.headers["x-amz-target"] ?? "");
    const action = target.startsWith(TARGET_PREFIX) ? target.slice(TARGET_PREFIX.length) : "";
    try {
      if (req.method !== "POST" || !PARAMETER_STORE_ACTIONS.has(action)) throw new AwsError("UnknownOperationException", `The operation ${action || "(empty)"} is not supported.`);
      let input: any;
      try { input = await readJson(req); }
      catch { throw new AwsError("SerializationException", "Could not parse request body into json."); }
      const method = (this.parameterStore as any)[action];
      const principalArn = (req as any).awsPrincipal?.principalArn;
      const output = action === "PutParameter"
        ? await method.call(this.parameterStore, input, principalArn)
        : await method.call(this.parameterStore, input);
      json(res, output, 200, "application/x-amz-json-1.1");
    } catch (error) {
      sendSsmError(res, error);
    }
  }

  GetParameter(input: any): Promise<any> { return this.parameterStore.GetParameter(input); }
  GetParameters(input: any): Promise<any> { return this.parameterStore.GetParameters(input); }
  GetParametersByPath(input: any): Promise<any> { return this.parameterStore.GetParametersByPath(input); }
  PutParameter(input: any, principalArn?: string): Promise<any> { return this.parameterStore.PutParameter(input, principalArn); }
  DeleteParameter(input: any): Promise<any> { return this.parameterStore.DeleteParameter(input); }
  DeleteParameters(input: any): Promise<any> { return this.parameterStore.DeleteParameters(input); }
  DescribeParameters(input: any): Promise<any> { return this.parameterStore.DescribeParameters(input); }
  AddTagsToResource(input: any): Promise<any> { return this.parameterStore.AddTagsToResource(input); }
  RemoveTagsFromResource(input: any): Promise<any> { return this.parameterStore.RemoveTagsFromResource(input); }
  ListTagsForResource(input: any): Promise<any> { return this.parameterStore.ListTagsForResource(input); }
  GetParameterHistory(input: any): Promise<any> { return this.parameterStore.GetParameterHistory(input); }
  LabelParameterVersion(input: any): Promise<any> { return this.parameterStore.LabelParameterVersion(input); }
  UnlabelParameterVersion(input: any): Promise<any> { return this.parameterStore.UnlabelParameterVersion(input); }
  PutParameterCloudFormation(input: any, owner: string, principalArn: string): Promise<any> { return this.parameterStore.PutParameterCloudFormation(input, owner, principalArn); }
  readParameterCloudFormation(name: string): ParameterState | undefined { return this.parameterStore.readParameterCloudFormation(name); }
  DeleteParameterCloudFormation(name: string, owner: string): Promise<void> { return this.parameterStore.DeleteParameterCloudFormation(name, owner); }
}
