import type { SimState } from "../types.js";

export function migrateV15ToV16(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) region.lambdaEventSourceMappings ??= {};
    const policy = account.iam?.policies?.["arn:aws:iam::aws:policy/service-role/AWSLambdaDynamoDBExecutionRole"];
    const version = policy?.versions?.[policy.defaultVersionId];
    if (version) version.document = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams", "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }] };
  }
  state.schemaVersion = 16;
  return state;
}
