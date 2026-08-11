import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

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

function certificate(
  subjectCommonName: string,
  issuerCommonName: string,
  publicKey: KeyObject,
  signingKey: KeyObject,
  createdAt: number,
  lifetimeMs: number,
  extensions: Buffer,
): { certificate: string; expirationDate: number } {
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) || 1;
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
  const extensions = der(0xa3, der(0x30,
    der(0x30, oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x30))),
    der(0x30, oid("2.5.29.15"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x03, Buffer.from([0x05, 0xa0])))),
  ));
  return certificate(commonNameValue, commonNameValue, publicKey, privateKey, createdAt, lifetimeMs, extensions);
}

/** Create a persisted signing identity for local message-signature verification. */
export function createSelfSignedSigningCertificate(
  commonNameValue: string,
  createdAt: number,
  lifetimeMs = 10 * 365 * 24 * 60 * 60_000,
): { certificate: string; privateKey: string; expirationDate: number } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const extensions = der(0xa3, der(0x30,
    der(0x30, oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x30))),
    der(0x30, oid("2.5.29.15"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x03, Buffer.from([0x03, 0xc0])))),
  ));
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
): { caCertificate: string; certificate: string; privateKey: string; expirationDate: number } {
  const caName = "stacksim CloudFormation development CA";
  const caKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const caExtensions = der(0xa3, der(0x30,
    der(0x30, oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x30, der(0x01, Buffer.from([0xff]))))),
    der(0x30, oid("2.5.29.15"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x03, Buffer.from([0x01, 0x06])))),
  ));
  const ca = certificate(caName, caName, caKeys.publicKey, caKeys.privateKey, createdAt, Math.max(lifetimeMs, 10 * 365 * 24 * 60 * 60_000), caExtensions);

  const leafKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const leafExtensions = der(0xa3, der(0x30,
    der(0x30, oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x30))),
    der(0x30, oid("2.5.29.15"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x03, Buffer.from([0x05, 0xa0])))),
    der(0x30, oid("2.5.29.37"), der(0x04, der(0x30, oid("1.3.6.1.5.5.7.3.1")))),
    der(0x30, oid("2.5.29.17"), der(0x04, der(0x30,
      der(0x82, Buffer.from("localhost", "ascii")),
      der(0x87, Buffer.from([127, 0, 0, 1])),
    ))),
  ));
  const leaf = certificate("localhost", caName, leafKeys.publicKey, caKeys.privateKey, createdAt, lifetimeMs, leafExtensions);
  return {
    caCertificate: ca.certificate,
    certificate: leaf.certificate,
    privateKey: leafKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    expirationDate: leaf.expirationDate,
  };
}
