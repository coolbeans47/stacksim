function record(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function apply(headers: Record<string, string>, name: string, config: unknown, render: (value: Record<string, any>) => string): void {
  if (!record(config)) return;
  const lower = name.toLowerCase();
  if (config.Override === true || headers[lower] === undefined) headers[lower] = render(config);
}

export function applySecurityHeaders(headers: Record<string, string>, security: Record<string, unknown>): Record<string, string> {
  const output = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  apply(output, "content-security-policy", security.ContentSecurityPolicy, value => String(value.ContentSecurityPolicy));
  apply(output, "x-content-type-options", security.ContentTypeOptions, () => "nosniff");
  apply(output, "x-frame-options", security.FrameOptions, value => String(value.FrameOption));
  apply(output, "referrer-policy", security.ReferrerPolicy, value => String(value.ReferrerPolicy));
  apply(output, "strict-transport-security", security.StrictTransportSecurity, value => {
    let result = `max-age=${Number(value.AccessControlMaxAgeSec)}`;
    if (value.IncludeSubdomains === true) result += "; includeSubDomains";
    if (value.Preload === true) result += "; preload";
    return result;
  });
  return output;
}

export function validateOpeningSecurityHeaders(value: unknown): string | undefined {
  if (!record(value)) return "SecurityHeadersConfig must be an object";
  const allowed = new Set(["ContentSecurityPolicy", "ContentTypeOptions", "FrameOptions", "ReferrerPolicy", "StrictTransportSecurity"]);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) return `SecurityHeadersConfig.${unknown} is outside CFR-01`;
  if (!["ContentSecurityPolicy", "ContentTypeOptions", "FrameOptions", "ReferrerPolicy", "StrictTransportSecurity"].every(key => record(value[key]) && value[key].Override === true)) return "The CFR-01 security policy requires all five supported headers with Override=true";
  if (!["DENY", "SAMEORIGIN"].includes(String(value.FrameOptions.FrameOption))) return "FrameOption must be DENY or SAMEORIGIN";
  if (typeof value.ContentSecurityPolicy.ContentSecurityPolicy !== "string" || !value.ContentSecurityPolicy.ContentSecurityPolicy) return "ContentSecurityPolicy is required";
  if (!Number.isSafeInteger(value.StrictTransportSecurity.AccessControlMaxAgeSec) || value.StrictTransportSecurity.AccessControlMaxAgeSec < 0) return "AccessControlMaxAgeSec must be a non-negative integer";
  return undefined;
}
