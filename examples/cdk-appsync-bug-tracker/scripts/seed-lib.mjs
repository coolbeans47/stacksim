import { bugs, users } from "../seed/demo-data.mjs";

const USER_FIELDS = "id name team avatarColor";
const BUG_FIELDS = "id title description status severity component environment reporterId assigneeId createdAt updatedAt resolvedAt";

async function collect(request, field, query) {
  const items = [];
  let nextToken = null;
  do {
    const data = await request(query, { limit: 5, nextToken });
    items.push(...data[field].items);
    nextToken = data[field].nextToken;
  } while (nextToken);
  return items;
}

export async function seedThroughGraphql(request) {
  const beforeUsers = await collect(request, "listUsers", `query ExistingUsers($limit:Int,$nextToken:String){listUsers(limit:$limit,nextToken:$nextToken){items{id} nextToken}}`);
  const beforeBugs = await collect(request, "listBugs", `query ExistingBugs($limit:Int,$nextToken:String){listBugs(limit:$limit,nextToken:$nextToken){items{id} nextToken}}`);
  const knownUsers = new Set(beforeUsers.map(item => item.id));
  const knownBugs = new Set(beforeBugs.map(item => item.id));

  for (const input of users) await request(`mutation SeedUser($input:UserInput!){saveUser(input:$input){${USER_FIELDS}}}`, { input });
  for (const input of bugs) await request(`mutation SeedBug($input:BugInput!){saveBug(input:$input){${BUG_FIELDS}}}`, { input });

  const verifiedUsers = await collect(request, "listUsers", `query VerifyUsers($limit:Int,$nextToken:String){listUsers(limit:$limit,nextToken:$nextToken){items{${USER_FIELDS}} nextToken}}`);
  const verifiedBugs = await collect(request, "listBugs", `query VerifyBugs($limit:Int,$nextToken:String){listBugs(limit:$limit,nextToken:$nextToken){items{${BUG_FIELDS}} nextToken}}`);
  const byStatus = await request(`query VerifyStatus($status:BugStatus!){bugsByStatus(status:$status,limit:3){items{id status} nextToken}}`, { status: "TRIAGE" });
  const byAssignee = await request(`query VerifyAssignee($id:ID!){bugsByAssignee(assigneeId:$id,limit:3){items{id assigneeId} nextToken}}`, { id: "USR-003" });
  if (verifiedUsers.filter(item => users.some(seed => seed.id === item.id)).length !== users.length) throw new Error("User verification did not return all six stable seed IDs.");
  if (verifiedBugs.filter(item => bugs.some(seed => seed.id === item.id)).length !== bugs.length) throw new Error("Bug verification did not return all twelve stable seed IDs.");
  if (!byStatus.bugsByStatus.items.length || !byAssignee.bugsByAssignee.items.length) throw new Error("GSI verification queries returned no seeded bugs.");

  return {
    users: { created: users.filter(item => !knownUsers.has(item.id)).length, updated: users.filter(item => knownUsers.has(item.id)).length, total: verifiedUsers.length },
    bugs: { created: bugs.filter(item => !knownBugs.has(item.id)).length, updated: bugs.filter(item => knownBugs.has(item.id)).length, total: verifiedBugs.length },
    statusQueryCount: byStatus.bugsByStatus.items.length,
    assigneeQueryCount: byAssignee.bugsByAssignee.items.length,
  };
}
