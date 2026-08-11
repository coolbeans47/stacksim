import { expect, test } from "@playwright/test";
import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";

test("PSS-04 console links protected parameters and secrets to their owning stack", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss04-console-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off", cdkBootstrap: false });
  let cloudformation!: CloudFormationClient;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = new CloudFormationClient({ endpoint, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
    const template = { Resources: {
      Parameter: { Type: "AWS::SSM::Parameter", Properties: { Name: "/pss04/console", Type: "String", Value: "console-value" } },
      Secret: { Type: "AWS::SecretsManager::Secret", Properties: { Name: "pss04/console", GenerateSecretString: { PasswordLength: 20 } } },
      Policy: { Type: "AWS::SecretsManager::ResourcePolicy", Properties: { SecretId: { Ref: "Secret" }, BlockPublicPolicy: true, ResourcePolicy: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "secretsmanager:GetSecretValue", Resource: "*" }] } } },
    } };
    await cloudformation.send(new CreateStackCommand({ StackName: "pss04-console", TemplateBody: JSON.stringify(template) }));
    for (let attempt = 0; attempt < 200; attempt++) {
      const status = (await cloudformation.send(new DescribeStacksCommand({ StackName: "pss04-console" }))).Stacks?.[0]?.StackStatus;
      if (status === "CREATE_COMPLETE") break;
      expect(status).not.toMatch(/FAILED|ROLLBACK_COMPLETE/);
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    const consoleUrl = `${endpoint}/_stacksim/console`;
    await page.goto(`${consoleUrl}#/systems-manager/parameter-store`);
    await expect(page.getByRole("link", { name: "CloudFormation managed" })).toBeVisible();
    await page.getByRole("link", { name: "/pss04/console" }).click();
    await expect(page.getByText("This parameter is managed by CloudFormation.")).toBeVisible();
    await expect(page.getByRole("link", { name: "View owning stack" })).toHaveAttribute("href", "#/cloudformation/stacks/pss04-console/resources");
    await expect(page.getByRole("button", { name: "Edit value" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

    await page.goto(`${consoleUrl}#/secrets-manager/secrets`);
    await expect(page.getByRole("link", { name: "CloudFormation managed" })).toBeVisible();
    await page.getByRole("link", { name: "pss04/console" }).click();
    await expect(page.getByText("This secret is managed by CloudFormation.")).toBeVisible();
    await expect(page.getByRole("link", { name: "View owning stack" })).toHaveAttribute("href", "#/cloudformation/stacks/pss04-console/resources");
    await expect(page.getByRole("button", { name: "Edit secret" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Schedule deletion" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit policy" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit tags" })).toHaveCount(0);
  } finally {
    cloudformation?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
