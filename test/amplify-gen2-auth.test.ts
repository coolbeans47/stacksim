import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("AMX-14 exact Auth fixtures through unchanged CLI and real clients", { concurrency: 3, timeout: 600_000 }, async context => {
  await Promise.all(["amplify-gen2-auth-email", "amplify-gen2-auth-data-owner", "amplify-gen2-auth-data-iam"].map(fixture => context.test(`${fixture}: lifecycle and local endpoints`, { timeout: 600_000 }, async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
      const child = spawn(process.execPath, [resolve("scripts/verify-amplify-auth.mjs"), fixture, "--lifecycle"], {
        cwd: resolve("."), env: process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", fail); child.once("close", code => done({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr.slice(-10_000));
    const evidence = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    for (const key of ["deployed", "repeat", "update", "rollback", "twoSandboxes", "delete", "cleanup"]) assert.equal(evidence[key], true, key);
    assert.equal(evidence.outputVersion, "1.5");
    assert.equal(evidence.firstStale.staleOutputsRejected, true);
    assert.equal(evidence.secondStale.staleOutputsRejected, true);
    for (const client of [evidence.client, evidence.rollbackClient, evidence.secondClient, evidence.restartClient, evidence.firstAfterSecondDelete]) {
      for (const key of ["endpointOverrides", "guest", "srpSignIn", "confirmSignUp", "refresh", "localSignOut"]) assert.equal(client[key], true, key);
      assert.ok(client.clientRequests.some((call: any) => call.path === "/_stacksim/cognito-idp/eu-west-1/sdk"));
      assert.ok(client.clientRequests.some((call: any) => call.path === "/_stacksim/cognito-identity/eu-west-1/sdk"));
      assert.ok(client.clientRequests.every((call: any) => /^\/(?:_stacksim\/cognito-(?:idp|identity)\/eu-west-1\/sdk|graphql\/eu-west-1\/)/.test(call.path)));
      if (fixture.endsWith("owner")) {
        for (const key of ["ownerCrud", "ownerSpoofDenied", "ownerPagination", "ownerRealtime", "userSwitch"]) assert.equal(client[key], true, key);
        assert.ok(client.clientRequests.some((call: any) => call.tokenUse === "access"));
        assert.equal(client.clientRequests.some((call: any) => call.tokenUse === "id"), false);
      }
      if (fixture.endsWith("iam")) {
        for (const key of ["iamData", "sameSessionSigning", "guestDataDenied", "guestIdentityPromoted", "signOutGuestFallback", "priorCredentialsRetainValidity", "returningGuestLogin"]) assert.equal(client[key], true, key);
      }
    }
    if (fixture.endsWith("iam")) assert.equal(evidence.secondClient.adjacentResourceDenied, true);
    assert.doesNotMatch(result.stdout, /eyJ[A-Za-z0-9_-]+\.eyJ|ASIA[0-9A-Z]{16}|Local-learning-password|SecretKey|SessionToken/);
    // Optional local capture for the reviewed capability closeout; ordinary
    // focused tests keep no persistent client output.
    if (process.env.STACKSIM_AUTH_EVIDENCE_DIRECTORY) {
      const directory = resolve(process.env.STACKSIM_AUTH_EVIDENCE_DIRECTORY);
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, `${fixture}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    }
  })));
});
