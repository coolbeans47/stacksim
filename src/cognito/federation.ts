import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey as CryptoJsonWebKey,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { deflateRawSync } from "node:zlib";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";

const MAX_PROVIDER_BODY = 1024 * 1024;
const MAX_SAML_RESPONSE = 100_000;
const REQUEST_TIMEOUT_MS = 5_000;
const SAML_PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_ASSERTION = "urn:oasis:names:tc:SAML:2.0:assertion";
const SAML_METADATA = "urn:oasis:names:tc:SAML:2.0:metadata";
const XMLDSIG = "http://www.w3.org/2000/09/xmldsig#";
const HTTP_REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const HTTP_POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";
const EXCLUSIVE_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const ENVELOPED_SIGNATURE = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

export class FederationError extends Error {
  constructor(
    readonly code: "invalid_request" | "access_denied" | "temporarily_unavailable",
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface IdentityProviderNetworkOptions {
  allowPublic: boolean;
}

interface SafeResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

type AddressClass = "public" | "loopback" | "private" | "forbidden";

function ipv4Class(value: string): AddressClass {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return "forbidden";
  }
  const [a, b] = octets;
  if (
    a === 0
    || a >= 224
    || a === 169 && b === 254
    || a === 192 && b === 0 && octets[2] === 0
    || a === 192 && b === 0 && octets[2] === 2
    || a === 198 && b === 51 && octets[2] === 100
    || a === 203 && b === 0 && octets[2] === 113
  ) return "forbidden";
  if (
    a === 10
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 168
    || a === 100 && b >= 64 && b <= 127
  ) return "private";
  if (a === 127) return "loopback";
  return "public";
}

function addressClass(value: string): AddressClass {
  const normalized = value.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(normalized) === 4) return ipv4Class(normalized);
  if (isIP(normalized) !== 6) return "forbidden";
  if (normalized === "::" || normalized.startsWith("fe8") || normalized.startsWith("fe9")
    || normalized.startsWith("fea") || normalized.startsWith("feb")) return "forbidden";
  if (normalized === "::1") return "loopback";
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return "private";
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mapped ? ipv4Class(mapped) : "public";
}

