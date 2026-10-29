import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";

const LOOPBACK_CA_NAME = "stacksim CloudFormation development CA";

function length(value: number): Buffer {
  if (value < 0x80) return Buffer.from([value]);
  const bytes: number[] = [];
  for (let remaining = value; remaining; remaining >>>= 8) bytes.unshift(remaining & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...parts: Array<Buffer | Uint8Array>): Buffer {
  const body = Buffer.concat(parts.map(part => Buffer.from(part)));
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

function oid(value: string): Buffer {
  const values = value.split(".").map(Number);
  const encoded = [values[0] * 40 + values[1]];
  for (const value of values.slice(2)) {
    const bytes = [value & 0x7f];
    for (let remaining = Math.floor(value / 128); remaining; remaining = Math.floor(remaining / 128)) bytes.unshift(0x80 | (remaining & 0x7f));
    encoded.push(...bytes);
  }
  return der(0x06, Buffer.from(encoded));
}

function algorithmIdentifier(): Buffer { return der(0x30, oid("1.2.840.113549.1.1.11"), der(0x05)); }
function commonName(value: string): Buffer { return der(0x30, der(0x31, der(0x30, oid("2.5.4.3"), der(0x0c, Buffer.from(value))))); }

function utcTime(value: Date): Buffer {
  const iso = value.toISOString();
  return der(0x17, Buffer.from(`${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`));
}

function pem(label: string, value: Buffer): string {
  const body = value.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function readTlv(buffer: Buffer, offset: number): { start: number; end: number } {
  let cursor = offset + 1;
  let size = buffer[cursor++];
  if (size & 0x80) {
    const count = size & 0x7f;
    size = 0;
    for (let i = 0; i < count; i++) size = (size << 8) | buffer[cursor++];
  }
  return { start: cursor, end: cursor + size };
}

/** RFC 5280 §4.2.1.2 method 1: the SHA-1 of the subjectPublicKey BIT STRING contents. */
function keyIdentifier(publicKey: KeyObject): Buffer {
  const spki = publicKey.export({ type: "spki", format: "der" });
  const outer = readTlv(spki, 0);
  const algorithm = readTlv(spki, outer.start);
  const bitString = readTlv(spki, algorithm.end);
  return createHash("sha1").update(spki.subarray(bitString.start + 1, bitString.end)).digest();
}

function serialBytes(hex: string): Buffer {
  const normalized = hex.length % 2 ? `0${hex}` : hex;
  const bytes = Buffer.from(normalized, "hex");
  return bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
}

/**
 * Subject and authority key identifiers.  The authority identifier carries the
 * issuer name and serial as well as the key identifier, so a verifier whose
 * trust store holds another certificate with the same CA name (one
 * installation's CA imported into the operating-system store while another
 * installation's CA arrives through NODE_EXTRA_CA_CERTS or AWS_CA_BUNDLE)
 * skips that certificate instead of failing the signature check against it.
 */
function keyIdentifierExtensions(publicKey: KeyObject, issuerPublicKey: KeyObject, issuerCommonName: string, issuerSerial: Buffer): Buffer[] {
  return [
    der(0x30, oid("2.5.29.14"), der(0x04, der(0x04, keyIdentifier(publicKey)))),
    der(0x30, oid("2.5.29.35"), der(0x04, der(0x30,
      der(0x80, keyIdentifier(issuerPublicKey)),
      // The issuer name and serial are known only when the CA certificate itself is at hand.
      ...(issuerSerial.length ? [der(0xa1, der(0xa4, commonName(issuerCommonName))), der(0x82, issuerSerial)] : []),
    ))),
  ];
}

/** The issuer identity a CA-signed leaf names in its authority key identifier. */
function issuerFor(signingKey: KeyObject, caCertificate: string | undefined): Issuer | undefined {
  if (caCertificate) return issuerFromCertificate(caCertificate);
  return { commonName: LOOPBACK_CA_NAME, publicKey: createPublicKey(signingKey), serial: Buffer.alloc(0) };
}

interface Issuer { commonName: string; publicKey: KeyObject; serial: Buffer }

function issuerFromCertificate(caCertificate: string): Issuer {
  const parsed = new X509Certificate(caCertificate);
  return { commonName: LOOPBACK_CA_NAME, publicKey: parsed.publicKey, serial: serialBytes(parsed.serialNumber) };
}

function certificate(
  subjectCommonName: string,
  issuerCommonName: string,
  publicKey: KeyObject,
  signingKey: KeyObject,
  createdAt: number,
  lifetimeMs: number,
  extensionItems: Buffer[],
  issuer?: Issuer,
): { certificate: string; expirationDate: number } {
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) || 1;
  // A self-signed certificate is its own issuer: its authority key identifier names its own key and serial.
  const authority = issuer ?? { commonName: issuerCommonName, publicKey, serial };
  const extensions = der(0xa3, der(0x30, ...extensionItems, ...keyIdentifierExtensions(publicKey, authority.publicKey, authority.commonName, authority.serial)));
  const notBefore = new Date(createdAt - 60_000);
  const expirationDate = createdAt + lifetimeMs;
  const notAfter = new Date(expirationDate);
  const tbs = der(0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    algorithmIdentifier(),
    commonName(issuerCommonName),
    der(0x30, utcTime(notBefore), utcTime(notAfter)),
    commonName(subjectCommonName),
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", tbs, signingKey);
  return { certificate: pem("CERTIFICATE", der(0x30, tbs, algorithmIdentifier(), der(0x03, Buffer.concat([Buffer.from([0]), signature])))), expirationDate };
}

export function createSelfSignedClientCertificate(commonNameValue: string, createdAt: number, lifetimeMs = 365 * 24 * 60 * 60_000): { certificate: string; expirationDate: number } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const extensions = [
    der(0x30, oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x30))),
    der(0x30, oid("2.5.29.15"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x03, Buffer.from([0x05, 0xa0])))),
  ];
  return certificate(commonNameValue, commonNameValue, publicKey, privateKey, createdAt, lifetimeMs, extensions);
}

