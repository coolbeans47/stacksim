import { DOMParser, type Element as XmlElement, type Node as XmlNode } from "@xmldom/xmldom";
import type { ServerResponse } from "node:http";
import { CLOUDFRONT_XML_NAMESPACE } from "./model.js";

export class CloudFrontError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = code; }
}

export function escapeXml(value: unknown): string { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }

function elementChildren(node: XmlNode): XmlElement[] { return [...Array.from(node.childNodes)].filter(child => child.nodeType === 1) as XmlElement[]; }

function decodeElement(node: XmlElement, depth = 0): any {
  if (depth > 32) throw new CloudFrontError("InvalidArgument", "XML nesting exceeds the supported limit", 400);
  const children = elementChildren(node);
  if (!children.length) {
    const text = node.textContent ?? "";
    if (text === "true") return true;
    if (text === "false") return false;
    if (/^(?:Quantity|DefaultTTL|MaxTTL|MinTTL|AccessControlMaxAgeSec)$/.test(node.tagName) && /^\d+$/.test(text)) return Number(text);
    return text;
  }
  const value: Record<string, unknown> = {};
  for (const child of children) {
    const decoded = decodeElement(child, depth + 1);
    if (value[child.tagName] === undefined) value[child.tagName] = decoded;
    else if (Array.isArray(value[child.tagName])) (value[child.tagName] as unknown[]).push(decoded);
    else value[child.tagName] = [value[child.tagName], decoded];
  }
  return value;
}

export function parseCloudFrontXml(body: Buffer, expectedRoot?: string): { root: string; value: Record<string, any> } {
  if (body.length > 1024 * 1024) throw new CloudFrontError("InvalidArgument", "Request body exceeds 1 MiB", 413);
  const source = body.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new CloudFrontError("InvalidArgument", "DOCTYPE and entity declarations are not allowed", 400);
  const errors: string[] = [];
  const document = new DOMParser({ onError: message => errors.push(message) }).parseFromString(source, "application/xml");
  const root = document.documentElement;
  if (!root || root.tagName === "parsererror" || errors.length) throw new CloudFrontError("InvalidArgument", "The XML request is malformed", 400);
  if (expectedRoot && root.tagName !== expectedRoot) throw new CloudFrontError("InvalidArgument", `Expected ${expectedRoot}`, 400);
  if (root.namespaceURI && root.namespaceURI !== CLOUDFRONT_XML_NAMESPACE) throw new CloudFrontError("InvalidArgument", "The CloudFront XML namespace is invalid", 400);
  return { root: root.tagName, value: decodeElement(root) };
}

const ITEM_NAMES: Record<string, string> = {
  Origins: "Origin", CacheBehaviors: "CacheBehavior", FunctionAssociations: "FunctionAssociation", LambdaFunctionAssociations: "LambdaFunctionAssociation",
  AllowedMethods: "Method", CachedMethods: "Method", Tags: "Tag", Paths: "Path", Aliases: "CNAME", TrustedKeyGroups: "KeyGroup", TrustedSigners: "AwsAccountNumber",
  Headers: "Name", Cookies: "Name", QueryStrings: "Name",
};

export function xmlElement(name: string, value: any, namespace = false): string {
  const ns = namespace ? ` xmlns="${CLOUDFRONT_XML_NAMESPACE}"` : "";
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(item => xmlElement(name, item)).join("");
  if (typeof value !== "object") return `<${name}${ns}>${escapeXml(value instanceof Date ? value.toISOString() : value)}</${name}>`;
  let body = "";
  for (const [key, item] of Object.entries(value)) {
    if (key === "Items" && Array.isArray(item)) body += `<Items>${item.map(entry => xmlElement(ITEM_NAMES[name] ?? "member", entry)).join("")}</Items>`;
    else if (key === "Items" && item && typeof item === "object") body += `<Items>${Object.entries(item as Record<string, unknown>).map(([member, values]) => Array.isArray(values) ? values.map(entry => xmlElement(member, entry)).join("") : xmlElement(member, values)).join("")}</Items>`;
    else body += xmlElement(key, item);
  }
  return `<${name}${ns}>${body}</${name}>`;
}

export function sendCloudFrontXml(res: ServerResponse, requestId: string, root: string, value: unknown, status = 200, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/xml");
  res.setHeader("x-amzn-requestid", requestId);
  for (const [name, header] of Object.entries(headers)) res.setHeader(name, header);
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${xmlElement(root, value, true)}`);
}

export function sendCloudFrontError(res: ServerResponse, requestId: string, error: unknown): void {
  const modeled = error instanceof CloudFrontError ? error : new CloudFrontError("InternalError", error instanceof Error ? error.message : String(error), 500);
  sendCloudFrontXml(res, requestId, "ErrorResponse", { Error: { Type: "Sender", Code: modeled.code, Message: modeled.message }, RequestId: requestId }, modeled.status);
}
