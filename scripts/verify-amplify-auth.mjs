import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignatureV4 } from '@smithy/signature-v4';
import { AwsError } from '../dist/src/errors.js';
import { StackSim } from '../dist/src/server.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const region = 'eu-west-1';
const fixtureId = process.argv[2] ?? 'amplify-gen2-auth-data-owner';
const lifecycle = process.argv.includes('--lifecycle');
const mode = fixtureId.endsWith('-owner') ? 'owner' : fixtureId.endsWith('-iam') ? 'iam' : 'auth';
const fixture = join(root, 'test/fixtures', fixtureId);
const temp = await mkdtemp(join(tmpdir(), 'stacksim-amx-auth-'));
const workspace = join(temp, 'workspace');
const tripwire = join(root, 'test/fixtures/cdk/network-tripwire.cjs');
const admin = { accessKeyId: 'admin', secretAccessKey: 'password' };
const checks = { fixtureId, node: process.version, platform: process.platform, cliUnmodified: true, frontendUnmodified: true };
let sim;
const notices = createServer((req, res) => { res.writeHead(200, {'content-type':'application/json'}); res.end('{"notices":[]}'); });
await new Promise(done => notices.listen(0, '127.0.0.1', done));
const noticesPort = notices.address().port;
class Sha256 {
  constructor(secret) { this.secret = secret; this.reset(); }
  reset() { this.value = this.secret ? createHmac('sha256', this.secret) : createHash('sha256'); }
  update(data) { this.value.update(data); }
  async digest() { return this.value.digest(); }
}
async function consoleGet(path) {
  const url = new URL(path, `http://127.0.0.1:${sim.port}`);
  const signed = await new SignatureV4({ credentials:admin, region, service:'ses', sha256:Sha256 }).sign({ method:'GET', protocol:url.protocol, hostname:url.hostname, port:Number(url.port), path:url.pathname, query:Object.fromEntries(url.searchParams), headers:{host:url.host,'x-stacksim-region':region} });
  const response = await fetch(url, {headers:signed.headers});
  assert.equal(response.status, 200, 'Developer-safe SES read');
  return response.json();
}
function environment(ports) {
  const env = {...process.env};
  const inheritedPath = Object.entries(env).find(([key]) => /^path$/i.test(key))?.[1] ?? '';
  for (const key of Object.keys(env)) if (/^AWS_/i.test(key) || /^path$/i.test(key) || /^(?:http|https|all)_proxy$/i.test(key)) delete env[key];
  return {...env,
    PATH: `${dirname(process.execPath)}${delimiter}${inheritedPath}`,
    AWS_ACCESS_KEY_ID:admin.accessKeyId, AWS_SECRET_ACCESS_KEY:admin.secretAccessKey, AWS_REGION:region, AWS_DEFAULT_REGION:region,
    AWS_ENDPOINT_URL:`http://127.0.0.1:${sim.port}`, AWS_EC2_METADATA_DISABLED:'true', AWS_MAX_ATTEMPTS:'1',
    AWS_CONFIG_FILE:join(temp,'no-config'), AWS_SHARED_CREDENTIALS_FILE:join(temp,'no-credentials'),
    CDK_DEFAULT_ACCOUNT:'000000000000', CDK_DEFAULT_REGION:region, CDK_DISABLE_CLI_TELEMETRY:'true', CDK_DISABLE_VERSION_CHECK:'true',
    AMPLIFY_DISABLE_TELEMETRY:'1', AMPLIFY_BACKEND_NOTICES_ENDPOINT:`http://127.0.0.1:${noticesPort}/notices.json`,
    APPDATA:join(temp,'appdata'), npm_config_update_notifier:'false', npm_config_user_agent:'npm/11.9.0', CI:'1',
    NO_PROXY:'127.0.0.1,localhost,::1', no_proxy:'127.0.0.1,localhost,::1',
    NODE_OPTIONS:`--require=${JSON.stringify(tripwire)}`, STACKSIM_NETWORK_ALLOW_PORT:ports.join(','),
    NODE_EXTRA_CA_CERTS:join(temp,'state/data/cloudformation/custom-resource-pki/ca.pem'),
  };
}
async function command(args, identifier='authlab') {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(workspace,'node_modules/@aws-amplify/backend-cli/lib/ampx.js'),...args,'--identifier',identifier], {cwd:workspace, env:environment([sim.port, noticesPort]), shell:false, windowsHide:true, stdio:['ignore','pipe','pipe']});
    let output='';
    const timer=setTimeout(()=>{child.kill();fail(new Error('CLI timeout'));},180000);
    child.stdout.on('data',x=>{output+=x;}); child.stderr.on('data',x=>{output+=x;});
    child.once('error',fail); child.once('close',code=>{clearTimeout(timer); code===0 ? done(output) : fail(new Error(`CLI failed (${code}): ${output.slice(-12000)}`));});
  });
}
const callEvidence=[];
function observe(server) {
  server.prependListener('request', (req) => {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    const target = req.headers['x-amz-target'];
    const auth=req.headers.authorization;
    const accessKey=typeof auth==='string' ? auth.match(/Credential=([^/]+)/)?.[1] : undefined;
    let tokenUse;
    if (path.startsWith('/graphql/') && typeof auth==='string' && !accessKey) {
      try { tokenUse=JSON.parse(Buffer.from(auth.replace(/^Bearer /,'').split('.')[1],'base64url')).token_use; } catch {}
    }
    callEvidence.push({path, action:target?.split('.').at(-1), ...(accessKey ? {credentialDigest:createHash('sha256').update(accessKey).digest('hex')} : {}), ...(tokenUse ? {tokenUse}: {})});
  });
}
function workloadSnapshot() {
  const state=sim.store.regionState(region);
  return {
    userPools:Object.keys(state.cognito.pools).sort(),
    identityPools:Object.keys(state.cognitoIdentity.pools).sort(),
    appsyncApis:Object.keys(state.appsync.graphqlApis).sort(),
    tables:Object.keys(state.tables).sort(),
    functions:Object.keys(state.functions).sort(),
    roles:Object.keys(sim.store.ensureAccount().iam.roles).sort(),
    buckets:Object.keys(state.s3Buckets).sort(),
  };
}
async function frontend(outputs, label='fresh', selectedMode=mode, adjacent) {
  const start=callEvidence.length;
  const data=JSON.parse(await readFile(outputs,'utf8'));
  const ports=[sim.port,...(data.data ? [new URL(data.data.url).port] : [])];
  return new Promise((done,fail)=>{
    const env=environment(ports);
    // Frontend has neither AWS administrative credentials nor AWS endpoint env.
    for (const key of Object.keys(env)) if (/^AWS_/i.test(key)) delete env[key];
    if (adjacent) env.STACKSIM_ADJACENT_API=adjacent;
    const child=spawn(process.execPath,[join(root,'scripts/exercise-amplify-auth.mjs'),outputs,`http://127.0.0.1:${sim.port}`,selectedMode,label],{cwd:root,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    let evidence, failure, safeError='', credentialProof=false;
    const timer=setTimeout(()=>{child.kill();fail(new Error('Frontend timeout'));},45000);
    child.stdout.on('data',()=>{}); child.stderr.on('data',x=>{safeError+=x;});
    child.on('message',async message=>{
      if(message.type==='confirmation') {
        try {
          const inbox=await consoleGet(`/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(message.username)}&status=all&pageSize=100`);
          const mail=await consoleGet(`/_stacksim/api/ses/inbox/${encodeURIComponent(inbox.messages[0].messageId)}`);
          const code=mail.message.textBody.match(/\b(\d{6})\b/)?.[1]; assert.ok(code); child.send({code});
        } catch { child.send({error:true}); }
      } else if(message.type==='credentialProof') {
        credentialProof=callEvidence.slice(start).some(x=>x.path===new URL(data.data.url).pathname && x.credentialDigest===message.digest);
        child.send({verified:credentialProof});
      } else if(message.type==='evidence') evidence=message.evidence;
      else if(message.type==='failure') failure=message;
    });
    child.once('error',fail); child.once('close',code=>{
      clearTimeout(timer);
      if(code!==0 || !evidence) return fail(new Error(`Frontend ${label} failed: ${JSON.stringify(failure ?? {code, diagnostic:safeError.slice(-3000)})}`));
      const calls=callEvidence.slice(start);
      if(selectedMode==='stale') assert.ok(calls.some(call=>call.action==='InitiateAuth' && call.path===`/_stacksim/cognito-idp/${region}/sdk`),'Deleted-pool denial reached the local Cognito route');
      if(evidence.adjacentResourceDenied) assert.ok(calls.some(call=>call.path===new URL(adjacent).pathname && call.credentialDigest===evidence.sessionCredentialDigest),'Adjacent denial reached the other local API with the same session');
      if(evidence.sessionCredentialDigest) assert.ok(credentialProof,'Unmodified Data signed with the same Amplify Auth session before the retained-credential check');
      evidence.sameSessionSigning=credentialProof;
      delete evidence.sessionCredentialDigest;
      evidence.clientRequests=calls.filter(x=>x.action || x.path.startsWith('/graphql/')).map(({credentialDigest,...safe})=>safe);
      done(evidence);
    });
  });
}
try {
  await cp(fixture,workspace,{recursive:true,filter:path=>!path.startsWith(join(fixture,'node_modules'))&&!path.startsWith(join(fixture,'.amplify'))&&!path.startsWith(join(fixture,'evidence'))&&!path.endsWith('amplify_outputs.json')});
  await symlink(join(root,'test/fixtures/amplify-gen2-data/node_modules'),join(workspace,'node_modules'),process.platform==='win32'?'junction':'dir');
  const opts={port:0,invokePort:0,dataDir:join(temp,'state'),region,authMode:'enforce',cdkBootstrap:true,appSyncLocalTls:true};
  sim=new StackSim(opts); await sim.start(); observe(sim.control); observe(sim.customResourceCallbackServer);
  const initialWorkload=workloadSnapshot();
  const deployed=await command(['sandbox','--once']);
  if (!/Deployment completed/.test(deployed) || !/File written: amplify_outputs\.json/.test(deployed)) throw new Error(deployed.slice(-6500));
  const outputPath=join(workspace,'amplify_outputs.json');
  const original=await readFile(outputPath,'utf8'); const output=JSON.parse(original);
  checks.outputKeys=Object.keys(output); checks.authOutputKeys=Object.keys(output.auth).sort(); checks.outputVersion=output.version;
  checks.deployed=true;
  checks.client=await frontend(outputPath);
  if(lifecycle) {
    assert.match(await command(['sandbox','--once']),/Deployment completed|No changes/);
    checks.repeat=true;
    const authPath=join(workspace,'amplify/auth/resource.ts');
    const originalAuth=await readFile(authPath,'utf8');
    const changedAuth=originalAuth.replace('email: true', 'email: { verificationEmailSubject: "auth-learning-updated" }');
    await writeFile(authPath,changedAuth);
    const updated=await command(['sandbox','--once']);
    if(!/Deployment completed/.test(updated)) throw new Error(updated.slice(-4000));
    const poolId=output.auth.user_pool_id;
    let pool=(await sim.cognito.executeCloudFormationControl('DescribeUserPool',{UserPoolId:poolId})).UserPool;
    assert.equal(pool.VerificationMessageTemplate.EmailSubject,'auth-learning-updated'); checks.update=true;
    const control=sim.cognito.executeCloudFormationControl.bind(sim.cognito);
    let faulted=false;
    sim.cognito.executeCloudFormationControl=async (action,input,...rest)=>{
      if(action==='UpdateUserPool' && input.VerificationMessageTemplate?.EmailSubject==='auth-learning-failed') { faulted=true; throw new AwsError('InvalidParameterException','Injected Auth update failure',400); }
      return control(action,input,...rest);
    };
    await writeFile(authPath,changedAuth.replace('auth-learning-updated','auth-learning-failed'));
    const failed=await command(['sandbox','--once']);
    sim.cognito.executeCloudFormationControl=control;
    assert.ok(faulted,'Auth update fault reached the authoritative provider');
    if(!/UPDATE_ROLLBACK_COMPLETE/.test(failed)) throw new Error(failed.slice(-4000));
    pool=(await control('DescribeUserPool',{UserPoolId:poolId})).UserPool;
    assert.equal(pool.VerificationMessageTemplate.EmailSubject,'auth-learning-updated'); checks.rollback=true;
    await writeFile(authPath,changedAuth);
    checks.rollbackClient=await frontend(outputPath,'rollback');
    // Retain the first exact output while a second identifier gets its own CLI output.
    const firstPath=join(temp,'first-output.json'); await writeFile(firstPath,original);
    await command(['sandbox','--once'],'authlabtwo');
    const secondOutput=JSON.parse(await readFile(outputPath,'utf8'));
    assert.notEqual(secondOutput.auth.user_pool_id,output.auth.user_pool_id);
    assert.notEqual(secondOutput.auth.identity_pool_id,output.auth.identity_pool_id);
    if(output.data) assert.notEqual(secondOutput.data.url,output.data.url);
    checks.twoSandboxes=true;
    checks.secondClient=await frontend(outputPath,'second',mode,output.data?.url);
    const controlPort=sim.port, invokePort=sim.invokePort, tlsPort=sim.customResourceCallbackPort;
    await sim.stop(); sim=new StackSim({...opts,port:controlPort,invokePort,cloudFormationCustomResourceCallbackPort:tlsPort}); await sim.start(); observe(sim.control); observe(sim.customResourceCallbackServer);
    checks.restartClient=await frontend(firstPath,'restart');
    assert.match(await command(['sandbox','delete','--yes'],'authlabtwo'),/\[Sandbox\] Finished deleting\./);
    checks.secondStale=await frontend(outputPath,'second','stale');
    checks.firstAfterSecondDelete=await frontend(firstPath,'afterdelete');
    assert.match(await command(['sandbox','delete','--yes']),/\[Sandbox\] Finished deleting\./);
    checks.firstStale=await frontend(firstPath,'fresh','stale');
    assert.deepEqual(workloadSnapshot(),initialWorkload,'Both sandboxes remove their workload and preserve shared bootstrap resources');
    checks.cleanup=true;
    checks.delete=true;
  }
  const serialized=JSON.stringify(checks);
  assert.doesNotMatch(serialized,/eyJ[A-Za-z0-9_-]+\.eyJ|ASIA[0-9A-Z]{16}|Local-learning-password|SessionToken|SecretKey/);
  process.stdout.write(`${serialized}\n`);
} finally {
  await sim?.stop();
  notices.closeAllConnections?.(); await new Promise(done=>notices.close(done));
  if(process.env.STACKSIM_KEEP_AUTH_EVIDENCE==='1') process.stderr.write(`Temporary evidence directory: ${temp}\n`);
  else await rm(temp,{recursive:true,force:true});
}
