export const SECRETS_MANAGER_PSS_02_ACTIONS = new Set([
  "CreateSecret",
  "DeleteSecret",
  "DescribeSecret",
  "GetRandomPassword",
  "GetSecretValue",
  "ListSecrets",
  "ListSecretVersionIds",
  "PutSecretValue",
  "RestoreSecret",
  "TagResource",
  "UntagResource",
  "UpdateSecret",
]);

export const SECRETS_MANAGER_ACTIONS = new Set([
  ...SECRETS_MANAGER_PSS_02_ACTIONS,
  "BatchGetSecretValue",
  "UpdateSecretVersionStage",
  "DeleteResourcePolicy",
  "GetResourcePolicy",
  "PutResourcePolicy",
  "ValidateResourcePolicy",
  "RotateSecret",
  "CancelRotateSecret",
]);
