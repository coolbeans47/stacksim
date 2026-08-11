import {
  AppSyncClient,
  GetDataSourceCommand,
  GetGraphqlApiCommand,
} from "@aws-sdk/client-appsync";
import { graphqlRequest, readManifest, sdkConfig } from "./common.mjs";
import { seedThroughGraphql } from "./seed-lib.mjs";

export async function main() {
  const manifest = await readManifest();
  const client = new AppSyncClient(sdkConfig());
  const api = (await client.send(new GetGraphqlApiCommand({ apiId: manifest.apiId }))).graphqlApi;
  if (api?.uris?.GRAPHQL !== manifest.graphqlEndpoint) throw new Error("The manifest endpoint does not match the authoritative AppSync API.");
  const [usersSource, ticketsSource] = await Promise.all([
    client.send(new GetDataSourceCommand({ apiId: manifest.apiId, name: "BugUsers" })),
    client.send(new GetDataSourceCommand({ apiId: manifest.apiId, name: "BugTickets" })),
  ]);
  if (usersSource.dataSource?.dynamodbConfig?.tableName !== manifest.usersTableName || ticketsSource.dataSource?.dynamodbConfig?.tableName !== manifest.ticketsTableName) {
    throw new Error("The manifest table names do not match the deployed AppSync data sources. Refusing to seed.");
  }
  const result = await seedThroughGraphql((query, variables) => graphqlRequest(manifest, query, variables));
  console.log(`[bug-tracker] users: ${result.users.created} created, ${result.users.updated} updated, ${result.users.total} total`);
  console.log(`[bug-tracker] bugs: ${result.bugs.created} created, ${result.bugs.updated} updated, ${result.bugs.total} total`);
  console.log(`[bug-tracker] verified status query (${result.statusQueryCount}) and assignee query (${result.assigneeQueryCount})`);
  console.log(`[bug-tracker] website: ${manifest.websiteUrl}`);
  console.log(`[bug-tracker] GraphQL: ${manifest.graphqlEndpoint}`);
  return result;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error(`[bug-tracker] seed failed: ${error.stack || error.message}`); process.exitCode = 1; });
}
