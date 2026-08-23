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
