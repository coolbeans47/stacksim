import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  DescribeUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, projectRoot } from "./config.mjs";

export async function checkCognito() {
  const config = await loadConfig();
  const deployment = JSON.parse(await readFile(join(projectRoot, ".runtime", "deployment.json"), "utf8"));
  const { userPoolId, appClientId, issuer } = deployment.cognito ?? {};
  if (!userPoolId || !appClientId || !issuer) throw new Error("Deploy the Sprint Planner before checking its Cognito resources");
  const jwksUrl = `${config.controlPlaneEndpoint}/_stacksim/cognito-idp/${config.region}/${userPoolId}/.well-known/jwks.json`;
  const client = new CognitoIdentityProviderClient({
    region: config.region,
    endpoint: config.controlPlaneEndpoint,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "admin",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "password",
    },
  });
  const [poolResult, clientResult, jwksResponse] = await Promise.all([
    client.send(new DescribeUserPoolCommand({ UserPoolId: userPoolId })),
    client.send(new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: appClientId })),
    fetch(jwksUrl, { headers: { accept: "application/json" } }),
  ]);
  const pool = poolResult.UserPool;
  const appClient = clientResult.UserPoolClient;
  const failures = [];
  if (!pool) failures.push("DescribeUserPool returned no pool");
  if (!appClient) failures.push("DescribeUserPoolClient returned no client");
  if (!pool?.UsernameAttributes?.includes("email")) failures.push("UsernameAttributes must include email");
  if (!pool?.AutoVerifiedAttributes?.includes("email")) failures.push("AutoVerifiedAttributes must include email");
  if (pool?.AdminCreateUserConfig?.AllowAdminCreateUserOnly !== false) failures.push("self-signup must be enabled");
  if (pool?.UsernameConfiguration?.CaseSensitive !== false) failures.push("email usernames must be case-insensitive");
  if (appClient?.ClientSecret) failures.push("the browser app client must not have a secret");
  const flows = new Set(appClient?.ExplicitAuthFlows ?? []);
  if (!flows.has("ALLOW_USER_PASSWORD_AUTH")) failures.push("ALLOW_USER_PASSWORD_AUTH must be enabled");
  if (!flows.has("ALLOW_REFRESH_TOKEN_AUTH")) failures.push("ALLOW_REFRESH_TOKEN_AUTH must be enabled");
  if (!jwksResponse.ok) failures.push(`local JWKS returned HTTP ${jwksResponse.status}`);
  else {
    const jwks = await jwksResponse.json();
    if (!Array.isArray(jwks.keys) || jwks.keys.length < 2 || jwks.keys.some(key => key.kty !== "RSA" || key.d)) {
      failures.push("local JWKS does not contain the expected public signing keys");
    }
  }
  client.destroy();
  if (failures.length) throw new Error(`Cognito preflight failed:\n- ${failures.join("\n- ")}`);
  return {
    userPoolId,
    appClientId,
    issuer,
    sameOrigin: new URL(config.controlPlaneEndpoint).origin,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkCognito()
    .then(result => console.log(`Cognito preflight passed for ${result.userPoolId} (${result.issuer}).`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