function exactOriginEndpoint(value: unknown, field: string): URL {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    throw new FederationError("invalid_request", `${field} is invalid.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FederationError("invalid_request", `${field} is invalid.`);
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.hash
  ) throw new FederationError("invalid_request", `${field} is invalid.`);
  return url;
}

export class SafeIdentityProviderHttpClient {
  constructor(private readonly options: IdentityProviderNetworkOptions) {}

  private async target(url: URL): Promise<{ address: string; family: 4 | 6 }> {
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") {
      throw new FederationError("access_denied", "Metadata identity-provider targets are blocked.");
    }
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
      : await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
    if (!addresses.length) {
      throw new FederationError("temporarily_unavailable", "The identity-provider host could not be resolved.", 503);
    }
    const classes = addresses.map(result => addressClass(result.address));
    if (classes.includes("forbidden")) {
      throw new FederationError("access_denied", "Metadata, link-local, unspecified, and reserved targets are blocked.");
    }
    if (classes.some(value => value !== classes[0])) {
      throw new FederationError("access_denied", "Mixed public/private DNS results are blocked.");
    }
    if (classes[0] === "private") {
      throw new FederationError("access_denied", "Private identity-provider targets are disabled.");
    }
    if (classes[0] === "public" && (!this.options.allowPublic || url.protocol !== "https:")) {
      throw new FederationError("access_denied", "Public identity providers require the public-HTTPS opt-in.");
    }
    const selected = addresses[0];
    return { address: selected.address, family: selected.family as 4 | 6 };
  }

  async request(
    value: string,
    options: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: Buffer } = {},
  ): Promise<SafeResponse> {
    const url = exactOriginEndpoint(value, "Identity-provider endpoint");
    const selected = await this.target(url);
    const body = options.body;
    if (body && body.length > MAX_PROVIDER_BODY) {
      throw new FederationError("invalid_request", "The identity-provider request is too large.");
    }
    return new Promise<SafeResponse>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, response?: SafeResponse): void => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(response!);
      };
      const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = transport(url, {
        method: options.method ?? "GET",
        headers: {
          accept: "application/json, application/xml, text/xml",
          "user-agent": "stacksim-cognito-federation/1",
          ...(body ? { "content-length": String(body.length) } : {}),
          ...options.headers,
        },
        lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
        ...(url.protocol === "https:" ? { servername: url.hostname, rejectUnauthorized: true } : {}),
      }, response => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", chunk => {
          length += chunk.length;
          if (length > MAX_PROVIDER_BODY) {
            request.destroy(new Error("Identity-provider response exceeds the size limit."));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => finish(undefined, {
          status: response.statusCode ?? 500,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
      });
      request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("Identity-provider request timed out.")));
      request.on("error", error => finish(
        new FederationError("temporarily_unavailable", `Identity-provider request failed: ${error.message}`, 503),
      ));
      if (body) request.write(body);
      request.end();
    }).then(response => {
      if (response.status >= 300 && response.status < 400) {
        throw new FederationError("access_denied", "Identity-provider redirects are not followed.");
      }
      return response;
    });
  }

  async json(
    value: string,
    options: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: Buffer } = {},
  ): Promise<Record<string, any>> {
    const response = await this.request(value, options);
    if (response.status < 200 || response.status >= 300) {
      throw new FederationError("access_denied", `Identity provider returned HTTP ${response.status}.`);
    }
    const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.startsWith("application/json") && !contentType.includes("+json")) {
      throw new FederationError("access_denied", "Identity provider returned a non-JSON response.");
    }
    try {
      const parsed = JSON.parse(response.body.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch {
      throw new FederationError("access_denied", "Identity provider returned invalid JSON.");
    } finally {
      response.body.fill(0);
    }
  }

  async text(value: string): Promise<string> {
    const response = await this.request(value);
    if (response.status < 200 || response.status >= 300) {
      throw new FederationError("access_denied", `Identity provider returned HTTP ${response.status}.`);
    }
    const output = response.body.toString("utf8");
    response.body.fill(0);
    return output;
  }
}

export interface OidcProviderConfiguration {
  issuer: string;
  clientId: string;
  authorizeScopes: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userInfoEndpoint?: string;
}

function exactString(record: Record<string, any>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    throw new FederationError("access_denied", `OIDC ${field} is invalid.`);
  }
  return value;
}

export async function resolveOidcConfiguration(
  details: Record<string, string>,
  http: SafeIdentityProviderHttpClient,
): Promise<OidcProviderConfiguration> {
  const issuer = exactOriginEndpoint(details.oidc_issuer, "oidc_issuer");
  if (issuer.search || issuer.pathname.endsWith("/.well-known/openid-configuration")) {
    throw new FederationError("invalid_request", "oidc_issuer must be an issuer URL, not a discovery URL.");
  }
  const discoveryUrl = `${issuer.href.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const discovered = await http.json(discoveryUrl);
  if (discovered.issuer !== details.oidc_issuer) {
    throw new FederationError("access_denied", "OIDC discovery issuer does not exactly match oidc_issuer.");
  }
  const endpoints = {
    authorizationEndpoint: details.authorize_url ?? exactString(discovered, "authorization_endpoint"),
    tokenEndpoint: details.token_url ?? exactString(discovered, "token_endpoint"),
    jwksUri: details.jwks_uri ?? exactString(discovered, "jwks_uri"),
    userInfoEndpoint: details.attributes_url ?? (
      typeof discovered.userinfo_endpoint === "string" ? discovered.userinfo_endpoint : undefined
    ),
  };
  for (const [field, endpoint] of Object.entries(endpoints)) {
    if (endpoint === undefined) continue;
    exactOriginEndpoint(endpoint, field);
  }
  const clientId = details.client_id;
  if (typeof clientId !== "string" || clientId.length < 1 || clientId.length > 256) {
    throw new FederationError("invalid_request", "OIDC client_id is invalid.");
  }
  const authorizeScopes = details.authorize_scopes ?? "openid";
  const scopes = authorizeScopes.split(" ");
  if (
    !scopes.includes("openid")
    || scopes.length > 20
    || scopes.some(scope => !/^[A-Za-z0-9._~:/-]{1,128}$/.test(scope))
  ) throw new FederationError("invalid_request", "OIDC authorize_scopes must include openid.");
  return { issuer: details.oidc_issuer, clientId, authorizeScopes, ...endpoints };
}

function decodeJwtPart(value: string): Record<string, any> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new FederationError("access_denied", "OIDC ID token is malformed.");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new FederationError("access_denied", "OIDC ID token is malformed.");
  }
}

