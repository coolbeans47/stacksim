import Handlebars from "handlebars";
import { AwsError } from "../errors.js";

export interface TemplateContent {
  Subject?: string;
  Text?: string;
  Html?: string;
}

export interface TemplateRenderResult {
  content?: TemplateContent;
  error?: { code: string; message: string };
}

export function parseTemplateData(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new AwsError("InvalidParameterValue", "TemplateData must be a JSON object encoded as a string.", 400);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AwsError("InvalidParameterValue", "TemplateData must be valid JSON.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AwsError("InvalidParameterValue", "TemplateData must contain a JSON object.", 400);
  }
  return parsed as Record<string, unknown>;
}

function renderPart(source: string | undefined, data: Record<string, unknown>): string | undefined {
  if (source === undefined) return undefined;
  const template = Handlebars.compile(source, {
    strict: true,
    preventIndent: true,
    assumeObjects: false,
  });
  return template(data, {
    allowProtoMethodsByDefault: false,
    allowProtoPropertiesByDefault: false,
  });
}

export function renderTemplate(content: TemplateContent, templateData: unknown): TemplateRenderResult {
  const data = parseTemplateData(templateData);
  try {
    return {
      content: {
        Subject: renderPart(content.Subject, data),
        Text: renderPart(content.Text, data),
        Html: renderPart(content.Html, data),
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "The template could not be rendered.";
    return {
      error: {
        code: "TEMPLATE_RENDERING_FAILURE",
        message: `The template could not be rendered: ${detail}`.slice(0, 512),
      },
    };
  }
}

export function renderTemplateOrThrow(content: TemplateContent, templateData: unknown): TemplateContent {
  const result = renderTemplate(content, templateData);
  if (result.error) throw new AwsError("InvalidRenderingParameter", result.error.message, 400);
  return result.content!;
}

export function validateTemplateName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new AwsError("InvalidParameterValue", "Template name must be 1-64 letters, numbers, underscores, or hyphens.", 400);
  }
  return value;
}

export function validateTemplateContent(value: unknown): Required<Pick<TemplateContent, "Subject">> & TemplateContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AwsError("InvalidParameterValue", "Template content is required.", 400);
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(["Subject", "Text", "Html", "SubjectPart", "TextPart", "HtmlPart"]);
  if (Object.keys(candidate).some(key => !allowed.has(key))) throw new AwsError("InvalidParameterValue", "Template content contains an unsupported field.", 400);
  const Subject = candidate.Subject ?? candidate.SubjectPart;
  const Text = candidate.Text ?? candidate.TextPart;
  const Html = candidate.Html ?? candidate.HtmlPart;
  if (typeof Subject !== "string") throw new AwsError("InvalidParameterValue", "Template subject is required.", 400);
  if (Text !== undefined && typeof Text !== "string" || Html !== undefined && typeof Html !== "string") {
    throw new AwsError("InvalidParameterValue", "Template text and HTML parts must be strings.", 400);
  }
  const bytes = Buffer.byteLength(Subject) + (Text === undefined ? 0 : Buffer.byteLength(Text)) + (Html === undefined ? 0 : Buffer.byteLength(Html));
  if (bytes > 500 * 1024) throw new AwsError("InvalidParameterValue", "Template content exceeds the 500 KB SES limit.", 400);
  return { Subject, ...(Text === undefined ? {} : { Text }), ...(Html === undefined ? {} : { Html }) };
}

export function renderedTemplateSource(content: TemplateContent): string {
  const lines = [`Subject: ${content.Subject ?? ""}`, "MIME-Version: 1.0"];
  if (content.Text !== undefined && content.Html !== undefined) {
    const boundary = "stacksim-template-render";
    lines.push(
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      content.Text,
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "",
      content.Html,
      `--${boundary}--`,
    );
  } else {
    const html = content.Html !== undefined;
    lines.push(`Content-Type: ${html ? "text/html" : "text/plain"}; charset=UTF-8`, "", html ? content.Html! : content.Text ?? "");
  }
  return lines.join("\r\n");
}
