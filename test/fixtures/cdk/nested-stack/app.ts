import { App, CfnOutput, CfnResource, NestedStack, Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

class LeafStack extends NestedStack {
  readonly ready: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    new CfnResource(this, "Metadata", {
      type: "AWS::CDK::Metadata",
      properties: { Analytics: "nested-leaf" },
    });
    this.ready = new CfnOutput(this, "Ready", { value: "ready" }).value;
  }
}

class ChildStack extends NestedStack {
  readonly ready: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    const leaf = new LeafStack(this, "Leaf");
    this.ready = new CfnOutput(this, "Ready", { value: leaf.ready }).value;
  }
}

const app = new App();
const root = new Stack(app, "NestedRoot", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: "Unmodified two-level CDK NestedStack acceptance fixture",
});
const child = new ChildStack(root, "Child");
new CfnOutput(root, "Ready", { value: child.ready });