export function oidcTokenHeader(token: string): { alg: string; kid: string } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new FederationError("access_denied", "OIDC ID token is malformed.");
  const header = decodeJwtPart(parts[0]);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 256) {
    throw new FederationError("access_denied", "OIDC ID token uses an unsupported signing key or algorithm.");
  }
  return { alg: header.alg, kid: header.kid };
}

export function verifyOidcIdToken(
  token: string,
  keys: CryptoJsonWebKey[],
  expected: { issuer: string; clientId: string; nonceDigest: string; digestNonce: (value: string) => string; now: number },
): Record<string, any> {
  if (token.length > 64 * 1024) throw new FederationError("access_denied", "OIDC ID token is too large.");
  const parts = token.split(".");
  const header = oidcTokenHeader(token);
  const claims = decodeJwtPart(parts[1]);
  const key = keys.find(candidate =>
    candidate.kty === "RSA"
    && candidate.alg === "RS256"
    && candidate.use === "sig"
    && candidate.kid === header.kid
  );
  if (!key) throw new FederationError("access_denied", "OIDC ID token signing key is unknown.");
  let valid = false;
  try {
    valid = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(parts[2], "base64url"),
    );
  } catch {
    valid = false;
  }
  const now = Math.floor(expected.now / 1_000);
  const audience = typeof claims.aud === "string"
    ? [claims.aud]
    : Array.isArray(claims.aud) && claims.aud.every((value: unknown) => typeof value === "string")
      ? claims.aud
      : [];
  if (
    !valid
    || claims.iss !== expected.issuer
    || !audience.includes(expected.clientId)
    || audience.length > 1 && claims.azp !== expected.clientId
    || typeof claims.exp !== "number"
    || now >= claims.exp
    || typeof claims.iat !== "number"
    || claims.iat > now + 60
    || typeof claims.sub !== "string"
    || claims.sub.length < 1
    || claims.sub.length > 512
    || typeof claims.nonce !== "string"
    || expected.digestNonce(claims.nonce) !== expected.nonceDigest
  ) throw new FederationError("access_denied", "OIDC ID token validation failed.");
  return claims;
}

function parseXml(xml: string): any {
  if (
    xml.length < 1
    || Buffer.byteLength(xml, "utf8") > MAX_PROVIDER_BODY
    || /<!DOCTYPE|<!ENTITY|\]\s*>/i.test(xml)
  ) throw new FederationError("access_denied", "Unsafe XML is not accepted.");
  try {
    return new DOMParser({
      onError: (level, message) => {
        if (level !== "warning") throw new Error(message);
      },
    }).parseFromString(xml, "application/xml");
  } catch {
    throw new FederationError("access_denied", "Identity-provider XML is invalid.");
  }
}

function elements(parent: any, namespace: string, localName: string): any[] {
  return Array.from(parent.getElementsByTagNameNS(namespace, localName));
}

function one(parent: any, namespace: string, localName: string): any {
  const values = elements(parent, namespace, localName);
  if (values.length !== 1) throw new FederationError("access_denied", `SAML ${localName} is missing or duplicated.`);
  return values[0];
}

