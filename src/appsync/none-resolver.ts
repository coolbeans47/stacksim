import { AwsError } from "../errors.js";
import {
  evaluateAppSyncVtl,
  validateAppSyncVtl,
  type AppSyncVtlContext,
  type AppSyncVtlEvaluation,
} from "./vtl.js";

export type NoneResolverContext = Pick<
  AppSyncVtlContext,
  "arguments" | "source" | "identity" | "stash" | "request" | "info" | "prev" | "authType"
>;

function requestDocument(evaluation: AppSyncVtlEvaluation): { version: string; payload: unknown } {
  const request = evaluation.value;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("The NONE request document must be an object");
  }
  const keys = Object.keys(request);
  // The frozen Amplify generated function corpus uses an empty NONE request
  // document for init/auth/post-auth stages. Its modeled data-source result is
  // the same empty map; broader document shapes remain rejected below.
  if (keys.length === 0) return { version: "2018-05-29", payload: {} };
  if (keys.some(key => key !== "version" && key !== "payload")) {
    throw new Error("The NONE request document contains an unsupported member");
  }
  if ((request as any).version !== "2018-05-29") {
    throw new Error("The NONE request version must be 2018-05-29");
  }
  if (!Object.hasOwn(request, "payload")) {
    throw new Error("The NONE request document must contain payload");
  }
  return request as { version: string; payload: unknown };
}

export function validateNoneResolverTemplates(requestTemplate: string, responseTemplate: string): void {
  try {
    validateAppSyncVtl(requestTemplate);
    validateAppSyncVtl(responseTemplate);
    const context: NoneResolverContext = {
      arguments: { value: "validation", input: { id: "validation" } },
      source: { value: "source" },
      identity: null,
      stash: { first: true, hasAuth: true, conditions: [], metadata: {}, connectionAttributes: {}, adminRoles: [] },
      request: { headers: {} },
      info: { fieldName: "field", parentTypeName: "Query", variables: {} },
      authType: "API Key Authorization",
    };
    const evaluated = evaluateAppSyncVtl(requestTemplate, context, 0);
    if (!evaluated.returned) requestDocument(evaluated);
  } catch (error) {
    throw new AwsError(
      "BadRequestException",
      error instanceof Error ? error.message : "The NONE resolver mapping templates are invalid.",
      400,
    );
  }
}

export function executeNoneResolver(
  requestTemplate: string,
  responseTemplate: string,
  context: NoneResolverContext,
  now = Date.now(),
): AppSyncVtlEvaluation {
  const requestEvaluation = evaluateAppSyncVtl(requestTemplate, context, now);
  if (requestEvaluation.returned) return requestEvaluation;
  const request = requestDocument(requestEvaluation);
  const payload = structuredClone(request.payload);
  const responseEvaluation = evaluateAppSyncVtl(responseTemplate, {
    ...context,
    result: payload,
    error: null,
  }, now);
  return {
    ...responseEvaluation,
    appendedErrors: [...requestEvaluation.appendedErrors, ...responseEvaluation.appendedErrors],
    logs: [...requestEvaluation.logs, ...responseEvaluation.logs],
  };
}
