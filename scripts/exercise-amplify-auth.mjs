import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, createHmac } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { resolve } from 'node:path';
import { configureLocalAuth } from '../examples/amplify-auth-notes/src/configure.mjs';

const require = createRequire(resolve('test/fixtures/amplify-gen2-data/package.json'));
const { Amplify } = require('aws-amplify');
const { signUp, confirmSignUp, signIn, fetchAuthSession, signOut, getCurrentUser } = require('aws-amplify/auth');
const { generateClient } = require('aws-amplify/data');
const [outputPath, endpoint, mode = 'owner', label = 'fresh'] = process.argv.slice(2);
const outputs = JSON.parse(await readFile(outputPath, 'utf8'));
configureLocalAuth(Amplify, outputs, endpoint);
const check = (value, description) => assert.ok(value, description);
const authorizationDenied = value => (value?.errors ?? [value]).some(error =>
  [error?.errorType, error?.extensions?.errorType, error?.name].some(code =>
    ['Unauthorized', 'UnauthorizedException', 'AccessDeniedException', 'NotAuthorizedException'].includes(code)));
const digest = value => createHash('sha256').update(value).digest('hex');
class Sha256 {
  constructor(secret) { this.secret=secret; this.reset(); }
  reset() { this.value=this.secret ? createHmac('sha256',this.secret) : createHash('sha256'); }
  update(value) { this.value.update(value); }
  async digest() { return this.value.digest(); }
}
async function retainedCredentialRequest(credentials) {
  const url=new URL(outputs.data.url);
  const body=JSON.stringify({query:'{ listTodos { items { id } } }'});
  const signed=await new SignatureV4({credentials,region:outputs.data.aws_region,service:'appsync',sha256:Sha256}).sign({method:'POST',protocol:url.protocol,hostname:url.hostname,port:Number(url.port),path:url.pathname,headers:{host:url.host,'content-type':'application/json'},body});
  const response=await fetch(url,{method:'POST',headers:signed.headers,body});
  return response.json();
}
const evidence = { endpointOverrides: true, mode };
const password = 'Local-learning-password-42!';
const username = name => `${label}-${name}@example.test`;
async function confirm(name) {
  // The test controller reads the existing developer-safe SES mailbox. No
  // confirmation API is added, and no administrator credentials enter this client.
  process.send({ type: 'confirmation', username: name });
  const code = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Confirmation controller timed out')), 10000);
    process.once('message', message => { clearTimeout(timer); message.error ? fail(new Error('Confirmation unavailable')) : done(message.code); });
  });
  await confirmSignUp({ username: name, confirmationCode: code });
}
async function signup(name) {
  await signUp({ username: username(name), password, options: { userAttributes: { email: username(name) } } });
  await confirm(username(name));
}
async function login(name) {
  await signIn({ username: username(name), password });
  const session = await fetchAuthSession();
  check(session.tokens?.accessToken.payload.token_use === 'access', 'Access token returned');
  check(session.tokens?.idToken.payload.token_use === 'id', 'ID token returned');
  return session;
}
async function logout() { await signOut({ global: false }); }
const client = outputs.data ? generateClient() : undefined;
const subscriptions = [];
const received = [];
const errors = [];
const delay = ms => new Promise(done => setTimeout(done, ms));
const waitUntil = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(50); } assert.fail('Realtime event timed out'); };
const success = (result, message) => { check(!result.errors?.length && result.data, message); return result.data; };
try {
  if (mode === 'stale') {
    let rejected = false;
    try { await signIn({ username: username('alice'), password }); } catch (error) { rejected = error.name === 'ResourceNotFoundException'; }
    check(rejected, 'Deleted User Pool rejects old outputs');
    evidence.staleOutputsRejected = true;
  } else {
    let guestBefore;
    if (outputs.auth.identity_pool_id) {
      guestBefore = await fetchAuthSession();
      check(guestBefore.credentials && !guestBefore.tokens, 'Guest credentials without User Pool tokens');
      evidence.guest = true;
      if (mode === 'iam') {
        const denied = await client.models.Todo.list({ authMode: 'identityPool' });
        check(authorizationDenied(denied), 'Guest denied authenticated-only model');
        evidence.guestDataDenied = true;
      }
    }
    await signup('alice');
    const alice = await login('alice');
    const current = await getCurrentUser();
    check(current.userId === alice.tokens.accessToken.payload.sub, 'Active user comes from the same tokens');
    evidence.srpSignIn = true;
    evidence.confirmSignUp = true;
    const refreshed = await fetchAuthSession({ forceRefresh: true });
    check(refreshed.tokens?.accessToken.payload.sub === current.userId, 'Refresh retains the user');
    evidence.refresh = true;
    if (mode === 'iam') {
      check(alice.credentials && alice.credentials.accessKeyId !== guestBefore.credentials.accessKeyId, 'Authenticated session replaces guest credential');
      evidence.sessionCredentialDigest = digest(refreshed.credentials.accessKeyId);
      check(alice.identityId === guestBefore.identityId, 'Guest identity is atomically promoted by sign-in');
      evidence.guestIdentityPromoted = true;
      const created = await client.models.Todo.create({ title: `${label}-IAM` }, { authMode: 'identityPool' });
      const todo = success(created, `IAM Data create (${created.errors?.map(error => error.errorType ?? error.name ?? 'GraphQL error').join(',') ?? 'no errors'})`);
      success(await client.models.Todo.get({ id: todo.id }, { authMode: 'identityPool' }), 'IAM Data get');
      // The adjacent API is passed by the controller and has no grant in this
      // session's generated role. This still uses unmodified Amplify Data signing.
      if (process.env.STACKSIM_ADJACENT_API) {
        let rejected = false;
        try { const result = await generateClient({ endpoint: process.env.STACKSIM_ADJACENT_API, authMode: 'identityPool' }).graphql({ query: '{ listTodos { items { id } } }' }); rejected = authorizationDenied(result); } catch (error) { rejected = authorizationDenied(error); }
        check(rejected, 'Adjacent resource denied by generated IAM policy'); evidence.adjacentResourceDenied = true;
      }
      success(await client.models.Todo.delete({ id: todo.id }, { authMode: 'identityPool' }), 'IAM delete');
      evidence.iamData = true;
      process.send({ type: 'credentialProof', digest: evidence.sessionCredentialDigest });
      await new Promise((done,fail) => process.once('message', message => message.verified ? done() : fail(new Error('Session signing proof failed'))));
      await logout();
      const guestAfter = await fetchAuthSession();
      check(guestAfter.credentials && !guestAfter.tokens && guestAfter.credentials.accessKeyId !== alice.credentials.accessKeyId, 'Sign-out discards authenticated credentials');
      const denied = await client.models.Todo.list({ authMode: 'identityPool' });
      check(authorizationDenied(denied), 'Guest still denied after sign-out');
      evidence.signOutGuestFallback = true;
      const retained=await retainedCredentialRequest(refreshed.credentials);
      check(retained.data?.listTodos && !retained.errors?.length, 'Previously issued authenticated STS credentials remain valid after frontend sign-out');
      evidence.priorCredentialsRetainValidity = true;
      const returning = await login('alice');
      check(returning.identityId === alice.identityId && returning.identityId !== guestAfter.identityId, 'Returning login resolves the original authenticated identity');
      const returningTodo = success(await client.models.Todo.create({ title: `${label}-returning` }, { authMode: 'identityPool' }), 'Returning session Data create');
      success(await client.models.Todo.delete({ id: returningTodo.id }, { authMode: 'identityPool' }), 'Returning session Data delete');
      evidence.returningGuestLogin = true;
      await logout();
    } else if (mode === 'owner') {
      const aliceToken = alice.tokens.accessToken.toString();
      const aliceOwner = current.username;
      const first = success(await client.models.Todo.create({ title: `${label}-private`, priority: 1 }), 'Alice create');
      check(first.owner === aliceOwner, 'Generated pipeline stamps owner');
      const spoof = await client.models.Todo.create({ title: 'spoof', owner: 'someone-else' });
      check(spoof.errors?.length, 'Spoofed create denied');
      const transfer = await client.models.Todo.update({ id: first.id, owner: 'someone-else' });
      check(transfer.errors?.length, 'Owner transfer denied');
      const closeOwnerSubscriptions = async () => {
        subscriptions.splice(0).forEach(subscription => subscription.unsubscribe());
        // Amplify 6.20 deliberately keeps an empty provider connection for one
        // second. Let its documented subscription disposal finish before a new
        // user registers on the same endpoint/provider.
        await delay(1100);
      };
      subscriptions.push(client.models.Todo.onCreate({ authToken: aliceToken }).subscribe({ next: value => received.push({ user: 'alice', value }), error: () => errors.push('alice') }));
      await delay(700);
      check(!errors.length, 'Alice subscription registration succeeds');
      const second = success(await client.models.Todo.create({ title: `${label}-private-second`, priority: 2 }), 'Alice second create');
      await waitUntil(() => received.some(event => event.user === 'alice' && event.value.id === second.id));
      await closeOwnerSubscriptions();
      await logout();
      await signup('bob');
      const bob = await login('bob');
      const bobUser = await getCurrentUser();
      check(bobUser.userId !== current.userId, 'Switched to a different User Pool user');
      const deniedGet = await client.models.Todo.get({ id: first.id });
      check(!deniedGet.data, 'Bob cannot get Alice record');
      check((await client.models.Todo.update({ id: first.id, title: 'intrusion' })).errors?.length, 'Bob cannot update Alice record');
      check((await client.models.Todo.delete({ id: first.id })).errors?.length, 'Bob cannot delete Alice record');
      const bobList = await client.models.Todo.list({ limit: 1 });
      check(!bobList.errors?.length && !bobList.data.length, 'Bob cannot list Alice records');
      subscriptions.push(client.models.Todo.onCreate({ authToken: bob.tokens.accessToken.toString() }).subscribe({ next: value => received.push({ user: 'bob', value }), error: () => errors.push('bob') }));
      await delay(700);
      check(!errors.length, 'Bob subscription registration succeeds');
      evidence.stage = 'Bob realtime';
      const bobRecord = success(await client.models.Todo.create({ title: `${label}-bob` }), 'Bob creates own record');
      await waitUntil(() => received.some(event => event.user === 'bob' && event.value.id === bobRecord.id));
      await closeOwnerSubscriptions();
      await logout();
      const aliceAgain = await login('alice');
      subscriptions.push(client.models.Todo.onCreate({ authToken: aliceAgain.tokens.accessToken.toString() }).subscribe({ next: value => received.push({ user: 'alice', value }), error: () => errors.push('alice-reconnect') }));
      await delay(700);
      check(!errors.length, 'Alice subscription reconnect succeeds');
      evidence.stage = 'Alice reconnect realtime';
      const third = success(await client.models.Todo.create({ title: `${label}-third` }), 'Alice creates after switching back');
      await waitUntil(() => received.some(event => event.user === 'alice' && event.value.id === third.id));
      const ids = [];
      let nextToken;
      do {
        const page = await client.models.Todo.list({ limit: 1, nextToken });
        check(!page.errors?.length, 'Owner pagination succeeds');
        for (const item of page.data) { check(item.owner === aliceOwner, 'Pagination contains only Alice'); ids.push(item.id); }
        nextToken = page.nextToken;
      } while (nextToken);
      check(ids.length === 3 && new Set(ids).size === 3, 'Owner pagination complete with no duplicates');
      success(await client.models.Todo.update({ id: first.id, title: 'updated' }), 'Alice update');
      for (const id of [first.id, second.id, third.id]) success(await client.models.Todo.delete({ id }), 'Alice delete');
      check(!errors.length, 'Authorized subscription registrations succeed');
      delete evidence.stage;
      evidence.ownerCrud = true; evidence.ownerSpoofDenied = true; evidence.ownerPagination = true; evidence.ownerRealtime = true; evidence.ownerRealtimeSessions = 'sequential-reconnect'; evidence.userSwitch = true;
      await closeOwnerSubscriptions();
      await logout();
    } else { await logout(); }
    check(!(await fetchAuthSession()).tokens, 'Local sign-out clears frontend tokens');
    evidence.localSignOut = true;
  }
  process.send?.({ type: 'evidence', evidence });
} catch (error) {
  // Never serialize client error objects; they can contain request inputs.
  process.send?.({ type: 'failure', name: error.name, message: error instanceof assert.AssertionError ? error.message : 'Client operation failed', stage: evidence });
  process.exitCode = 1;
} finally {
  subscriptions.forEach(subscription => subscription.unsubscribe());
  process.disconnect?.();
}
