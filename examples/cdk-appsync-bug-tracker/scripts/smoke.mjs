import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { graphqlRequest, readManifest, sdkConfig } from "./common.mjs";

const BUG_FIELDS = "id title description status severity component environment reporterId assigneeId createdAt updatedAt resolvedAt";
const manifest = await readManifest();
const request = (query, variables) => graphqlRequest(manifest, query, variables);

const first = await request(`query Page($limit:Int,$nextToken:String){listBugs(limit:$limit,nextToken:$nextToken){items{id} nextToken scannedCount}}`, { limit: 2 });
if (first.listBugs.items.length !== 2 || !first.listBugs.nextToken) throw new Error("List pagination did not return two bugs and an opaque nextToken.");
const second = await request(`query Page($limit:Int,$nextToken:String){listBugs(limit:$limit,nextToken:$nextToken){items{id} nextToken}}`, { limit: 2, nextToken: first.listBugs.nextToken });
if (!second.listBugs.items.length || second.listBugs.items.some(item => first.listBugs.items.some(previous => previous.id === item.id))) throw new Error("Second pagination page was empty or repeated an item.");
if (/BUG-|\"id\"/.test(first.listBugs.nextToken)) throw new Error("AppSync nextToken exposed raw key material.");

const get = await request(`query Get($id:ID!){getBug(id:$id){${BUG_FIELDS}}}`, { id: "BUG-101" });
if (get.getBug?.severity !== "CRITICAL") throw new Error("getBug did not return BUG-101.");
const status = await request(`query Status($status:BugStatus!){bugsByStatus(status:$status,limit:10){items{id status}}}`, { status: "RESOLVED" });
if (status.bugsByStatus.items.length !== 2 || status.bugsByStatus.items.some(item => item.status !== "RESOLVED")) throw new Error("by-status GSI query did not return the two resolved bugs.");
const assigned = await request(`query Assigned($id:ID!){bugsByAssignee(assigneeId:$id,limit:10){items{id assigneeId}}}`, { id: "USR-003" });
if (!assigned.bugsByAssignee.items.length || assigned.bugsByAssignee.items.some(item => item.assigneeId !== "USR-003")) throw new Error("by-assignee GSI query returned invalid items.");

const temporary = {
  id: "BUG-SMOKE", title: "Smoke-test mutation", description: "Temporary create, get, and delete verification record.",
  status: "BACKLOG", severity: "LOW", component: "Test", environment: "Local", reporterId: "USR-006",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};
await request(`mutation Save($input:BugInput!){saveBug(input:$input){id title}}`, { input: temporary });
if (!(await request(`query Get($id:ID!){getBug(id:$id){id}}`, { id: temporary.id })).getBug) throw new Error("Temporary save/get path failed.");
await request(`mutation Delete($id:ID!){deleteBug(id:$id){id}}`, { id: temporary.id });
if ((await request(`query Get($id:ID!){getBug(id:$id){id}}`, { id: temporary.id })).getBug !== null) throw new Error("Temporary delete path failed.");

const dynamodb = new DynamoDBClient(sdkConfig());
const [userRows, bugRows] = await Promise.all([
  dynamodb.send(new ScanCommand({ TableName: manifest.usersTableName, Select: "COUNT" })),
  dynamodb.send(new ScanCommand({ TableName: manifest.ticketsTableName, Select: "COUNT" })),
]);
if (userRows.Count !== 6 || bugRows.Count !== 12) throw new Error(`Authoritative DynamoDB counts were users=${userRows.Count}, bugs=${bugRows.Count}; expected 6/12.`);

const website = await fetch(manifest.websiteUrl);
if (!website.ok || !(await website.text()).includes("Team Bug Triage")) throw new Error(`Website did not load from ${manifest.websiteUrl}.`);
console.log("[bug-tracker] smoke passed: get, scan, pagination, both GSI queries, save, delete, DynamoDB counts, and website");
