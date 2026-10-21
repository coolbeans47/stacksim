import { parseCloudFormationTemplate, parseTemplateDocument, type CloudFormationTemplate } from "./template.js";

/** The AWS SAM transform, the only transform StackSim expands. */
export const SERVERLESS_TRANSFORM = "AWS::Serverless-2016-10-31";

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
 * The SAM resource types and the phase that implements each. A `null` phase
 * is a deliberate non-goal (sam-transform-design.md §2.3).
 */
const SERVERLESS_RESOURCE_PHASES: ReadonlyMap<string, string | null> = new Map([
  ["AWS::Serverless::Function", "SAM-02"],
  ["AWS::Serverless::Api", "SAM-02"],
  ["AWS::Serverless::HttpApi", "SAM-02"],
  ["AWS::Serverless::SimpleTable", "SAM-02"],
  ["AWS::Serverless::LayerVersion", "SAM-04"],
  ["AWS::Serverless::StateMachine", "SAM-04"],
  ["AWS::Serverless::Connector", "SAM-06"],
  ["AWS::Serverless::Application", null],
  ["AWS::Serverless::GraphQLApi", null],
  ["AWS::Serverless::WebSocketApi", null],
  ["AWS::Serverless::CapacityProvider", null],
  ["AWS::Serverless::MicrovmImage", null],
  ["AWS::Serverless::NetworkConnector", null],
  ["AWS::Serverless::WebFunction", null],
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

export interface TemplateTransformContext {
  readonly region: string;
  readonly partition: string;
  readonly accountId: string;
  readonly stackName?: string;
}

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

function serverlessFailure(errors: string[]): TemplateTransformError {
  return new TemplateTransformError(`Transform ${SERVERLESS_TRANSFORM} failed with: Invalid Serverless Application Specification document. Number of errors found: ${errors.length}. ${errors.join(" ")}`);
}

/**
 * Expand AWS::Serverless-2016-10-31. This is a pure function of the template
 * and context: it never reads S3 or other simulator state, and the same input
 * always yields the same output. SAM-01 implements the identity expansion for
 * templates without AWS::Serverless::* resources.
 */
export function expandServerlessTransform(document: Record<string, unknown>, _context: TemplateTransformContext): Record<string, unknown> {
  const errors: string[] = [];
  if (Object.hasOwn(document, "Globals")) errors.push("Structure of the SAM template is invalid. The Globals section is not supported by StackSim (owning phase: SAM-02).");
  const resources = isPlainObject(document.Resources) ? document.Resources : {};
  for (const [logicalId, resource] of Object.entries(resources)) {
    const type = isPlainObject(resource) ? resource.Type : undefined;
    if (typeof type !== "string" || !type.startsWith("AWS::Serverless::")) continue;
    const phase = SERVERLESS_RESOURCE_PHASES.get(type);
    errors.push(`Resource with id [${logicalId}] is invalid. Resource type ${type} is not supported by StackSim${phase ? ` (owning phase: ${phase})` : ""}.`);
  }
  if (errors.length) throw serverlessFailure(errors);
  const { Transform: _transform, ...processed } = document;
  return processed;
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
