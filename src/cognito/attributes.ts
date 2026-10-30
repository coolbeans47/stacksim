export const STANDARD_USER_ATTRIBUTES: ReadonlySet<string> = new Set([
  "address",
  "birthdate",
  "email",
  "family_name",
  "gender",
  "given_name",
  "locale",
  "middle_name",
  "name",
  "nickname",
  "phone_number",
  "picture",
  "preferred_username",
  "profile",
  "updated_at",
  "website",
  "zoneinfo",
]);

export const STANDARD_CLIENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  ...STANDARD_USER_ATTRIBUTES,
  "email_verified",
  "phone_number_verified",
]);

/**
 * AWS: "When you don't specify the ReadAttributes for your app client, your app can read the values of
 * email_verified, phone_number_verified, and the standard attributes of your user pool." The same rule,
 * without the verification flags, applies to WriteAttributes.
 */
export function clientCanReadAttribute(client: { readAttributes?: readonly string[] }, name: string): boolean {
  return client.readAttributes === undefined ? STANDARD_CLIENT_ATTRIBUTES.has(name) : client.readAttributes.includes(name);
}

export function clientCanWriteAttribute(client: { writeAttributes?: readonly string[] }, name: string): boolean {
  return client.writeAttributes === undefined ? STANDARD_USER_ATTRIBUTES.has(name) : client.writeAttributes.includes(name);
}

export function effectiveClientReadAttributes(client: { readAttributes?: readonly string[] }): string[] {
  return client.readAttributes === undefined ? [...STANDARD_CLIENT_ATTRIBUTES].sort() : [...client.readAttributes];
}

export function effectiveClientWriteAttributes(client: { writeAttributes?: readonly string[] }): string[] {
  return client.writeAttributes === undefined ? [...STANDARD_USER_ATTRIBUTES].sort() : [...client.writeAttributes];
}