function text(element: any): string {
  const value = element.textContent ?? "";
  if (!value || value.length > 131_072) throw new FederationError("access_denied", "SAML text value is invalid.");
  return value;
}

function pemCertificate(base64: string): string {
  const compact = base64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length > 100_000) {
    throw new FederationError("invalid_request", "SAML signing certificate is invalid.");
  }
  const certificate = Buffer.from(compact, "base64");
  if (certificate.length < 256 || certificate.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) {
    certificate.fill(0);
    throw new FederationError("invalid_request", "SAML signing certificate is invalid.");
  }
  const lines = certificate.toString("base64").match(/.{1,64}/g) ?? [];
  certificate.fill(0);
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

export interface SamlMetadata {
  entityId: string;
  ssoUrl: string;
  certificates: string[];
  certificate?: string;
  raw: string;
}

export function parseSamlMetadata(xml: string): SamlMetadata {
  const doc = parseXml(xml);
  const descriptor = one(doc, SAML_METADATA, "EntityDescriptor");
  const entityId = descriptor.getAttribute("entityID");
  if (!entityId || entityId.length > 2_048) throw new FederationError("invalid_request", "SAML metadata entityID is invalid.");
  const idp = one(descriptor, SAML_METADATA, "IDPSSODescriptor");
  if (!idp.getAttribute("protocolSupportEnumeration")?.split(/\s+/).includes(SAML_PROTOCOL)) {
    throw new FederationError("invalid_request", "SAML metadata does not support SAML 2.0.");
  }
  const services = elements(idp, SAML_METADATA, "SingleSignOnService");
  const selected = services.find(value => value.getAttribute("Binding") === HTTP_REDIRECT)
    ?? services.find(value => value.getAttribute("Binding") === HTTP_POST);
  const ssoUrl = selected?.getAttribute("Location");
  if (!ssoUrl) throw new FederationError("invalid_request", "SAML metadata has no supported SSO endpoint.");
  exactOriginEndpoint(ssoUrl, "SAML SSO endpoint");
  const certificates = elements(idp, SAML_METADATA, "KeyDescriptor")
    .filter(value => !value.getAttribute("use") || value.getAttribute("use") === "signing")
    .flatMap(value => elements(value, XMLDSIG, "X509Certificate"))
    .map(value => pemCertificate(text(value)));
  const uniqueCertificates = [...new Set(certificates)];
  if (uniqueCertificates.length < 1 || uniqueCertificates.length > 5) {
    throw new FederationError("invalid_request", "SAML metadata must contain from one through five signing certificates.");
  }
  return { entityId, ssoUrl, certificates: uniqueCertificates, raw: xml };
}

export function createSamlRedirect(
  metadata: SamlMetadata,
  input: { poolId: string; requestId: string; acsUrl: string; relayState: string; now: number },
): string {
  const instant = new Date(input.now).toISOString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?><samlp:AuthnRequest xmlns:samlp="${SAML_PROTOCOL}" xmlns:saml="${SAML_ASSERTION}" ID="${input.requestId}" Version="2.0" IssueInstant="${instant}" Destination="${escapeXml(metadata.ssoUrl)}" AssertionConsumerServiceURL="${escapeXml(input.acsUrl)}" ProtocolBinding="${HTTP_POST}"><saml:Issuer>urn:amazon:cognito:sp:${escapeXml(input.poolId)}</saml:Issuer><samlp:NameIDPolicy AllowCreate="true"/></samlp:AuthnRequest>`;
  const target = new URL(metadata.ssoUrl);
  target.searchParams.set("SAMLRequest", deflateRawSync(Buffer.from(xml, "utf8")).toString("base64"));
  target.searchParams.set("RelayState", input.relayState);
  return target.href;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("\"", "&quot;");
}

function uniqueXmlIds(doc: any): Map<string, any> {
  const result = new Map<string, any>();
  const all = Array.from(doc.getElementsByTagName("*")) as any[];
  for (const element of all) {
    for (const name of ["ID", "Id", "id"]) {
      const value = element.getAttribute(name);
      if (!value) continue;
      if (result.has(value)) throw new FederationError("access_denied", "SAML contains duplicate XML IDs.");
      result.set(value, element);
    }
  }
  return result;
}

function dateValue(value: string | null, field: string): number {
  if (!value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) {
    throw new FederationError("access_denied", `SAML ${field} is invalid.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new FederationError("access_denied", `SAML ${field} is invalid.`);
  return parsed;
}

