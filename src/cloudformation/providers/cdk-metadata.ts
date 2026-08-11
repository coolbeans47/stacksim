import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderSuccess,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";

export interface CdkMetadataModel {
  readonly Analytics?: string;
}

export const CDK_METADATA_TYPE = "AWS::CDK::Metadata";

export const CDK_METADATA_SCHEMA: ProviderSchema = Object.freeze({
  typeName: CDK_METADATA_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Analytics: Object.freeze({
      valueType: "string",
      updateBehavior: "MUTABLE",
      description: "Opaque analytics payload emitted by the AWS CDK synthesizer.",
    }),
  }),
  ref: Object.freeze({ supported: false, description: "AWS::CDK::Metadata has no supported Ref contract." }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: Object.freeze({
    deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    snapshotSupported: false,
  }),
  tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});

function physicalId(context: ProviderContext): string {
  return `${context.stackId}/${context.logicalId}`;
}

function readModel(id: string, properties: CdkMetadataModel): ProviderReadModel<CdkMetadataModel> {
  return { physicalId: id, properties, attributes: {} };
}

function success(id: string, properties: CdkMetadataModel): ProviderSuccess<CdkMetadataModel> {
  return { status: "SUCCESS", physicalId: id, model: readModel(id, properties) };
}

function same(left: CdkMetadataModel, right: CdkMetadataModel): boolean {
  return left.Analytics === right.Analytics;
}

/** Owned stack metadata only; it intentionally creates no backing service resource. */
export const cdkMetadataProvider: ProductionResourceProvider<CdkMetadataModel> = Object.freeze({
  typeName: CDK_METADATA_TYPE,
  providerVersion: 1,
  visibility: "production",
  schema: CDK_METADATA_SCHEMA,

  validate(properties: unknown, _context: ProviderContext): readonly ProviderValidationIssue[] {
    return validateDeclaredProperties(properties ?? {}, CDK_METADATA_SCHEMA);
  },

  canonicalize(properties: unknown, _context: ProviderContext): CdkMetadataModel {
    if (properties === undefined) return Object.freeze({});
    if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
      throw new TypeError(`${CDK_METADATA_TYPE} Properties must be an object`);
    }
    const analytics = (properties as Record<string, unknown>).Analytics;
    if (analytics !== undefined && typeof analytics !== "string") {
      throw new TypeError(`${CDK_METADATA_TYPE} property Analytics must be string`);
    }
    return Object.freeze(analytics === undefined ? {} : { Analytics: analytics as string });
  },

  plan(previous: CdkMetadataModel | undefined, desired: CdkMetadataModel, _context: ProviderContext): ProviderPlan<CdkMetadataModel> {
    if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
    if (same(previous, desired)) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
    return { action: "UPDATE", desired, changedProperties: ["Analytics"], replacementProperties: [] };
  },

  async create(desired: CdkMetadataModel, context: ProviderContext): Promise<ProviderSuccess<CdkMetadataModel>> {
    const id = physicalId(context);
    return success(id, desired);
  },

  async read(id: string, context: ProviderContext): Promise<ProviderReadResult<CdkMetadataModel>> {
    if (id !== physicalId(context)) return { status: "NOT_FOUND", physicalId: id, message: "Metadata ownership identity does not match this stack resource" };
    return success(id, {});
  },

  async update(id: string, _previous: CdkMetadataModel, desired: CdkMetadataModel, context: ProviderContext): Promise<ProviderUpdateResult<CdkMetadataModel>> {
    if (id !== physicalId(context)) {
      return { status: "FAILED", errorCode: "NotFound", message: "Metadata ownership identity does not match this stack resource" };
    }
    return success(id, desired);
  },

  async delete(id: string, _previous: CdkMetadataModel, _context: ProviderContext): Promise<ProviderDeleteResult> {
    return { status: "SUCCESS", physicalId: id };
  },

  ref(_model: ProviderReadModel<CdkMetadataModel>): never {
    throw new ProviderReferenceError(CDK_METADATA_TYPE, "Ref");
  },

  getAtt(_model: ProviderReadModel<CdkMetadataModel>, attribute: string): never {
    throw new ProviderReferenceError(CDK_METADATA_TYPE, `Fn::GetAtt ${attribute}`);
  },
});
