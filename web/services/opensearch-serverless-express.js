// Express Create composes public AOSS operations. It never adds a wire action,
// changes an existing policy, or removes resources after a partial failure.
const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const notFound = error => error.code === "ResourceNotFoundException" || error.name === "ResourceNotFoundException";
export async function expressCreate(api, input, token, progress = () => {}) {
  const { name, type, principal, collectionGroupName, description, tags } = input;
  if (!/^arn:aws(?:-[a-z]+)?:iam::\d{12}:(?:user|role)\/.+/.test(principal)) throw new Error("Express Create requires an IAM user or role ARN for data access.");
  const groupName = collectionGroupName || `nextgen-${name.replaceAll("_", "-")}`.slice(0, 32);
  const groups = await api("BatchGetCollectionGroup", { names: [groupName] });
  let group = groups.collectionGroupDetails[0];
  if (group) {
    if (group.generation !== "NEXTGEN") throw new Error("Select a NextGen collection group.");
    const members = await api("ListCollections", { collectionFilters: { collectionGroupName: groupName }, maxResults: 100 });
    if (members.collectionSummaries.length) {
      const details = await api("BatchGetCollection", { ids: members.collectionSummaries.map(value => value.id) });
      if (details.collectionDetails.some(collection => collection.type !== type)) throw new Error("The selected group contains a different collection type.");
    }
  } else {
    if (collectionGroupName) throw new Error("The selected collection group no longer exists.");
    progress(`Creating collection group ${groupName}`);
    group = (await api("CreateCollectionGroup", { name: groupName, generation: "NEXTGEN", standbyReplicas: "DISABLED", capacityLimits: { minIndexingCapacityInOCU: 0, minSearchCapacityInOCU: 0, maxIndexingCapacityInOCU: 96, maxSearchCapacityInOCU: 96 }, clientToken: `${token}-group` })).createCollectionGroupDetail;
  }
  // Hash the full name so distinct names truncated to 32 characters never share
  // security policies accidentally.
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const policyName = `express-${digest.slice(0, 24)}`;
  const policies = [
    { kind: "Security", type: "encryption", document: { Rules: [{ ResourceType: "collection", Resource: [`collection/${name}`] }], AWSOwnedKey: true } },
    { kind: "Security", type: "network", document: [{ Rules: [{ ResourceType: "collection", Resource: [`collection/${name}`] }], AllowFromPublic: true }] },
    { kind: "Access", type: "data", document: [{ Rules: [{ ResourceType: "index", Resource: [`index/${name}/*`], Permission: ["aoss:*"] }], Principal: [principal] }] },
  ];
  for (const policy of policies) {
    let current;
    try { current = (await api(`Get${policy.kind}Policy`, { name: policyName, type: policy.type }))[`${policy.kind.toLowerCase()}PolicyDetail`]; } catch (error) { if (!notFound(error)) throw error; }
    if (current) { if (canonical(current.policy) !== canonical(policy.document)) throw new Error(`Existing ${policy.type} policy ${policyName} differs from this request. Review it before continuing.`); }
    else { progress(`Creating ${policy.type} policy ${policyName}`); await api(`Create${policy.kind}Policy`, { name: policyName, type: policy.type, policy: JSON.stringify(policy.document), clientToken: `${token}-${policy.type}` }); }
  }
  progress(`Creating collection ${name}`);
  return api("CreateCollection", { name, type, description, tags, collectionGroupName: group.name, clientToken: `${token}-collection` });
}
