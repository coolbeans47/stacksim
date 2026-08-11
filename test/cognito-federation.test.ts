import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import {
  AdminCreateUserCommand,
  AdminDisableProviderForUserCommand,
  AdminGetUserCommand,
  AdminLinkProviderForUserCommand,
  CognitoIdentityProviderClient,
  CreateIdentityProviderCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  CreateUserPoolDomainCommand,
  DeleteIdentityProviderCommand,
  DeleteUserPoolClientCommand,
  DescribeIdentityProviderCommand,
  GetIdentityProviderByIdentifierCommand,
  ListIdentityProvidersCommand,
  UpdateIdentityProviderCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { StackSim } from "../src/server.js";
import {
  parseSamlMetadata,
  SafeIdentityProviderHttpClient,
} from "../src/cognito/federation.js";
import { SignedXml } from "xml-crypto";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const samlCertificate = "MIICqTCCAZGgAwIBAgIJALZkmVRXHgJ3MA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNVBAMTCXNhbWwudGVzdDAeFw0yNjA3MjUxNzUwMzNaFw0zMTA3MjYxNzUwMzNaMBQxEjAQBgNVBAMTCXNhbWwudGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANF1gM4f+AuUp5opXiPeYLzaP51KP2le2Uv1h/xMIHEweZq9vys5cU3VeMilE3BQSKhdhMqUwRzem7YPheeIeChgJ5MyTxFGyFBVfpSXRUTvKaKrinPoHBX8oXYZWCf8RfMpLi2FMGMF+WcXHVcZiN0RQyE34ndlUuZc9nqXrh1uVQYm4KXrMg0kpPXv5x5vTJH60yJH77LImpPkkQMUAJUurWNvZrdSYxpwHZ7gcW5XZ0IjC+RYrl6DcFryiFsDCOz4OuObLhRUNtyMN74NTaSdkca8WOF9YStl4jgOK11i9NhLITmvpbrw9OdgWe3N4UXk6rWnsjqxmpSgHvGaq30CAwEAATANBgkqhkiG9w0BAQsFAAOCAQEASr4nCS+nEP0CTN93tmA8OYkyRTW6ZTIX/L9bdU2FKdI8rEqsr3w7TvfteEyBvIgOCMQGciSdynxClie8ncGGspqSlZHWVIVYAm0mP+zghznai/3BcHMtKbOVjKa6SvePeEyF9kcHlSJoZ/Ex7zAPR5kZkhpCuwHfgglWHbLALlD6UMfXs+KzOXFT4ixqIMd8+g6OKANl2wWLpqcCh/MHHKvO+KD6zA0/MNyLSst8AFZbHcmA8qMYRqL0nOgSKEyP7c1kotZm6u7UF126A0WSoIj2JxQRrEfvYHdcNhSXxrj5/5DgSuIZ9n6opXT3jOJ8SSp2HUipKFFdoTNk18tN5g==";

function urlBase64(value: string): string {
  return value.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const samlPrivateKey = createPrivateKey({
  format: "jwk",
  key: {
    kty: "RSA",
    n: urlBase64("0XWAzh/4C5SnmileI95gvNo/nUo/aV7ZS/WH/EwgcTB5mr2/KzlxTdV4yKUTcFBIqF2EypTBHN6btg+F54h4KGAnkzJPEUbIUFV+lJdFRO8poquKc+gcFfyhdhlYJ/xF8ykuLYUwYwX5ZxcdVxmI3RFDITfid2VS5lz2epeuHW5VBibgpesyDSSk9e/nHm9MkfrTIkfvssiak+SRAxQAlS6tY29mt1JjGnAdnuBxbldnQiML5FiuXoNwWvKIWwMI7Pg645suFFQ23Iw3vg1NpJ2RxrxY4X1hK2XiOA4rXWL02EshOa+luvD052BZ7c3hReTqtaeyOrGalKAe8ZqrfQ=="),
    e: "AQAB",
    d: urlBase64("vHu+Yr4F2XX1tBYRrrlH1+mVYRcVJN7DL0VND035y6FRbFvfEShpux6jx/o0GddE6qzs99cQR8hR2mzxlD4L0llkg2K8H9HQI+orM89D+Bo3Hzi6KD7wNyDUso9v8ttinsOp2DCIMDOKEKiOMHi73iLQg63kToiRJtb0vbCMb9Hdxmj/poiXLn6YTxKYj2fM6zdzNAPV9Cgr9XXi3ulTuIpz9KCabbu32sI2GjPfkeQjPh1Qsy6WrDMI0jmM68Hp0Im1rxW+cyhRQ55VWXZmHGI4x+E84Dfn2oslCy8gBMHheGdSBkwbPLNRWgwdreb7GUec2eJz4vCa/tiyl5FgyQ=="),
    p: urlBase64("88tJ2qBNHBaI//wcNQly2+aFN6318FcstsNABGFHNWUwk1JUv0CsBGm40YeW8Iwbja3HIW8NocrysPrnt2wO+M8uR7F0K9Cg/Li1AfdpFnssdPeQP97rmLhuCcFUiPT/M5cJP1OhophEjVPOFzfn3Mr8aTGq/ihXMb452iYZhks="),
    q: urlBase64("2/IkLeHQEW91oc74PSfVK8RC/ZZFMSXgdUwiHNeBMtcHjdwgGgtXoLjQ2knKCdKZYfO3qVezNIkJIi+UMR0BtDNFChqMj9ExT5oHE8doFBwu7Ro1erwR5l+PXKsuBqXz45cVBZCrMreC/gI0qdL4kO7ZuGL9m3haeHeUCqSlGFc="),
    dp: urlBase64("55AbGT8Tnu9Et6iWfkX4RCjENmvU47FZtkrkvoRLp8ryhaw49OQPv61PsC2Sz+60qTD7qKUcFKZ5OGNJvu4zll7rvYsvJgLnNsSWoUSIG6NpSbxv1kr+CrR7SGbKzb+vuyflz7G3IIJy8q48Xc9rO0vOzngvy3MzxvrBZpSzv9s="),
    dq: urlBase64("Nj5yw8oUSaiGh2CHAnYnccLWjroX2HYx9FvRcfGIUKSNnWPzmti/RMkv4RYfuOpyn6C+5AnYDZXaZc78KlywBeQ7G7HOhs2d7rbbFfqw5XzJ6fnzxJBLjdh1f/JLyKH3E2M4cQXr4vc1XDXpDRUV7pCpq3rmdwhor5s2LKXMfcM="),
    qi: urlBase64("cbHnzqA52heaCF9sjixdzWGzkdJK6t/Irsla127a+sRqcy5I6P3Uci2l/HOzlbE/nABakLikTXeMEyA2MXD9PFwfytNh4js34eJH+UdLCZErqWK9cDFdWwLbTROfgi2cA9EMUaPZ25W6Q503FRU6qmUY4P6LZhF4bVTvQQYcQys="),
  },
});

function jwt(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  kid: string,
  claims: Record<string, unknown>,
): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

function parseJwt(value: string): Record<string, any> {
  return JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString("utf8"));
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function signedSamlResponse(input: {
  poolId: string;
  acsUrl: string;
  requestId: string;
  responseId: string;
  assertionId: string;
}): string {
  const now = Date.now();
  const issueInstant = new Date(now).toISOString();
  const notBefore = new Date(now - 60_000).toISOString();
  const notOnOrAfter = new Date(now + 300_000).toISOString();
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${input.responseId}" Version="2.0" IssueInstant="${issueInstant}" Destination="${input.acsUrl}" InResponseTo="${input.requestId}"><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${input.assertionId}" Version="2.0" IssueInstant="${issueInstant}"><saml:Issuer>https://saml-idp.example.test</saml:Issuer><saml:Subject><saml:NameID>saml-subject-123</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${input.requestId}" Recipient="${input.acsUrl}" NotOnOrAfter="${notOnOrAfter}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>urn:amazon:cognito:sp:${input.poolId}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>saml-user@example.test</saml:AttributeValue></saml:Attribute><saml:Attribute Name="email_verified"><saml:AttributeValue>true</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;
  const signer = new SignedXml({ privateKey: samlPrivateKey });
  signer.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  signer.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
  signer.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signer.computeSignature(xml, {
    location: {
      reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
      action: "after",
    },
  });
  return Buffer.from(signer.getSignedXml(), "utf8").toString("base64");
}

test("COG-05 federation parser and network client fail closed before unsafe I/O", async () => {
  const network = new SafeIdentityProviderHttpClient({ allowPublic: true });
  await assert.rejects(
    network.request("http://169.254.169.254/latest/meta-data/"),
    /Metadata identity-provider targets are blocked/,
  );
  await assert.rejects(
    network.request("http://203.0.113.10/provider"),
    /reserved targets are blocked/,
  );
  await assert.rejects(
    network.request("http://8.8.8.8/provider"),
    /Public identity providers require the public-HTTPS opt-in/,
  );
  await assert.rejects(
    network.request("http://10.0.0.1/provider"),
    /Private identity-provider targets are disabled/,
  );
  assert.throws(
    () => parseSamlMetadata('<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><x>&secret;</x>'),
    /Unsafe XML is not accepted/,
  );
});

test("COG-05 OIDC federation, provider controls, linking, encrypted secrets, and network boundary", async t => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-federation-"));
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "cog05-test-key";
  const publicJwk = keyPair.publicKey.export({ format: "jwk" });
  let issuer = "";
  let provider: Server | undefined;
  let simulator: StackSim | undefined;
  let client: CognitoIdentityProviderClient | undefined;
  let nonce = "";
  let expectedRedirectUri = "";
  try {
    provider = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", issuer || "http://127.0.0.1");
      if (url.pathname === "/.well-known/openid-configuration") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          userinfo_endpoint: `${issuer}/userinfo`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }));
      }
      if (url.pathname === "/jwks") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }],
        }));
      }
      if (url.pathname === "/authorize") {
        assert.equal(url.searchParams.get("client_id"), "upstream-client");
        assert.equal(url.searchParams.get("response_type"), "code");
        assert.equal(url.searchParams.get("scope"), "openid email profile");
        nonce = url.searchParams.get("nonce")!;
        expectedRedirectUri = url.searchParams.get("redirect_uri")!;
        const redirect = new URL(expectedRedirectUri);
        redirect.searchParams.set("code", "valid-upstream-code");
        redirect.searchParams.set("state", url.searchParams.get("state")!);
        res.writeHead(302, { location: redirect.href });
        return res.end();
      }
      if (url.pathname === "/token") {
        assert.equal(req.method, "POST");
        const form = new URLSearchParams(await body(req));
        assert.equal(form.get("grant_type"), "authorization_code");
        assert.equal(form.get("client_id"), "upstream-client");
        assert.equal(form.get("client_secret"), "upstream-secret-value");
        assert.equal(form.get("code"), "valid-upstream-code");
        assert.equal(form.get("redirect_uri"), expectedRedirectUri);
        const now = Math.floor(Date.now() / 1_000);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          access_token: "upstream-access-token",
          token_type: "Bearer",
          id_token: jwt(keyPair.privateKey, kid, {
            iss: issuer,
            aud: "upstream-client",
            sub: "external-subject-123",
            nonce,
            iat: now,
            exp: now + 300,
            email: "federated@example.test",
            email_verified: true,
            name: "Federated Learner",
          }),
        }));
      }
      if (url.pathname === "/userinfo") {
        assert.equal(req.headers.authorization, "Bearer upstream-access-token");
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          sub: "external-subject-123",
          preferred_username: "federated-learner",
        }));
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      provider!.once("error", reject);
      provider!.listen(0, "127.0.0.1", resolve);
    });
    issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;

    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      region: "eu-west-1",
      authMode: "off",
    });
    await simulator.start();
    const origin = `http://127.0.0.1:${simulator.port}`;
    client = new CognitoIdentityProviderClient({
      endpoint: origin,
      region: "eu-west-1",
      credentials,
      maxAttempts: 1,
    });
    const pool = await client.send(new CreateUserPoolCommand({
      PoolName: "federated-users",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: [{ Name: "email", AttributeDataType: "String", Required: true, Mutable: true }],
    }));
    const poolId = pool.UserPool!.Id!;
    const details = {
      oidc_issuer: issuer,
      client_id: "upstream-client",
      client_secret: "upstream-secret-value",
      authorize_scopes: "openid email profile",
    };
    const created = await client.send(new CreateIdentityProviderCommand({
      UserPoolId: poolId,
      ProviderName: "TestOIDC",
      ProviderType: "OIDC",
      ProviderDetails: details,
      AttributeMapping: {
        email: "email",
        email_verified: "email_verified",
        name: "name",
        preferred_username: "preferred_username",
      },
      IdpIdentifiers: ["corp"],
    }));
    assert.equal(created.IdentityProvider?.ProviderType, "OIDC");
    assert.equal(created.IdentityProvider?.ProviderDetails?.client_secret, "upstream-secret-value");
    assert.equal((await client.send(new DescribeIdentityProviderCommand({
      UserPoolId: poolId,
      ProviderName: "TestOIDC",
    }))).IdentityProvider?.ProviderDetails?.oidc_issuer, issuer);
    assert.equal((await client.send(new GetIdentityProviderByIdentifierCommand({
      UserPoolId: poolId,
      IdpIdentifier: "corp",
    }))).IdentityProvider?.ProviderName, "TestOIDC");
    assert.deepEqual((await client.send(new ListIdentityProvidersCommand({
      UserPoolId: poolId,
      MaxResults: 1,
    }))).Providers?.map(entry => entry.ProviderName), ["TestOIDC"]);
    const updated = await client.send(new UpdateIdentityProviderCommand({
      UserPoolId: poolId,
      ProviderName: "TestOIDC",
      ProviderDetails: {
        oidc_issuer: issuer,
        client_id: "upstream-client",
        authorize_scopes: "openid email profile",
      },
      AttributeMapping: {
        email: "email",
        email_verified: "email_verified",
        name: "name",
        preferred_username: "preferred_username",
      },
      IdpIdentifiers: ["corp", "workforce"],
    }));
    assert.equal(updated.IdentityProvider?.ProviderDetails?.client_secret, "upstream-secret-value");

    const callback = "http://127.0.0.1:39124/callback";
    const app = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "federated-browser",
      ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"],
      CallbackURLs: [callback],
      SupportedIdentityProviders: ["COGNITO", "TestOIDC"],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: ["openid", "email", "profile"],
      ReadAttributes: ["email"],
    }));
    const clientId = app.UserPoolClient!.ClientId!;
    await client.send(new CreateUserPoolDomainCommand({
      UserPoolId: poolId,
      Domain: "federated-users-local",
      ManagedLoginVersion: 2,
    }));
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const authorize = new URL(
      `http://localhost:${simulator.port}/_stacksim/cognito-domain/federated-users-local/oauth2/authorize`,
    );
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", callback);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "openid email profile");
    authorize.searchParams.set("state", "application-state");
    authorize.searchParams.set("nonce", "application-nonce");
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("idp_identifier", "workforce");

    const providerRedirect = await fetch(authorize, { redirect: "manual" });
    assert.equal(providerRedirect.status, 302);
    assert.equal(new URL(providerRedirect.headers.get("location")!).origin, issuer);
    const cognitoRedirect = await fetch(providerRedirect.headers.get("location")!, { redirect: "manual" });
    assert.equal(cognitoRedirect.status, 302);
    assert.match(cognitoRedirect.headers.get("location")!, /\/oauth2\/idpresponse\?/);
    const appRedirect = await fetch(cognitoRedirect.headers.get("location")!, { redirect: "manual" });
    assert.equal(appRedirect.status, 302);
    assert.match(appRedirect.headers.get("set-cookie") ?? "", /stacksim_cognito_session=/);
    const callbackResult = new URL(appRedirect.headers.get("location")!);
    assert.equal(callbackResult.searchParams.get("state"), "application-state");
    const cognitoCode = callbackResult.searchParams.get("code")!;
    const tokenResponse = await fetch(
      `http://localhost:${simulator.port}/_stacksim/cognito-domain/federated-users-local/oauth2/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: callback,
          code: cognitoCode,
          code_verifier: verifier,
        }),
      },
    );
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json() as Record<string, string>;
    const idClaims = parseJwt(tokens.id_token);
    assert.equal(idClaims.email, "federated@example.test");
    assert.equal(idClaims.nonce, "application-nonce");
    assert.equal(idClaims.identities[0].providerName, "TestOIDC");
    const users = Object.values(simulator.store.regionState("eu-west-1").cognito.pools[poolId].usersBySub);
    assert.equal(users.length, 1);
    assert.equal(users[0].status, "EXTERNAL_PROVIDER");
    assert.equal(users[0].externalIdentities[0].providerSubject, "external-subject-123");
    const stableSub = users[0].sub;
    const repeatProviderRedirect = await fetch(authorize, { redirect: "manual" });
    const repeatCognitoRedirect = await fetch(
      repeatProviderRedirect.headers.get("location")!,
      { redirect: "manual" },
    );
    const repeatAppRedirect = await fetch(
      repeatCognitoRedirect.headers.get("location")!,
      { redirect: "manual" },
    );
    assert.equal(repeatAppRedirect.status, 302);
    const repeatedUsers = Object.values(
      simulator.store.regionState("eu-west-1").cognito.pools[poolId].usersBySub,
    );
    assert.equal(repeatedUsers.length, 1);
    assert.equal(repeatedUsers[0].sub, stableSub);

    await assert.rejects(
      client.send(new DeleteIdentityProviderCommand({ UserPoolId: poolId, ProviderName: "TestOIDC" })),
      (error: any) => error.name === "InvalidParameterException",
    );
    await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: "local@example.test",
      MessageAction: "SUPPRESS",
      TemporaryPassword: "Temporary-password-1!",
      UserAttributes: [{ Name: "email", Value: "local@example.test" }],
    }));
    await client.send(new AdminLinkProviderForUserCommand({
      UserPoolId: poolId,
      DestinationUser: {
        ProviderName: "Cognito",
        ProviderAttributeName: "Cognito_Subject",
        ProviderAttributeValue: "local@example.test",
      },
      SourceUser: {
        ProviderName: "TestOIDC",
        ProviderAttributeName: "sub",
        ProviderAttributeValue: "manually-linked-subject",
      },
    }));
    const local = await client.send(new AdminGetUserCommand({
      UserPoolId: poolId,
      Username: "local@example.test",
    }));
    assert.match(local.UserAttributes?.find(attribute => attribute.Name === "identities")?.Value ?? "", /TestOIDC/);
    await client.send(new AdminDisableProviderForUserCommand({
      UserPoolId: poolId,
      User: {
        ProviderName: "TestOIDC",
        ProviderAttributeName: "sub",
        ProviderAttributeValue: "manually-linked-subject",
      },
    }));
    await client.send(new AdminDisableProviderForUserCommand({
      UserPoolId: poolId,
      User: {
        ProviderName: "TestOIDC",
        ProviderAttributeName: "sub",
        ProviderAttributeValue: "external-subject-123",
      },
    }));
    await client.send(new DeleteUserPoolClientCommand({ UserPoolId: poolId, ClientId: clientId }));
    await client.send(new DeleteIdentityProviderCommand({ UserPoolId: poolId, ProviderName: "TestOIDC" }));
    assert.equal((await client.send(new ListIdentityProvidersCommand({ UserPoolId: poolId }))).Providers?.length, 0);

    const stateText = await readFile(join(root, "state.json"), "utf8");
    assert(!stateText.includes("upstream-secret-value"));

    t.diagnostic("OIDC federation, default loopback access, and private-network boundary verified");
  } finally {
    client?.destroy();
    await simulator?.stop().catch(() => undefined);
    await new Promise<void>(resolve => provider?.close(() => resolve()) ?? resolve());
    await rm(root, { recursive: true, force: true });
  }
});

test("COG-05 accepts a correlated signed SAML POST and rejects its replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-saml-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region: "eu-west-1",
    authMode: "off",
  });
  let client: CognitoIdentityProviderClient | undefined;
  try {
    await simulator.start();
    client = new CognitoIdentityProviderClient({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region: "eu-west-1",
      credentials,
      maxAttempts: 1,
    });
    const pool = await client.send(new CreateUserPoolCommand({
      PoolName: "saml-users",
      UsernameAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
    }));
    const poolId = pool.UserPool!.Id!;
    const metadata = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://saml-idp.example.test"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${samlCertificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="http://127.0.0.1:39998/saml-authorize"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
    await client.send(new CreateIdentityProviderCommand({
      UserPoolId: poolId,
      ProviderName: "TestSAML",
      ProviderType: "SAML",
      ProviderDetails: { MetadataFile: metadata },
      AttributeMapping: {
        email: "email",
        email_verified: "email_verified",
      },
      IdpIdentifiers: ["partners"],
    }));
    const callback = "http://127.0.0.1:39125/callback";
    const app = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "saml-browser",
      ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"],
      CallbackURLs: [callback],
      SupportedIdentityProviders: ["TestSAML"],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: ["openid", "email"],
      ReadAttributes: ["email"],
    }));
    const clientId = app.UserPoolClient!.ClientId!;
    await client.send(new CreateUserPoolDomainCommand({
      UserPoolId: poolId,
      Domain: "saml-users-local",
      ManagedLoginVersion: 2,
    }));
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const authorize = new URL(
      `http://localhost:${simulator.port}/_stacksim/cognito-domain/saml-users-local/oauth2/authorize`,
    );
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", callback);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "openid email");
    authorize.searchParams.set("state", "saml-application-state");
    authorize.searchParams.set("nonce", "saml-application-nonce");
    authorize.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("identity_provider", "TestSAML");
    const redirect = await fetch(authorize, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    const idpLocation = new URL(redirect.headers.get("location")!);
    assert.equal(idpLocation.origin, "http://127.0.0.1:39998");
    const requestXml = inflateRawSync(
      Buffer.from(idpLocation.searchParams.get("SAMLRequest")!, "base64"),
    ).toString("utf8");
    const requestId = requestXml.match(/\bID="([^"]+)"/)?.[1];
    assert(requestId);
    const acsUrl = requestXml.match(/\bAssertionConsumerServiceURL="([^"]+)"/)?.[1];
    assert(acsUrl);
    const samlResponse = signedSamlResponse({
      poolId,
      acsUrl,
      requestId,
      responseId: "_response-cog05",
      assertionId: "_assertion-cog05",
    });
    const responseForm = new URLSearchParams({
      SAMLResponse: samlResponse,
      RelayState: idpLocation.searchParams.get("RelayState")!,
    });
    const accepted = await fetch(acsUrl, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: responseForm,
    });
    assert.equal(accepted.status, 302);
    const callbackResult = new URL(accepted.headers.get("location")!);
    assert.equal(callbackResult.searchParams.get("state"), "saml-application-state");
    assert(callbackResult.searchParams.get("code"));
    const user = Object.values(
      simulator.store.regionState("eu-west-1").cognito.pools[poolId].usersBySub,
    )[0];
    assert.equal(user.status, "EXTERNAL_PROVIDER");
    assert.equal(user.externalIdentities[0].providerType, "SAML");
    assert.equal(user.attributes.email.value, "saml-user@example.test");

    const replayed = await fetch(acsUrl, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: responseForm,
    });
    assert.equal(replayed.status, 400);
    assert(["access_denied", "invalid_request"].includes((await replayed.json() as any).error));
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
