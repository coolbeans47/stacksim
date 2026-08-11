import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = resolve(sourceRoot, "test", "fixtures", "amplify-gen2-data");
const outputPath = resolve(process.argv[2]);
const label = process.argv[3] ?? "amx09";
const mode = process.argv[4] ?? "full";
const output = JSON.parse(await readFile(outputPath, "utf8"));
const requireFromFixture = createRequire(resolve(fixture, "package.json"));
const { Amplify } = requireFromFixture("aws-amplify");
const { generateClient } = requireFromFixture("aws-amplify/data");

Amplify.configure(output);
const client = generateClient();

if (mode === "negative") {
  const rejected = async candidate => {
    try {
      Amplify.configure(candidate);
      const result = await generateClient().models.Todo.list();
      return Array.isArray(result.errors) && result.errors.length > 0;
    } catch { return true; }
  };
  const wrongKey = structuredClone(output); wrongKey.data.api_key = `da2-${"x".repeat(32)}`;
  const wrongRegion = structuredClone(output); wrongRegion.data.url = wrongRegion.data.url.replace(`/${wrongRegion.data.aws_region}/`, "/us-east-1/"); wrongRegion.data.aws_region = "us-east-1";
  const wrongApi = structuredClone(output); wrongApi.data.url = wrongApi.data.url.replace(/.$/, value => value === "0" ? "1" : "0");
  const missing = structuredClone(output); delete missing.data;
  const invalidVersion = structuredClone(output); invalidVersion.version = "99";
  const missingIntrospection = structuredClone(output); delete missingIntrospection.data.model_introspection;
  process.stdout.write(JSON.stringify({
    wrongApiKey: await rejected(wrongKey), mixedGeneration: await rejected(wrongKey), crossRegionEndpoint: await rejected(wrongRegion),
    wrongApiGeneration: await rejected(wrongApi), missingData: await rejected(missing), invalidVersion: await rejected(invalidVersion), missingModelIntrospection: await rejected(missingIntrospection),
  }));
  process.exit(0);
}
const received = { create: [], update: [], delete: [] };
const subscriptions = [];
const subscriptionErrors = [];
const waiters = { create: [], update: [], delete: [] };
const waitFor = name => received[name].length
  ? Promise.resolve()
  : new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${name} subscription`)), 5_000);
      waiters[name].push(() => { clearTimeout(timer); resolvePromise(); });
    });

try {
  for (const [name, operation] of [["create", "onCreate"], ["update", "onUpdate"], ["delete", "onDelete"]]) {
    subscriptions.push(client.models.Todo[operation]().subscribe({
      next(value) { received[name].push(value); waiters[name].splice(0).forEach(resolvePromise => resolvePromise()); },
      error() { subscriptionErrors.push(true); },
    }));
  }
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500));

  const first = await client.models.Todo.create({ title: `${label}-alpha`, priority: 1, completed: false });
  if (first.errors?.length) throw new Error(`Amplify create failed with ${first.errors.length} errors`);
  await waitFor("create");
  const second = await client.models.Todo.create({ title: `${label}-alphabet`, priority: 2, completed: false });
  if (second.errors?.length) throw new Error(`Amplify second create failed with ${second.errors.length} errors`);
  const got = await client.models.Todo.get({ id: first.data.id });
  const pageOne = await client.models.Todo.list({ filter: { title: { beginsWith: `${label}-alpha` } }, limit: 1 });
  const pageTwo = pageOne.nextToken
    ? await client.models.Todo.list({ filter: { title: { beginsWith: `${label}-alpha` } }, limit: 1, nextToken: pageOne.nextToken })
    : { data: [], nextToken: null, errors: [{ message: "missing pagination token" }] };
  let conditionError = false;
  try {
    await client.graphql({
      query: "mutation Conditional($input: UpdateTodoInput!, $condition: ModelTodoConditionInput) { updateTodo(input: $input, condition: $condition) { id title } }",
      variables: { input: { id: first.data.id, title: `${label}-blocked` }, condition: { priority: { eq: 99 } } },
    });
  } catch { conditionError = true; }
  const duplicate = await client.models.Todo.create({ id: first.data.id, title: `${label}-duplicate` });
  const updated = await client.models.Todo.update({ id: first.data.id, title: `${label}-updated`, description: null });
  if (updated.errors?.length) throw new Error(`Amplify update failed with ${updated.errors.length} errors`);
  await waitFor("update");
  const deleted = await client.models.Todo.delete({ id: first.data.id });
  if (deleted.errors?.length) throw new Error(`Amplify delete failed with ${deleted.errors.length} errors`);
  await waitFor("delete");
  await client.models.Todo.delete({ id: second.data.id });
  const empty = await client.models.Todo.list();
  process.stdout.write(JSON.stringify({
    configuredFromGeneratedOutput: true,
    create: Boolean(first.data?.id),
    get: got.data?.id === first.data.id,
    filter: pageOne.data.length === 1 && pageTwo.data.length === 1,
    pagination: Boolean(pageOne.nextToken) && pageTwo.nextToken === null,
    conditionError,
    duplicateError: Array.isArray(duplicate.errors) && duplicate.errors.length > 0,
    update: updated.data?.id === first.data.id,
    delete: deleted.data?.id === first.data.id && empty.data.length === 0,
    subscriptions: { create: received.create.length >= 2, update: received.update.length >= 1, delete: received.delete.length >= 1 },
    subscriptionErrors: subscriptionErrors.length,
  }));
} finally {
  subscriptions.forEach(subscription => subscription.unsubscribe());
}
