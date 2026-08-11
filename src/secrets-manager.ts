import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "./core/clock.js";
import { SystemClock } from "./core/clock.js";
import type { Scheduler } from "./core/scheduler.js";
import { AwsError } from "./errors.js";
import { SECRETS_MANAGER_ACTIONS } from "./secrets-manager/action-inventory.js";
import { prospectiveSecretArn, SecretsManagerStore, type SecretsManagerRdsTargetPort, type SecretsManagerRotationInvoker } from "./secrets-manager/secret-store.js";
import type { StateStore } from "./state.js";
import type { PrincipalContext } from "./auth/sigv4.js";
import type { SecretState } from "./types.js";
import { json, readJson } from "./util.js";

const TARGET_PREFIX = "secretsmanager.";

export { prospectiveSecretArn as secretsManagerArn };

export function sendSecretsManagerError(res: ServerResponse, error: unknown): void {
  const aws = error instanceof AwsError
    ? error
    : new AwsError("InternalServiceError", error instanceof Error ? error.message : "Secrets Manager failed safely.", 500);
  res.statusCode = aws.status;
  res.setHeader("content-type", "application/x-amz-json-1.1");
  res.setHeader("x-amzn-errortype", aws.code);
  res.end(JSON.stringify({ __type: aws.code, Message: aws.message, ...aws.details }));
}

export class SecretsManagerService {
  readonly catalog: SecretsManagerStore;
  private admissionError?: Error;

  constructor(
    store: StateStore,
    region: string,
    clock: Clock = new SystemClock(),
    scheduler?: Scheduler,
    authorizeTagMutation?: ConstructorParameters<typeof SecretsManagerStore>[4],
    suffixGenerator?: () => string,
  ) {
    this.catalog = new SecretsManagerStore(store, region, clock, scheduler, authorizeTagMutation, suffixGenerator);
  }

  async start(): Promise<void> {
    try {
      await this.catalog.start();
      this.admissionError = undefined;
    } catch (error) {
      this.admissionError = error instanceof Error ? error : new Error(String(error));
    }
  }

  stop(): void { this.catalog.stop(); }

  admissionStatus(): "available" | "unavailable" {
    return this.admissionError ? "unavailable" : "available";
  }

  setRotationInvoker(value: SecretsManagerRotationInvoker): void { this.catalog.setRotationInvoker(value); }
  setRdsTargetPort(value: SecretsManagerRdsTargetPort): void { this.catalog.setRdsTargetPort(value); }

  resolveArn(secretId: unknown): string | undefined {
    return this.catalog.resolveArn(secretId);
  }

  resourceTags(secretId: unknown): Record<string, string> {
    return this.catalog.resourceTags(secretId);
  }

  resourcePolicy(secretId: unknown): ReturnType<SecretsManagerStore["resourcePolicy"]> {
    return this.catalog.resourcePolicy(secretId);
  }

  localMetadata(): ReturnType<SecretsManagerStore["localMetadata"]> {
    return this.catalog.localMetadata();
  }

  CreateSecretCloudFormation(input: any, owner: string, token: string): Promise<SecretState> { return this.catalog.CreateSecretCloudFormation(input, owner, token); }
  UpdateSecretCloudFormation(input: any, owner: string, token: string, writeValue: boolean): Promise<SecretState> { return this.catalog.UpdateSecretCloudFormation(input, owner, token, writeValue); }
  readSecretCloudFormation(secretId: unknown): SecretState | undefined { return this.catalog.readSecretCloudFormation(secretId); }
  DeleteSecretCloudFormation(secretId: unknown, owner: string): Promise<void> { return this.catalog.DeleteSecretCloudFormation(secretId, owner); }
  PutResourcePolicyCloudFormation(input: any, owner: string, principal?: PrincipalContext): Promise<SecretState> { return this.catalog.PutResourcePolicyCloudFormation(input, owner, principal); }
  DeleteResourcePolicyCloudFormation(secretId: unknown, owner: string): Promise<void> { return this.catalog.DeleteResourcePolicyCloudFormation(secretId, owner); }
  getSecretForService(input: { SecretId: string; VersionId?: string; VersionStage?: string }): Promise<any> { return this.catalog.GetSecretValue(input); }
  RotateSecret(input: any): Promise<any> { return this.catalog.RotateSecret(input); }
  CancelRotateSecret(input: any): Promise<any> { return this.catalog.CancelRotateSecret(input); }
  RotateSecretCloudFormation(input: any, owner: string): Promise<any> { return this.catalog.RotateSecret(input, owner, input?.RotateImmediatelyOnUpdate); }
  CancelRotateSecretCloudFormation(secretId: unknown, owner: string): Promise<any> { return this.catalog.CancelRotateSecret({ SecretId: secretId }, owner); }
  AttachSecretTargetCloudFormation(input: any, owner: string): Promise<any> { return this.catalog.AttachSecretTarget(input, owner); }
  DetachSecretTargetCloudFormation(secretId: unknown, owner: string): Promise<void> { return this.catalog.DetachSecretTarget(secretId, owner); }
  CreateManagedRdsSecret(input: Parameters<SecretsManagerStore["CreateManagedRdsSecret"]>[0]): ReturnType<SecretsManagerStore["CreateManagedRdsSecret"]> { return this.catalog.CreateManagedRdsSecret(input); }
  DeleteManagedRdsSecret(secretId: string, managedResourceArn: string): Promise<void> { return this.catalog.DeleteManagedRdsSecret(secretId, managedResourceArn); }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = String(req.headers["x-amz-target"] ?? "");
    const action = target.startsWith(TARGET_PREFIX) ? target.slice(TARGET_PREFIX.length) : "";
    try {
      if (this.admissionError) throw new AwsError("InternalServiceError", this.admissionError.message, 503);
      if (req.method !== "POST" || !SECRETS_MANAGER_ACTIONS.has(action)) {
        throw new AwsError("UnknownOperationException", `The operation ${action || "(empty)"} is not supported.`, 400);
      }
      let input: any;
      try { input = await readJson(req); }
      catch { throw new AwsError("SerializationException", "Could not parse request body into json.", 400); }
      const method = (this.catalog as any)[action];
      const principal = (req as any).awsPrincipal;
      const output = action === "TagResource" || action === "UntagResource" || action === "PutResourcePolicy" || action === "ValidateResourcePolicy"
        ? await method.call(this.catalog, input, principal)
        : action === "BatchGetSecretValue"
          ? await method.call(this.catalog, input, (req as any).awsSecretsManagerBatchAuthorize)
          : await method.call(this.catalog, input);
      json(res, output, 200, "application/x-amz-json-1.1");
    } catch (error) {
      sendSecretsManagerError(res, error);
    }
  }
}
