import { readdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as client from "@aws-sdk/client-cognito-identity-provider";

// Usage: node scripts/generate-cognito-action-inventory.mjs [--sdk-dir <unpacked package root>] [--out <file>]
// --sdk-dir reads a newer @aws-sdk/client-cognito-identity-provider from its type declarations and
// generated auth-scheme source as text; nothing from that package is executed.
const argument = name => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const sdkDir = argument("--sdk-dir");
const packageRoot = sdkDir
  ? pathToFileURL(`${sdkDir.replace(/[\\/]$/, "")}/`)
  : new URL("../node_modules/@aws-sdk/client-cognito-identity-provider/", import.meta.url);
const packageFile = new URL("package.json", packageRoot);
const authProviderFile = new URL("dist-es/auth/httpAuthSchemeProvider.js", packageRoot);
const outputFile = argument("--out")
  ? pathToFileURL(argument("--out"))
  : new URL("../docs/designs/cognito-action-inventory.md", import.meta.url);

const packageJson = JSON.parse(await readFile(packageFile, "utf8"));
const authProvider = await readFile(authProviderFile, "utf8");
const noAuth = new Set(
  [...authProvider.matchAll(/case "([^"]+)":\s*\{\s*options\.push\(createSmithyApiNoAuthHttpAuthOption/g)]
    .map(match => match[1]),
);
const commands = sdkDir
  ? (await readdir(new URL("dist-types/commands/", packageRoot)))
      .filter(name => name.endsWith("Command.d.ts"))
      .map(name => name.slice(0, -"Command.d.ts".length))
      .sort()
  : Object.keys(client)
      .filter(name => name.endsWith("Command") && name !== "$Command")
      .map(name => name.slice(0, -"Command".length))
      .sort();
const paginatorOperations = new Set(sdkDir
  ? (await readdir(new URL("dist-types/pagination/", packageRoot)))
      .filter(name => name.endsWith("Paginator.d.ts"))
      .map(name => name.slice(0, -"Paginator.d.ts".length))
  : Object.keys(client)
      .filter(name => name.startsWith("paginate"))
      .map(name => name.slice("paginate".length)));
const pinnedCommands = new Set(Object.keys(client)
  .filter(name => name.endsWith("Command") && name !== "$Command")
  .map(name => name.slice(0, -"Command".length)));

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
// Added to the API after the pinned SDK; routed as named boundaries in COG-09 (2026-10-30 review).
const cog09Boundary = new Map([
  ["AdminDeleteSoftwareToken", "admin-auth-factors"],
  ["AdminGetUserAuthFactors", "admin-auth-factors"],
  ["DescribeTermsByClient", "managed-login-terms"],
  ["GetClientToken", "client-token-auth"],
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
  if (cog09Boundary.has(operation)) continue;
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
  ["GetClientToken", "public app client (client secret)"],
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
  if (cog09Boundary.has(operation)) return "COG-09";
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
  if (cog07Boundary.has(operation) || cog09Boundary.has(operation)) return "complete";
  if (implemented.has(operation)) return "complete";
  return "planned";
}

const depthNotes = new Map([
  ["DeleteUserPoolReplica", "modeled no-replica `ResourceNotFoundException` (replicas are a named boundary)"],
  ["AdminListUserAuthEvents", "local operation; on AWS needs Plus with threat protection, else `UserPoolAddOnNotEnabledException`"],
  ["AdminUpdateAuthEventFeedback", "local operation; on AWS needs Plus with threat protection, else `UserPoolAddOnNotEnabledException`"],
  ["UpdateAuthEventFeedback", "local operation; on AWS needs Plus with threat protection, else `UserPoolAddOnNotEnabledException`"],
  ["InitiateAuth", "password, SRP, refresh, and `USER_AUTH` (PASSWORD, PASSWORD_SRP, EMAIL_OTP, SELECT_CHALLENGE) since COG-08; `CUSTOM_AUTH` is a named boundary"],
  ["AdminInitiateAuth", "ADMIN_USER_PASSWORD_AUTH/ADMIN_NO_SRP_AUTH, USER_SRP_AUTH, refresh, and `USER_AUTH` since COG-09"],
  ["GetUserAuthFactors", "Username, PreferredMfaSetting, UserMFASettingList, ConfiguredUserAuthFactors since COG-09"],
  ["ListUsers", "ten documented filter attributes and AttributesToGet since COG-09"],
  ["CreateManagedLoginBranding", "stores settings; only title and primary colour are rendered"],
  ["UpdateManagedLoginBranding", "stores settings; only title and primary colour are rendered"],
]);

function rowDepth(operation) {
  if (cog09Boundary.has(operation)) return `explicit \`${cog09Boundary.get(operation)}\` boundary; added to the API after the pinned SDK`;
  if (depthNotes.has(operation)) return depthNotes.get(operation);
  if (cog07Implemented.has(operation)) return "multi-secret client lifecycle with encrypted envelopes and dual-secret auth";
  if (cog07Boundary.has(operation)) return "explicit COG-07 dependency boundary; no success descriptor";
  if (implemented.has(operation)) return "implemented through the authoritative Cognito service";
  return "deferred; target route remains closed";
}

function rowErrors(operation) {
  if (cog07Boundary.has(operation) || cog09Boundary.has(operation)) return "InvalidParameterException dependency boundary before mutation";
  if (implemented.has(operation)) return "official AWS JSON 1.1 response contract";
  return "no success descriptor before owning phase";
}

function rowEvidence(operation) {
  if (cog09Boundary.has(operation)) return "test/cognito-action-inventory.test.ts; test/cognito-review-2026-10-30.test.ts";
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
const boundedCount = commands.filter(operation => cog07Boundary.has(operation) || cog09Boundary.has(operation)).length;
const unpinned = commands.filter(operation => !pinnedCommands.has(operation));

const output = `# Amazon Cognito User Pools action inventory

Generated from \`@aws-sdk/client-cognito-identity-provider@${packageJson.version}\` on 2026-10-30 by
\`scripts/generate-cognito-action-inventory.mjs\`${sdkDir ? " (read from the unpacked package's type declarations)" : ""}.
The repository pin is \`3.1094.0\`; ${unpinned.length ? `${unpinned.map(operation => `\`${operation}\``).join(", ")} ${unpinned.length === 1 ? "is" : "are"} newer than the pin and reachable only by raw requests or a newer SDK` : "every row is exported by the pin"}.
\`test/cognito-action-inventory.test.ts\` asserts that \`src/cognito/action-inventory.ts\` equals the pinned SDK commands plus
those post-pin actions, and that every row reaches the service. Review source: the package command exports and generated
Smithy HTTP auth-scheme provider, plus the official action and authorization-model references linked from
\`cognito-design.md\`.

This inventory has ${commands.length} command rows, ${paginatorOperations.size} paginators,
and no waiters. A generated target row is not an implementation claim. Non-IAM
proof classes were reviewed against each operation input and the official
authorization-model guide; transport \`noAuth\` alone was not treated as a proof class.

The ${commands.length}-command inventory records ${implementedCount} implemented or explicitly bounded actions. ${boundedCount} commands are named simulator boundaries (25 since COG-07, four post-pin actions since COG-09); \`DeleteUserPoolReplica\` is a modeled no-replica error; three multi-secret lifecycle commands are fully implemented.

| Command | Target | Proof class | Primary resource | Phase | Paginator | Accepted depth | Error boundary | Status | Evidence |
|---|---|---|---|---:|---:|---|---|---|---|
${rows.join("\n")}
`;

await writeFile(outputFile, output);
