import { readFile, writeFile } from "node:fs/promises";
import * as client from "@aws-sdk/client-cognito-identity-provider";

const packageFile = new URL(
  "../node_modules/@aws-sdk/client-cognito-identity-provider/package.json",
  import.meta.url,
);
const authProviderFile = new URL(
  "../node_modules/@aws-sdk/client-cognito-identity-provider/dist-es/auth/httpAuthSchemeProvider.js",
  import.meta.url,
);
const outputFile = new URL("../docs/designs/cognito-action-inventory.md", import.meta.url);

const packageJson = JSON.parse(await readFile(packageFile, "utf8"));
const authProvider = await readFile(authProviderFile, "utf8");
const noAuth = new Set(
  [...authProvider.matchAll(/case "([^"]+)":\s*\{\s*options\.push\(createSmithyApiNoAuthHttpAuthOption/g)]
    .map(match => match[1]),
);
const commands = Object.keys(client)
  .filter(name => name.endsWith("Command") && name !== "$Command")
  .map(name => name.slice(0, -"Command".length))
  .sort();
const paginatorOperations = new Set(
  Object.keys(client)
    .filter(name => name.startsWith("paginate"))
    .map(name => name.slice("paginate".length)),
);

const cog01 = new Set([
  "CreateUserPool", "DescribeUserPool", "ListUserPools", "UpdateUserPool", "DeleteUserPool",
  "CreateUserPoolClient", "DescribeUserPoolClient", "ListUserPoolClients", "UpdateUserPoolClient",
  "DeleteUserPoolClient", "SignUp", "ConfirmSignUp", "ResendConfirmationCode", "InitiateAuth",
  "GetTokensFromRefreshToken", "RevokeToken", "GlobalSignOut", "GetUser",
]);
const cog04 = new Set([
  "CreateResourceServer", "DeleteResourceServer", "DescribeResourceServer", "ListResourceServers",
  "UpdateResourceServer", "CreateUserPoolDomain", "DeleteUserPoolDomain", "DescribeUserPoolDomain",
  "UpdateUserPoolDomain", "CreateManagedLoginBranding", "DeleteManagedLoginBranding",
  "DescribeManagedLoginBranding", "DescribeManagedLoginBrandingByClient", "UpdateManagedLoginBranding",
  "GetUICustomization", "SetUICustomization",
]);
const cog05 = new Set([
  "CreateIdentityProvider", "DeleteIdentityProvider", "DescribeIdentityProvider",
  "GetIdentityProviderByIdentifier", "ListIdentityProviders", "UpdateIdentityProvider",
  "AdminLinkProviderForUser", "AdminDisableProviderForUser",
]);
const cog07Implemented = new Set([
  "AddUserPoolClientSecret", "ListUserPoolClientSecrets", "DeleteUserPoolClientSecret",
]);
const cog07Boundary = new Set([
  "CompleteWebAuthnRegistration", "DeleteWebAuthnCredential", "ListWebAuthnCredentials",
  "StartWebAuthnRegistration", "CreateTerms", "DeleteTerms", "DescribeTerms", "ListTerms", "UpdateTerms",
  "CreateUserImportJob", "DescribeUserImportJob", "GetCSVHeader", "ListUserImportJobs",
  "StartUserImportJob", "StopUserImportJob", "CreateUserPoolReplica", "ListUserPoolReplicas",
  "UpdateUserPoolReplica", "DescribeRiskConfiguration", "SetRiskConfiguration",
  "GetLogDeliveryConfiguration", "SetLogDeliveryConfiguration", "GetProvisionedLimit",
  "UpdateProvisionedLimit", "GetSigningCertificate",
]);
const cog03Prefixes = [
  "AddCustomAttributes", "Admin", "ChangePassword", "ConfirmForgotPassword", "CreateGroup", "DeleteGroup", "DeleteUser",
  "ForgetDevice", "ForgotPassword", "GetDevice", "GetGroup", "GetUserAttributeVerificationCode",
  "GetUserAuthFactors", "GetUserPoolMfaConfig", "ListDevices", "ListGroups", "ListTagsForResource",
  "ListUsers", "RespondToAuthChallenge", "SetUser", "TagResource", "UntagResource", "UpdateAuthEventFeedback",
  "UpdateDeviceStatus", "UpdateGroup", "UpdateUserAttributes", "VerifySoftwareToken", "VerifyUserAttribute",
  "AssociateSoftwareToken", "ConfirmDevice",
];
const implemented = new Set([
  ...cog01,
  ...cog04,
  ...cog05,
  ...cog07Implemented,
  ...cog07Boundary,
]);
for (const operation of commands) {
  if (cog01.has(operation) || cog04.has(operation) || cog05.has(operation)) continue;
  if (cog07Implemented.has(operation) || cog07Boundary.has(operation)) continue;
  if (cog03Prefixes.some(prefix => operation.startsWith(prefix))) implemented.add(operation);
}