/** Create a persisted signing identity for local message-signature verification. */
export function createSelfSignedSigningCertificate(
  commonNameValue: string,
  createdAt: number,
  lifetimeMs = 10 * 365 * 24 * 60 * 60_000,
): { certificate: string; privateKey: string; expirationDate: number } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const extensions = [
    der(0x30, oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x30))),
    der(0x30, oid("2.5.29.15"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x03, Buffer.from([0x03, 0xc0])))),
  ];
  const signed = certificate(commonNameValue, commonNameValue, publicKey, privateKey, createdAt, lifetimeMs, extensions);
  return {
    ...signed,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/**
 * Create the private development PKI used only by the loopback
 * CloudFormation custom-resource callback listener.  Callers persist the CA
 * certificate and leaf material in a private simulator directory; only the CA
 * path is injected into Lambda runtimes.
 */
export function createLoopbackServerCertificate(
  createdAt: number,
  lifetimeMs = 365 * 24 * 60 * 60_000,
): { caCertificate: string; caPrivateKey: string; certificate: string; privateKey: string; expirationDate: number } {
  const caName = LOOPBACK_CA_NAME;
  const caKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const caExtensions = [
    der(0x30, oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x30, der(0x01, Buffer.from([0xff]))))),
    der(0x30, oid("2.5.29.15"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x03, Buffer.from([0x01, 0x06])))),
  ];
  const ca = certificate(caName, caName, caKeys.publicKey, caKeys.privateKey, createdAt, Math.max(lifetimeMs, 10 * 365 * 24 * 60 * 60_000), caExtensions);

  const leafKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const leafExtensions = [
    der(0x30, oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x30))),
    der(0x30, oid("2.5.29.15"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x03, Buffer.from([0x05, 0xa0])))),
    der(0x30, oid("2.5.29.37"), der(0x04, der(0x30, oid("1.3.6.1.5.5.7.3.1")))),
    der(0x30, oid("2.5.29.17"), der(0x04, der(0x30,
      der(0x82, Buffer.from("localhost", "ascii")),
      der(0x87, Buffer.from([127, 0, 0, 1])),
    ))),
  ];
  const leaf = certificate("localhost", caName, leafKeys.publicKey, caKeys.privateKey, createdAt, lifetimeMs, leafExtensions, issuerFromCertificate(ca.certificate));
  return {
    caCertificate: ca.certificate,
    caPrivateKey: caKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    certificate: leaf.certificate,
    privateKey: leafKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    expirationDate: leaf.expirationDate,
  };
}

