const BUG_FIELDS = `id title description status severity component environment reporterId assigneeId createdAt updatedAt resolvedAt`;
const USER_FIELDS = `id name team avatarColor`;

export async function loadRuntimeConfig() {
  const response = await fetch("./config.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Runtime configuration returned HTTP ${response.status}`);
  const config = await response.json();
  if (!config.configured || !config.graphqlEndpoint || !config.apiKey) {
    throw new Error(config.message || "The frontend is not configured. Run npm run deploy.");
  }
  return config;
}

export async function graphql(config, query, variables = {}) {
  const response = await fetch(config.graphqlEndpoint, {
    method: "POST",
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": config.apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) {
    throw new Error(body.errors?.map(error => error.message).join("; ") || `GraphQL returned HTTP ${response.status}`);
  }
  return body.data;
}

async function collect(config, field, query) {
  const items = [];
  let nextToken = null;
  do {
    const data = await graphql(config, query, { limit: 50, nextToken });
    items.push(...data[field].items);
    nextToken = data[field].nextToken;
  } while (nextToken);
  return items;
}

export const loadBugs = config => collect(config, "listBugs", `query Bugs($limit:Int,$nextToken:String){listBugs(limit:$limit,nextToken:$nextToken){items{${BUG_FIELDS}} nextToken scannedCount}}`);
export const loadUsers = config => collect(config, "listUsers", `query Users($limit:Int,$nextToken:String){listUsers(limit:$limit,nextToken:$nextToken){items{${USER_FIELDS}} nextToken scannedCount}}`);

export async function saveBug(config, input) {
  const data = await graphql(config, `mutation Save($input:BugInput!){saveBug(input:$input){${BUG_FIELDS}}}`, { input });
  return data.saveBug;
}

export async function deleteBug(config, id) {
  const data = await graphql(config, `mutation Delete($id:ID!){deleteBug(id:$id){id}}`, { id });
  return data.deleteBug;
}
