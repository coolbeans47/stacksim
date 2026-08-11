import type { ServerResponse } from "node:http";
import { AwsError } from "../errors.js";

export function xmlEscape(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function xmlDecode(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos);/gi, token => {
    if (token === "&amp;") return "&"; if (token === "&lt;") return "<"; if (token === "&gt;") return ">"; if (token === "&quot;") return '"'; if (token === "&apos;") return "'";
    const decimal = token.match(/^&#(\d+);$/); if (decimal) return String.fromCodePoint(Number(decimal[1]));
    const hexadecimal = token.match(/^&#x([\da-f]+);$/i); return hexadecimal ? String.fromCodePoint(Number.parseInt(hexadecimal[1], 16)) : token;
  });
}

export function xmlValues(xml: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...xml.matchAll(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "gi"))].map(match => xmlDecode(match[1].trim()));
}

export function xmlValue(xml: string, name: string): string | undefined { return xmlValues(xml, name)[0]; }

export function restXml(body: string, root?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${root ? `<${root} xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body}</${root}>` : body}`;
}

export function s3ErrorXml(error: AwsError, resource: string, requestId: string, hostId: string): string {
  return restXml(`<Error><Code>${xmlEscape(error.code)}</Code><Message>${xmlEscape(error.message)}</Message><Resource>${xmlEscape(resource)}</Resource><RequestId>${xmlEscape(requestId)}</RequestId><HostId>${xmlEscape(hostId)}</HostId></Error>`);
}

export function sendS3Error(res: ServerResponse, error: unknown, resource: string, requestId: string, hostId: string): void {
  const aws = error instanceof AwsError ? error : new AwsError("InternalError", error instanceof Error ? error.message : String(error), 500);
  res.statusCode = aws.status;
  res.setHeader("content-type", "application/xml");
  if (aws.details?.region) res.setHeader("x-amz-bucket-region", String(aws.details.region));
  if (aws.details?.deleteMarker !== undefined) res.setHeader("x-amz-delete-marker", String(aws.details.deleteMarker));
  if (aws.details?.versionId !== undefined) res.setHeader("x-amz-version-id", String(aws.details.versionId));
  res.end(s3ErrorXml(aws, resource, requestId, hostId));
}
