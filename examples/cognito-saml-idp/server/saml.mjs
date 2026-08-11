import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import {
  DEMO_CERTIFICATE_BASE64,
  DEMO_PRIVATE_KEY,
} from "./demo-credentials.mjs";

export const IDP_ENTITY_ID = "urn:stacksim:learning:saml-idp";
const SAML_PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_ASSERTION = "urn:oasis:names:tc:SAML:2.0:assertion";

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function exactlyOne(document, namespace, localName) {
  const values = Array.from(document.getElementsByTagNameNS(namespace, localName));
  if (values.length !== 1) throw new Error(`Expected one SAML ${localName} element.`);
  return values[0];
}

function loopbackUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  const loopback = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]";
  if (!loopback || !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${label} must use a local loopback HTTP(S) origin.`);
  }
  return parsed;
}

export function metadataXml(baseUrl) {
  const origin = loopbackUrl(baseUrl, "IdP base URL").origin;
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  entityID="${IDP_ENTITY_ID}">
  <md:IDPSSODescriptor protocolSupportEnumeration="${SAML_PROTOCOL}">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo>
        <ds:X509Data>
          <ds:X509Certificate>${DEMO_CERTIFICATE_BASE64}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified</md:NameIDFormat>
    <md:SingleSignOnService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
      Location="${escapeXml(`${origin}/saml/sso`)}" />
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

export function inspectAuthnRequest(encoded) {
  if (typeof encoded !== "string" || encoded.length < 1 || encoded.length > 100_000) {
    throw new Error("SAMLRequest is missing or too large.");
  }
  let xml;
  try {
    xml = inflateRawSync(Buffer.from(encoded, "base64"), { maxOutputLength: 100_000 }).toString("utf8");
  } catch {
    throw new Error("SAMLRequest is not valid Redirect-binding data.");
  }
  if (xml.includes("<!DOCTYPE") || xml.includes("<!ENTITY")) {
    throw new Error("Unsafe XML is not accepted.");
  }
  const errors = [];
  const document = new DOMParser({
    onError: message => errors.push(message),
  }).parseFromString(xml, "application/xml");
  if (errors.length) throw new Error("SAMLRequest XML is malformed.");
  const request = exactlyOne(document, SAML_PROTOCOL, "AuthnRequest");
  if (document.documentElement !== request) throw new Error("AuthnRequest must be the document root.");
  const issuer = exactlyOne(document, SAML_ASSERTION, "Issuer").textContent?.trim();
  const requestId = request.getAttribute("ID");
  const acsUrl = request.getAttribute("AssertionConsumerServiceURL");
  const destination = request.getAttribute("Destination");
  const issueInstant = request.getAttribute("IssueInstant");
  if (!requestId || !/^_[A-Za-z0-9-]{8,80}$/.test(requestId)) {
    throw new Error("AuthnRequest ID is invalid.");
  }
  if (!issuer?.startsWith("urn:amazon:cognito:sp:")) {
    throw new Error("This learning IdP accepts only Cognito service-provider issuers.");
  }
  const acs = loopbackUrl(acsUrl, "Assertion consumer URL");
  if (!acs.pathname.includes("/_stacksim/cognito-domain/") || !acs.pathname.endsWith("/saml2/idpresponse")) {
    throw new Error("Assertion consumer URL is not an stacksim Cognito SAML endpoint.");
  }
  return {
    xml,
    requestId,
    acsUrl: acs.href,
    destination,
    issueInstant,
    issuer,
    poolId: issuer.slice("urn:amazon:cognito:sp:".length),
  };
}

function userValue(value, name, maximum = 256) {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > maximum) {
    throw new Error(`${name} is required and must be at most ${maximum} characters.`);
  }
  return value.trim();
}

export function createSamlResponse({ encodedRequest, relayState, user, now = Date.now() }) {
  const request = inspectAuthnRequest(encodedRequest);
  if (typeof relayState !== "string" || relayState.length < 1 || relayState.length > 4096) {
    throw new Error("RelayState is missing or too large.");
  }
  const subject = userValue(user?.subject, "Subject");
  const email = userValue(user?.email, "Email");
  const name = userValue(user?.name, "Name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Email must look like an email address.");

  const issueInstant = new Date(now).toISOString();
  const notBefore = new Date(now - 60_000).toISOString();
  const notOnOrAfter = new Date(now + 5 * 60_000).toISOString();
  const responseId = `_${randomUUID()}`;
  const assertionId = `_${randomUUID()}`;
  const xml = `<samlp:Response xmlns:samlp="${SAML_PROTOCOL}" xmlns:saml="${SAML_ASSERTION}" ID="${responseId}" Version="2.0" IssueInstant="${issueInstant}" Destination="${escapeXml(request.acsUrl)}" InResponseTo="${escapeXml(request.requestId)}"><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${issueInstant}"><saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${escapeXml(subject)}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${escapeXml(request.requestId)}" Recipient="${escapeXml(request.acsUrl)}" NotOnOrAfter="${notOnOrAfter}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${escapeXml(request.issuer)}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${escapeXml(email)}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="email_verified"><saml:AttributeValue>true</saml:AttributeValue></saml:Attribute><saml:Attribute Name="name"><saml:AttributeValue>${escapeXml(name)}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;

  const signer = new SignedXml({ privateKey: DEMO_PRIVATE_KEY });
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
  const signedXml = signer.getSignedXml();
  return {
    acsUrl: request.acsUrl,
    relayState,
    samlResponse: Buffer.from(signedXml, "utf8").toString("base64"),
    signedXml,
    request,
  };
}
