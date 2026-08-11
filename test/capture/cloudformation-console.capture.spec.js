import { test } from "@playwright/test";
import { captureCloudFormationConsole } from "../../scripts/capture-cloudformation.mjs";

test("captures real-server CloudFormation CFN-01 through CFN-08 evidence", async ({ browser }) => {
  await captureCloudFormationConsole(browser);
});