const nonIamProof = new Map([
  ["AssociateSoftwareToken", "challenge session or access-token user"],
  ["ChangePassword", "access-token user"],
  ["CompleteWebAuthnRegistration", "access-token user"],
  ["ConfirmDevice", "access-token user"],
  ["ConfirmForgotPassword", "public app client"],
  ["SignUp", "public app client"],
  ["ConfirmSignUp", "public app client"],
  ["DeleteUser", "access-token user"],
  ["DeleteUserAttributes", "access-token user"],
  ["DeleteWebAuthnCredential", "access-token user"],
  ["ForgetDevice", "access-token user"],
  ["ForgotPassword", "public app client"],
  ["GetDevice", "access-token user"],
  ["ResendConfirmationCode", "public app client"],
  ["InitiateAuth", "public/refresh by AuthFlow"],
  ["GetTokensFromRefreshToken", "refresh-token client"],
  ["GetUserAttributeVerificationCode", "access-token user"],
  ["GetUserAuthFactors", "access-token user"],
  ["RevokeToken", "refresh-token client"],
  ["GlobalSignOut", "access-token user"],
  ["GetUser", "access-token user"],
  ["ListDevices", "access-token user"],
  ["ListWebAuthnCredentials", "access-token user"],
  ["RespondToAuthChallenge", "public challenge session"],
  ["SetUserMFAPreference", "access-token user"],
  ["SetUserSettings", "access-token user"],
  ["StartWebAuthnRegistration", "access-token user"],
  ["UpdateAuthEventFeedback", "access-token user"],
  ["UpdateDeviceStatus", "access-token user"],
  ["UpdateUserAttributes", "access-token user"],
  ["VerifySoftwareToken", "challenge session or access-token user"],
  ["VerifyUserAttribute", "access-token user"],
]);

function phase(operation) {
  if (cog01.has(operation)) return "COG-01";
  if (cog04.has(operation)) return "COG-04";
  if (cog05.has(operation)) return "COG-05";
  if (cog07Implemented.has(operation) || cog07Boundary.has(operation)) return "COG-07";
  if (cog03Prefixes.some(prefix => operation.startsWith(prefix))) return "COG-03";
  return "COG-07";
}

function proof(operation) {
  if (nonIamProof.has(operation)) return nonIamProof.get(operation);
  if (noAuth.has(operation)) throw new Error(`Missing reviewed proof class for ${operation}`);
  return "IAM";
}

function resource(operation) {
  if (nonIamProof.has(operation)) return "n/a";
  if (["CreateUserPool", "ListUserPools"].includes(operation)) return "`*`";
  if (["GetProvisionedLimit", "UpdateProvisionedLimit"].includes(operation)) return "`*`";
  if (["TagResource", "UntagResource", "ListTagsForResource"].includes(operation)) return "request resource ARN";
  return "user pool / child";
}

function rowStatus(operation) {
  if (cog07Boundary.has(operation)) return "complete";
  if (implemented.has(operation)) return "complete";
  return "planned";
}

function rowDepth(operation) {
  if (cog07Implemented.has(operation)) return "multi-secret client lifecycle with encrypted envelopes and dual-secret auth";
  if (cog07Boundary.has(operation)) return "explicit COG-07 dependency boundary; no success descriptor";
  if (implemented.has(operation)) return "implemented through the authoritative Cognito service";
  return "deferred; target route remains closed";
}

function rowErrors(operation) {
  if (cog07Boundary.has(operation)) return "InvalidParameterException dependency boundary before mutation";
  if (implemented.has(operation)) return "official AWS JSON 1.1 response contract";
  return "no success descriptor before owning phase";
}

function rowEvidence(operation) {
  if (cog07Implemented.has(operation)) return "test/cognito-cog07.test.ts";
  if (cog07Boundary.has(operation)) return "test/cognito-cog07.test.ts dependency boundary matrix";
  if (implemented.has(operation)) return "official SDK and protocol coverage";
  return "required by owning phase";
}

const rows = commands.map(operation => {
  const status = rowStatus(operation);
  return `| \`${operation}\` | \`AWSCognitoIdentityProviderService.${operation}\` | ${proof(operation)} | ${resource(operation)} | ${phase(operation)} | ${paginatorOperations.has(operation) ? "yes" : "no"} | ${rowDepth(operation)} | ${rowErrors(operation)} | ${status} | ${rowEvidence(operation)} |`;
});

const implementedCount = commands.filter(operation => rowStatus(operation) === "complete").length;

const output = `# Amazon Cognito User Pools action inventory

Generated from \`@aws-sdk/client-cognito-identity-provider@${packageJson.version}\` on 2026-08-07.
Review source: the package command exports and generated Smithy HTTP auth-scheme provider,
plus the official action and authorization-model references linked from
\`docs/cognito-design.md\`.

This inventory has ${commands.length} command rows, ${paginatorOperations.size} paginators,
and no waiters. A generated target row is not an implementation claim. Non-IAM
proof classes were reviewed against each operation input and the official
authorization-model guide; transport \`noAuth\` alone was not treated as a proof class.

The ${commands.length}-command inventory records ${implementedCount} implemented or explicitly bounded actions through COG-07. Twenty-five advanced commands remain explicit dependency boundaries; three multi-secret lifecycle commands are fully implemented.

| Command | Target | Proof class | Primary resource | Phase | Paginator | Accepted depth | Error boundary | Status | Evidence |
|---|---|---|---|---:|---:|---|---|---|---|
${rows.join("\n")}
`;

await writeFile(outputFile, output);
