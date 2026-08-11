import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CognitoIdentityProviderClient,
  CreateIdentityProviderCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  CreateUserPoolDomainCommand,
  DescribeIdentityProviderCommand,
  DescribeUserPoolDomainCommand,
  ListUserPoolClientsCommand,
  ListUserPoolsCommand,
  UpdateIdentityProviderCommand,
  UpdateUserPoolClientCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const endpoint = process.env.STACKSIM_ENDPOINT ?? "http://127.0.0.1:4566";
const publicOrigin = process.env.STACKSIM_COGNITO_PUBLIC_URL ?? "http://localhost:4566";
const region = process.env.AWS_REGION ?? "eu-west-1";
const idpBaseUrl = process.env.SAML_IDP_BASE_URL ?? "http://localhost:5174";
const metadataUrl = process.env.SAML_IDP_METADATA_URL ?? "http://127.0.0.1:5174/saml/metadata";
const poolName = process.env.COGNITO_POOL_NAME ?? "saml-learning-pool";
const providerName = process.env.COGNITO_PROVIDER_NAME ?? "LearningSAML";
const clientName = process.env.COGNITO_CLIENT_NAME ?? "saml-learning-client";
const domain = process.env.COGNITO_DOMAIN ?? "saml-learning-local";
const callbackUrl = `${idpBaseUrl}/callback`;

for (const [name, value] of Object.entries({ endpoint, publicOrigin, idpBaseUrl, metadataUrl })) {
  const parsed = new URL(value);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    throw new Error(`${name} must be a loopback URL for this learning example.`);
  }
}

try {
  const metadata = await fetch(metadataUrl);
  if (!metadata.ok || !(await metadata.text()).includes("EntityDescriptor")) throw new Error();
} catch {
  throw new Error(`The learning IdP is not reachable at ${metadataUrl}. Start it with npm run dev first.`);
}

const client = new CognitoIdentityProviderClient({
  endpoint,
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "admin",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "password",
  },
  maxAttempts: 1,
});

function notFound(error) {
  return error?.name === "ResourceNotFoundException";
}

try {
  const pools = await client.send(new ListUserPoolsCommand({ MaxResults: 60 }));
  let poolId = pools.UserPools?.find(pool => pool.Name === poolName)?.Id;
  if (!poolId) {
    const created = await client.send(new CreateUserPoolCommand({
      PoolName: poolName,
      UsernameAttributes: ["email"],
      Schema: [
        { Name: "email", AttributeDataType: "String", Required: true, Mutable: true },
        { Name: "name", AttributeDataType: "String", Mutable: true },
      ],
    }));
    poolId = created.UserPool.Id;
    console.log(`Created user pool ${poolName} (${poolId})`);
  } else {
    console.log(`Reusing user pool ${poolName} (${poolId})`);
  }

  const providerInput = {
    UserPoolId: poolId,
    ProviderName: providerName,
    ProviderDetails: {
      MetadataURL: metadataUrl,
      IDPInit: "false",
      EncryptedResponses: "false",
      IDPSignout: "false",
    },
    AttributeMapping: {
      email: "email",
      email_verified: "email_verified",
      name: "name",
    },
    IdpIdentifiers: ["paper-badge"],
  };
  try {
    await client.send(new DescribeIdentityProviderCommand({
      UserPoolId: poolId,
      ProviderName: providerName,
    }));
    await client.send(new UpdateIdentityProviderCommand(providerInput));
    console.log(`Updated SAML provider ${providerName}`);
  } catch (error) {
    if (!notFound(error)) throw error;
    await client.send(new CreateIdentityProviderCommand({
      ...providerInput,
      ProviderType: "SAML",
    }));
    console.log(`Created SAML provider ${providerName}`);
  }

  const clientInput = {
    UserPoolId: poolId,
    ClientName: clientName,
    ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"],
    CallbackURLs: [callbackUrl],
    LogoutURLs: [new URL("/", idpBaseUrl).href],
    SupportedIdentityProviders: [providerName],
    AllowedOAuthFlowsUserPoolClient: true,
    AllowedOAuthFlows: ["code"],
    AllowedOAuthScopes: ["openid", "email", "profile"],
    ReadAttributes: ["email"],
  };
  const clients = await client.send(new ListUserPoolClientsCommand({
    UserPoolId: poolId,
    MaxResults: 60,
  }));
  let clientId = clients.UserPoolClients?.find(value => value.ClientName === clientName)?.ClientId;
  if (clientId) {
    await client.send(new UpdateUserPoolClientCommand({
      ...clientInput,
      ClientId: clientId,
    }));
    console.log(`Updated app client ${clientName} (${clientId})`);
  } else {
    const created = await client.send(new CreateUserPoolClientCommand({
      ...clientInput,
      GenerateSecret: false,
    }));
    clientId = created.UserPoolClient.ClientId;
    console.log(`Created app client ${clientName} (${clientId})`);
  }

  const describedDomain = await client.send(new DescribeUserPoolDomainCommand({ Domain: domain }));
  if (describedDomain.DomainDescription?.UserPoolId && describedDomain.DomainDescription.UserPoolId !== poolId) {
    throw new Error(`The Cognito domain ${domain} belongs to a different pool. Set COGNITO_DOMAIN to another name.`);
  }
  if (!describedDomain.DomainDescription?.UserPoolId) {
    await client.send(new CreateUserPoolDomainCommand({
      UserPoolId: poolId,
      Domain: domain,
      ManagedLoginVersion: 2,
    }));
    console.log(`Created managed-login domain ${domain}`);
  } else {
    console.log(`Reusing managed-login domain ${domain}`);
  }

  const domainBase = `${publicOrigin}/_stacksim/cognito-domain/${encodeURIComponent(domain)}`;
  const config = {
    configured: true,
    region,
    poolId,
    clientId,
    providerName,
    domain,
    callbackUrl,
    authorizeUrl: `${domainBase}/oauth2/authorize`,
    tokenUrl: `${domainBase}/oauth2/token`,
    metadataUrl,
  };
  const configPath = resolve(root, "public", "config.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  console.log("");
  console.log(`Configuration written to ${configPath}`);
  console.log(`Open ${idpBaseUrl} and choose "Start SAML sign-in".`);
} finally {
  client.destroy();
}