export interface VerifiedSamlIdentity {
  responseId: string;
  assertionId: string;
  issuer: string;
  subject: string;
  attributes: Record<string, string>;
  inResponseTo?: string;
}

export function verifySamlResponse(
  encoded: string,
  input: {
    metadata: SamlMetadata;
    poolId: string;
    acsUrl: string;
    now: number;
    expectedRequestDigest?: string;
    digestRequest: (value: string) => string;
    idpInitiated: boolean;
  },
): VerifiedSamlIdentity {
  if (encoded.length < 1 || encoded.length > Math.ceil(MAX_SAML_RESPONSE * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new FederationError("access_denied", "SAMLResponse is invalid.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_SAML_RESPONSE || bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    bytes.fill(0);
    throw new FederationError("access_denied", "SAMLResponse is invalid.");
  }
  const xml = bytes.toString("utf8");
  bytes.fill(0);
  const doc = parseXml(xml);
  const response = one(doc, SAML_PROTOCOL, "Response");
  if (doc.documentElement !== response) throw new FederationError("access_denied", "SAML Response must be the document root.");
  const assertions = elements(response, SAML_ASSERTION, "Assertion");
  if (assertions.length !== 1) throw new FederationError("access_denied", "SAML must contain exactly one assertion.");
  const assertion = assertions[0];
  const ids = uniqueXmlIds(doc);
  const responseId = response.getAttribute("ID");
  const assertionId = assertion.getAttribute("ID");
  if (!responseId || !assertionId || ids.get(responseId) !== response || ids.get(assertionId) !== assertion) {
    throw new FederationError("access_denied", "SAML Response and Assertion require unique IDs.");
  }
  const signatures = elements(doc, XMLDSIG, "Signature");
  if (signatures.length !== 1) throw new FederationError("access_denied", "SAML requires exactly one XML signature.");
  const signature = signatures[0];
  const signatureMethod = one(signature, XMLDSIG, "SignatureMethod").getAttribute("Algorithm");
  const canonicalization = one(signature, XMLDSIG, "CanonicalizationMethod").getAttribute("Algorithm");
  const references = elements(signature, XMLDSIG, "Reference");
  if (signatureMethod !== RSA_SHA256 || canonicalization !== EXCLUSIVE_C14N || references.length !== 1) {
    throw new FederationError("access_denied", "SAML signature algorithms are not allowed.");
  }
  const reference = references[0];
  const uri = reference.getAttribute("URI");
  const signedId = uri?.startsWith("#") ? uri.slice(1) : "";
  const signedElement = ids.get(signedId);
  if (!signedElement || signedElement !== response && signedElement !== assertion) {
    throw new FederationError("access_denied", "SAML signature does not cover the consumed Response or Assertion.");
  }
  if (one(reference, XMLDSIG, "DigestMethod").getAttribute("Algorithm") !== SHA256) {
    throw new FederationError("access_denied", "SAML digest algorithm is not allowed.");
  }
  const transforms = elements(reference, XMLDSIG, "Transform").map(value => value.getAttribute("Algorithm"));
  if (
    transforms.length !== 2
    || transforms[0] !== ENVELOPED_SIGNATURE
    || transforms[1] !== EXCLUSIVE_C14N
  ) throw new FederationError("access_denied", "SAML signature transforms are not allowed.");
  const trustedCertificates = input.metadata.certificates?.length
    ? input.metadata.certificates
    : input.metadata.certificate ? [input.metadata.certificate] : [];
  const signatureValid = trustedCertificates.some(certificate => {
    try {
      const verifier = new SignedXml({ publicCert: certificate, implicitTransforms: [] });
      verifier.loadSignature(signature as any);
      return verifier.checkSignature(xml) && verifier.getSignedReferences().length === 1;
    } catch {
      return false;
    }
  });
  if (!signatureValid) {
    throw new FederationError("access_denied", "SAML signature validation failed.");
  }
  const responseDestination = response.getAttribute("Destination");
  if (responseDestination !== input.acsUrl) {
    throw new FederationError("access_denied", "SAML Response destination is invalid.");
  }
  const statusCode = one(one(response, SAML_PROTOCOL, "Status"), SAML_PROTOCOL, "StatusCode").getAttribute("Value");
  if (statusCode !== "urn:oasis:names:tc:SAML:2.0:status:Success") {
    throw new FederationError("access_denied", "SAML identity provider returned a non-success status.");
  }
  const issuer = text(one(assertion, SAML_ASSERTION, "Issuer"));
  if (issuer !== input.metadata.entityId) throw new FederationError("access_denied", "SAML assertion issuer is invalid.");
  const conditions = one(assertion, SAML_ASSERTION, "Conditions");
  const notBefore = dateValue(conditions.getAttribute("NotBefore"), "NotBefore");
  const notOnOrAfter = dateValue(conditions.getAttribute("NotOnOrAfter"), "NotOnOrAfter");
  if (input.now + 60_000 < notBefore || input.now >= notOnOrAfter) {
    throw new FederationError("access_denied", "SAML assertion conditions are not current.");
  }
  const audiences = elements(conditions, SAML_ASSERTION, "Audience").map(value => text(value));
  if (audiences.length !== 1 || audiences[0] !== `urn:amazon:cognito:sp:${input.poolId}`) {
    throw new FederationError("access_denied", "SAML assertion audience is invalid.");
  }
  const subject = one(assertion, SAML_ASSERTION, "Subject");
  const nameId = text(one(subject, SAML_ASSERTION, "NameID"));
  if (nameId.length > 512) throw new FederationError("access_denied", "SAML NameID is invalid.");
  const confirmationData = one(subject, SAML_ASSERTION, "SubjectConfirmationData");
  if (confirmationData.getAttribute("Recipient") !== input.acsUrl) {
    throw new FederationError("access_denied", "SAML assertion recipient is invalid.");
  }
  if (input.now >= dateValue(confirmationData.getAttribute("NotOnOrAfter"), "SubjectConfirmationData.NotOnOrAfter")) {
    throw new FederationError("access_denied", "SAML subject confirmation has expired.");
  }
  const inResponseTo = confirmationData.getAttribute("InResponseTo") || response.getAttribute("InResponseTo") || undefined;
  if (
    input.idpInitiated
      ? inResponseTo !== undefined
      : !inResponseTo
        || !input.expectedRequestDigest
        || input.digestRequest(inResponseTo) !== input.expectedRequestDigest
  ) throw new FederationError("access_denied", "SAML request correlation is invalid.");
  const attributes: Record<string, string> = {};
  for (const attribute of elements(assertion, SAML_ASSERTION, "Attribute")) {
    const name = attribute.getAttribute("Name");
    const values = elements(attribute, SAML_ASSERTION, "AttributeValue");
    if (!name || name.length > 2_048 || values.length !== 1 || attributes[name] !== undefined) {
      throw new FederationError("access_denied", "SAML attributes are invalid or duplicated.");
    }
    attributes[name] = text(values[0]);
  }
  return { responseId, assertionId, issuer, subject: nameId, attributes, ...(inResponseTo ? { inResponseTo } : {}) };
}

export function serializeXml(element: any): string {
  return new XMLSerializer().serializeToString(element);
}
