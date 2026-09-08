import type { PolicyDocument } from "../types.js";

/**
 * Inline unauthenticated enhanced-flow session policy from the Identity Pools
 * IAM-roles guide. Copied on CID-01 implementation day; do not merge with the
 * managed policy below.
 */
export const COGNITO_UNAUTH_INLINE_SESSION_POLICY: PolicyDocument = Object.freeze({
  Version: "2012-10-17",
  Statement: Object.freeze([
    Object.freeze({
      Effect: "Allow" as const,
      Action: Object.freeze([
        "cloudwatch:*",
        "logs:*",
        "dynamodb:*",
        "kinesis:*",
        "mobileanalytics:*",
        "s3:*",
        "ses:*",
        "sns:*",
        "sqs:*",
        "lambda:*",
        "machinelearning:*",
        "execute-api:*",
        "iot:*",
        "gamelift:*",
        "cognito-identity:*",
        "cognito-idp:*",
        "lex:*",
        "polly:*",
        "comprehend:*",
        "translate:*",
        "transcribe:*",
        "rekognition:*",
        "mobiletargeting:*",
        "firehose:*",
        "appsync:*",
        "personalize:*",
        "sagemaker:InvokeEndpoint",
        "cognito-sync:*",
        "codewhisperer:*",
        "textract:DetectDocumentText",
        "textract:AnalyzeDocument",
        "sdb:*",
      ]),
      Resource: Object.freeze(["*"]),
    }),
  ]),
});

/**
 * AWS managed `AmazonCognitoUnAuthedIdentitiesSessionPolicy` v4 as published
 * 2026-05-01. Does not include execute-api or s3.
 */
export const COGNITO_UNAUTH_MANAGED_SESSION_POLICY: PolicyDocument = Object.freeze({
  Version: "2012-10-17",
  Statement: Object.freeze([
    Object.freeze({
      Sid: "CognitoUnAuthedIdentitiesSessionPolicy",
      Effect: "Allow" as const,
      Action: Object.freeze([
        "rum:PutRumEvents",
        "sagemaker:InvokeEndpoint",
        "polly:*",
        "comprehend:*",
        "translate:*",
        "transcribe:*",
        "rekognition:*",
        "mobiletargeting:*",
        "firehose:*",
        "personalize:*",
        "geo:GetMap*",
        "geo:ListMaps",
        "geo:SearchPlaceIndex*",
        "geo:GetPlace",
        "geo:CalculateRoute*",
        "geo:*Geofence",
        "geo:*Geofences",
        "geo:*DevicePosition*",
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:ReEncryptTo",
        "kms:ReEncryptFrom",
        "kms:GenerateDataKey",
        "kms:GenerateDataKeyPair",
        "kms:GenerateDataKeyPairWithoutPlaintext",
        "kms:GenerateDataKeyWithoutPlaintext",
      ]),
      Resource: "*",
    }),
  ]),
});

export function guestSessionPolicies(): PolicyDocument[] {
  return [
    structuredClone(COGNITO_UNAUTH_INLINE_SESSION_POLICY),
    structuredClone(COGNITO_UNAUTH_MANAGED_SESSION_POLICY),
  ];
}
