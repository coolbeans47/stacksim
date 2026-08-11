import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { DEMO_CERTIFICATE_BASE64 } from "../server/demo-credentials.mjs";
import {
  createSamlResponse,
  IDP_ENTITY_ID,
  inspectAuthnRequest,
  metadataXml,
} from "../server/saml.mjs";

function requestFixture(overrides = {}) {
  const requestId = overrides.requestId ?? "_learning-request-1234";
  const poolId = overrides.poolId ?? "eu-west-1_Learning123";
  const acsUrl = overrides.acsUrl
    ?? "http://localhost:4566/_stacksim/cognito-domain/saml-learning-local/saml2/idpresponse";
  const xml = `<?xml version="1.0"?><samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${requestId}" Version="2.0" IssueInstant="2026-07-27T12:00:00.000Z" Destination="http://localhost:5174/saml/sso" AssertionConsumerServiceURL="${acsUrl}"><saml:Issuer>urn:amazon:cognito:sp:${poolId}</saml:Issuer></samlp:AuthnRequest>`;
  return {
    encoded: deflateRawSync(Buffer.from(xml, "utf8")).toString("base64"),
    requestId,
    poolId,
    acsUrl,
  };
}

function certificatePem() {
  const lines = DEMO_CERTIFICATE_BASE64.match(/.{1,64}/g);
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

test("metadata advertises one Redirect-binding endpoint and the demo certificate", () => {
  const metadata = metadataXml("http://localhost:5174");
  assert.match(metadata, new RegExp(`entityID="${IDP_ENTITY_ID}"`));
  assert.match(metadata, /HTTP-Redirect/);
  assert.match(metadata, /http:\/\/localhost:5174\/saml\/sso/);
  assert.equal(metadata.match(/<ds:X509Certificate>/g)?.length, 1);
});

test("AuthnRequest inspection exposes the Cognito request without trusting arbitrary callbacks", () => {
  const fixture = requestFixture();
  const inspected = inspectAuthnRequest(fixture.encoded);
  assert.equal(inspected.requestId, fixture.requestId);
  assert.equal(inspected.poolId, fixture.poolId);
  assert.equal(inspected.acsUrl, fixture.acsUrl);

  assert.throws(
    () => inspectAuthnRequest(requestFixture({ acsUrl: "https://attacker.example/callback" }).encoded),
    /loopback/,
  );
});

test("the IdP produces an assertion that is signed by the metadata certificate", () => {
  const fixture = requestFixture();
  const response = createSamlResponse({
    encodedRequest: fixture.encoded,
    relayState: "round-trip-state",
    user: {
      subject: "developer-001",
      email: "ada@example.test",
      name: "Ada Developer",
    },
    now: Date.parse("2026-07-27T12:01:00.000Z"),
  });
  assert.equal(response.acsUrl, fixture.acsUrl);
  assert.equal(response.relayState, "round-trip-state");
  assert.match(response.signedXml, /<saml:NameID[^>]*>developer-001<\/saml:NameID>/);
  assert.match(response.signedXml, /<saml:AttributeValue>ada@example.test<\/saml:AttributeValue>/);

  const document = new DOMParser().parseFromString(response.signedXml, "application/xml");
  const signature = document.getElementsByTagNameNS(
    "http://www.w3.org/2000/09/xmldsig#",
    "Signature",
  )[0];
  const verifier = new SignedXml({ publicCert: certificatePem(), implicitTransforms: [] });
  verifier.loadSignature(signature);
  assert.equal(verifier.checkSignature(response.signedXml), true);
  assert.equal(verifier.getSignedReferences().length, 1);
});
