import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

const cloudFormationIdempotencyKey = Symbol("stacksim.cloudformation-idempotency-key");
const cloudFormationOwner = Symbol("stacksim.cloudformation-owner");

type InternalIncomingMessage = IncomingMessage & {
  [cloudFormationIdempotencyKey]?: string;
  [cloudFormationOwner]?: string;
};

/**
 * Mark an in-process service request as a CloudFormation provider operation.
 * The symbol cannot be supplied by an SDK/network caller and is deliberately
 * not represented as an HTTP header.
 */
export function setCloudFormationIdempotencyKey(request: IncomingMessage, key: string | undefined): void {
  if (key) (request as InternalIncomingMessage)[cloudFormationIdempotencyKey] = key;
}

export function getCloudFormationIdempotencyKey(request: IncomingMessage): string | undefined {
  return (request as InternalIncomingMessage)[cloudFormationIdempotencyKey];
}

/**
 * Attach the stable stack/logical-resource owner to an in-process request.
 * Like the operation token, this is deliberately unavailable to SDK callers.
 */
export function setCloudFormationOwner(request: IncomingMessage, owner: string | undefined): void {
  if (owner) (request as InternalIncomingMessage)[cloudFormationOwner] = owner;
}

export function getCloudFormationOwner(request: IncomingMessage): string | undefined {
  return (request as InternalIncomingMessage)[cloudFormationOwner];
}

/** Stable API Gateway-style identifier scoped to one provider operation. */
export function cloudFormationResourceId(key: string | undefined, suffix: string, length = 10): string | undefined {
  return key ? createHash("sha256").update(`${key}\0${suffix}`).digest("hex").slice(0, length) : undefined;
}

export function cloudFormationChildToken(key: string, suffix: string): string {
  return `${key}\0${suffix}`;
}