/** Loopback names of the local HTTPS S3 endpoint: path style on the IPs and `localhost`, virtual-hosted style under `s3.localhost`. */
export const LOOPBACK_S3_DNS_NAMES = Object.freeze(["localhost", "s3.localhost", "*.s3.localhost"]);

/**
 * Issue the local HTTPS S3 endpoint's leaf under the persisted
 * installation-local CA.  `*.s3.localhost` rather than `*.localhost`: OpenSSL
 * (and so Python clients such as botocore) rejects a wildcard with fewer than
 * two labels after it.
 */
export function createLoopbackS3Certificate(
  caPrivateKey: string,
  createdAt: number,
  lifetimeMs = 365 * 24 * 60 * 60_000,
  caCertificate?: string,
): { certificate: string; privateKey: string; expirationDate: number } {
  const signingKey = createPrivateKey(caPrivateKey);
  const leafKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const leafExtensions = [
    der(0x30, oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x30))),
    der(0x30, oid("2.5.29.15"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x03, Buffer.from([0x07, 0x80])))),
    der(0x30, oid("2.5.29.37"), der(0x04, der(0x30, oid("1.3.6.1.5.5.7.3.1")))),
    der(0x30, oid("2.5.29.17"), der(0x04, der(0x30,
      ...LOOPBACK_S3_DNS_NAMES.map(name => der(0x82, Buffer.from(name, "ascii"))),
      der(0x87, Buffer.from([127, 0, 0, 1])),
      der(0x87, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])),
    ))),
  ];
  const leaf = certificate("s3.localhost", LOOPBACK_CA_NAME, leafKeys.publicKey, signingKey, createdAt, lifetimeMs, leafExtensions, issuerFor(signingKey, caCertificate));
  return {
    ...leaf,
    privateKey: leafKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Issue one exact-host viewer leaf under the persisted installation-local CA. */
export function createLoopbackHostCertificate(
  host: string,
  caPrivateKey: string,
  createdAt: number,
  lifetimeMs = 365 * 24 * 60 * 60_000,
  caCertificate?: string,
): { certificate: string; privateKey: string; expirationDate: number } {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.localhost$/.test(host)) throw new TypeError("Loopback certificate host must be one exact lowercase .localhost name");
  const signingKey = createPrivateKey(caPrivateKey);
  const leafKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const leafExtensions = [
    der(0x30, oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x30))),
    der(0x30, oid("2.5.29.15"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x03, Buffer.from([0x05, 0xa0])))),
    der(0x30, oid("2.5.29.37"), der(0x04, der(0x30, oid("1.3.6.1.5.5.7.3.1")))),
    der(0x30, oid("2.5.29.17"), der(0x04, der(0x30, der(0x82, Buffer.from(host, "ascii"))))),
  ];
  const leaf = certificate(host, LOOPBACK_CA_NAME, leafKeys.publicKey, signingKey, createdAt, lifetimeMs, leafExtensions, issuerFor(signingKey, caCertificate));
  return {
    ...leaf,
    privateKey: leafKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
