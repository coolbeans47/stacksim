import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStackEventsCommand, DescribeStacksCommand, UpdateStackCommand } from "@aws-sdk/client-cloudformation";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateActivityCommand, CreateStateMachineCommand, DeleteActivityCommand, DeleteStateMachineCommand, DescribeActivityCommand, DescribeStateMachineCommand, ListTagsForResourceCommand, SFNClient } from "@aws-sdk/client-sfn";
import { StackSim } from "../src/server.js";

const region = "eu-west-1", accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const definition = JSON.stringify({ StartAt: "Done", States: { Done: { Type: "Succeed" } } });
const trust = (service: string) => ({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }] });

for (const kind of ["Activity", "StateMachine"] as const) for (const replacement of [false, true]) {
  test(`SFN-04 ${kind} ${replacement ? "replacement" : "create"} compensation preserves a recreated generation when authorization fails before provider replay`, async () => {
    const root = await mkdtemp(join(tmpdir(), "stacksim-sfn-provisional-"));
    let sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, accountId, region, authMode: "enforce", cdkBootstrap: false });
    const clients: Array<{ destroy(): void }> = [];
    try {
      await sim.start();
      const options = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 };
      const cfn = new CloudFormationClient(options), iam = new IAMClient(options), sfn = new SFNClient(options); clients.push(cfn, iam, sfn);
      const RoleARN = (await iam.send(new CreateRoleCommand({ RoleName: "deployer", AssumeRolePolicyDocument: JSON.stringify(trust("cloudformation.amazonaws.com")) }))).Role!.Arn!;
      const policy = (deny = false) => iam.send(new PutRolePolicyCommand({ RoleName: "deployer", PolicyName: "deployment", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }, ...(deny ? [{ Effect: "Deny", Action: `states:Create${kind}`, Resource: "*" }] : [])] }) }));
      await policy();
      const template = (name: string) => JSON.stringify({ Resources: {
        ...(kind === "StateMachine" ? { WorkRole: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: trust("states.amazonaws.com") } } } : {}),
        Workflow: { Type: `AWS::StepFunctions::${kind}`, Properties: kind === "Activity" ? { Name: name } : { StateMachineName: name, DefinitionString: definition, RoleArn: { "Fn::GetAtt": ["WorkRole", "Arn"] } } },
      } });
      let stackIdentifier = "Provisional";
      const wait = async (expected: string) => {
        for (let i = 0; i < 300; i++) {
          const result = (await cfn.send(new DescribeStacksCommand({ StackName: stackIdentifier }))).Stacks![0];
          stackIdentifier = result.StackId!;
          if (result.StackStatus === expected) return;
          if (!result.StackStatus?.endsWith("IN_PROGRESS")) throw new Error(`Expected ${expected}, got ${result.StackStatus}: ${JSON.stringify((await cfn.send(new DescribeStackEventsCommand({ StackName: "Provisional" }))).StackEvents)}`);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error(`Timed out waiting for ${expected}`);
      };
      const stackInput = { StackName: "Provisional", RoleARN, Capabilities: ["CAPABILITY_IAM" as const] };
      if (replacement) { await cfn.send(new CreateStackCommand({ ...stackInput, TemplateBody: template("original") })); await wait("CREATE_COMPLETE"); }
      let paused = false;
      sim.cloudformation.setCheckpointInterceptorForTest(value => {
        if (value.checkpoint === `provider:Workflow:${replacement ? "replace-create" : "create"}:attempt-1`) { paused = true; return true; }
        return false;
      });
      if (replacement) await cfn.send(new UpdateStackCommand({ ...stackInput, TemplateBody: template("provisional") }));
      else await cfn.send(new CreateStackCommand({ ...stackInput, TemplateBody: template("provisional") }));
      for (let i = 0; !paused && i < 300; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert(paused, "provider creation must pause with a durable generation reference");
      const resourceArn = `arn:aws:states:${region}:${accountId}:${kind === "Activity" ? "activity" : "stateMachine"}:provisional`;
      const tags = (await sfn.send(new ListTagsForResourceCommand({ resourceArn }))).tags;
      const oldGeneration = sim.stepfunctions.cloudFormationResourceGeneration(resourceArn);
      if (kind === "Activity") {
        await sfn.send(new DeleteActivityCommand({ activityArn: resourceArn }));
        await sfn.send(new CreateActivityCommand({ name: "provisional", tags }));
      } else {
        const prior = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: resourceArn }));
        await sfn.send(new DeleteStateMachineCommand({ stateMachineArn: resourceArn }));
        await sfn.send(new CreateStateMachineCommand({ name: "provisional", roleArn: prior.roleArn, definition, tags }));
      }
      const newGeneration = sim.stepfunctions.cloudFormationResourceGeneration(resourceArn);
      assert.notEqual(newGeneration, oldGeneration);
      // Force failure in authorization before create's generation guard runs.
      // Compensation must use the persisted provisional identity instead.
      await policy(true);
      const port = sim.port; await sim.stop();
      sim = new StackSim({ dataDir: root, port, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, accountId, region, authMode: "enforce", cdkBootstrap: false }); await sim.start();
      await wait(replacement ? "UPDATE_ROLLBACK_COMPLETE" : "ROLLBACK_COMPLETE");
      assert.equal(sim.stepfunctions.cloudFormationResourceGeneration(resourceArn), newGeneration);
      if (kind === "Activity") await sfn.send(new DescribeActivityCommand({ activityArn: resourceArn }));
      else await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: resourceArn }));
      const events = (await cfn.send(new DescribeStackEventsCommand({ StackName: "Provisional" }))).StackEvents;
      assert(events?.some(event => /not authorized.*Create/.test(event.ResourceStatusReason ?? "")));
      await policy(); await cfn.send(new DeleteStackCommand({ StackName: "Provisional", RoleARN })); await wait("DELETE_COMPLETE");
      if (kind === "Activity") await sfn.send(new DeleteActivityCommand({ activityArn: resourceArn }));
      else await sfn.send(new DeleteStateMachineCommand({ stateMachineArn: resourceArn }));
    } finally { clients.forEach(client => client.destroy()); await sim.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
  });
}
