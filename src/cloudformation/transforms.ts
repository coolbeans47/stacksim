import { SERVERLESS_TRANSFORM, expandServerlessTransform, type ServerlessExpansionContext } from "./sam/index.js";
import { parseCloudFormationTemplate, parseTemplateDocument, type CloudFormationTemplate } from "./template.js";

/** The AWS SAM transform, the only transform StackSim expands. */
export { SERVERLESS_TRANSFORM, ServerlessTransformError, expandServerlessTransform } from "./sam/index.js";

/** AWS-hosted transforms that exist in AWS but are outside StackSim. */
const UNSUPPORTED_AWS_TRANSFORMS = new Set([
  "AWS::Include",
  "AWS::LanguageExtensions",
  "AWS::CodeDeployBlueGreen",
  "AWS::SecretsManager-2020-07-23",
  "AWS::SecretsManager-2024-09-16",
  "AWS::ServiceCatalog",
]);

/**
 * A transform admission or expansion failure. The message is already in the
 * public AWS shape, so it carries no template path suffix.
 */
export class TemplateTransformError extends Error {
  readonly code = "ValidationError" as const;

  constructor(message: string) {
    super(message);
    this.name = "TemplateTransformError";
  }
}

export type TemplateTransformContext = ServerlessExpansionContext;

export interface PreparedCloudFormationTemplate {
  /** The structurally validated template after every declared transform. */
  readonly template: CloudFormationTemplate;
  /** The declared transforms, reported as DeclaredTransforms. */
  readonly transforms: string[];
  /** The transform output as JSON, present only when transforms were declared. */
  readonly transformedBody?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function partitionForRegion(region: string): string {
  if (region.startsWith("cn-")) return "aws-cn";
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  return "aws";
}

/** Validate the Transform section and return the declared transform names. */
export function declaredTransforms(document: unknown): string[] {
  if (!isPlainObject(document) || !Object.hasOwn(document, "Transform")) return [];
  const raw = document.Transform;
  const entries = Array.isArray(raw) ? raw : [raw];
  if (entries.length === 0) throw new TemplateTransformError("Transform must name at least one transform");
  const names: string[] = [];
  for (const entry of entries) {
    // AWS::Include may be declared at the top level as { Name, Parameters }.
    const name = isPlainObject(entry) && typeof entry.Name === "string" ? entry.Name : entry;
    if (typeof name !== "string" || name.length === 0) throw new TemplateTransformError("Transform must be a transform name or a list of transform names");
    if (names.includes(name)) throw new TemplateTransformError(`Transform ${name} is declared more than once`);
    if (UNSUPPORTED_AWS_TRANSFORMS.has(name)) throw new TemplateTransformError(`Transform ${name} is not supported by StackSim`);
    if (name !== SERVERLESS_TRANSFORM) throw new TemplateTransformError(`No transform named ${name} found.`);
    if (isPlainObject(entry)) throw new TemplateTransformError(`Transform ${name} does not accept parameters`);
    names.push(name);
  }
  return names;
}

/**
 * Parse a template body, admit and expand its transforms, and validate the
 * processed template. Every failure happens before any stack mutation.
 */
export function prepareCloudFormationTemplate(body: string, context: TemplateTransformContext): PreparedCloudFormationTemplate {
  const document = parseTemplateDocument(body);
  const transforms = declaredTransforms(document);
  if (transforms.length === 0) return { template: parseCloudFormationTemplate(document), transforms };
  let processed = document as Record<string, unknown>;
  for (const name of transforms) if (name === SERVERLESS_TRANSFORM) processed = expandServerlessTransform(processed, context);
  return { template: parseCloudFormationTemplate(processed), transforms, transformedBody: JSON.stringify(processed) };
}
