import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import * as Cfn from '@aws-sdk/client-cloudformation';
import { StackSim } from '../src/server.js';

test('Application CloudFormation creates real source associations, updates, replaces and retains owned resources', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-app-cfn-')), region = 'eu-west-1', sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: 'enforce' }); let cfn: Cfn.CloudFormationClient;
  const template = (revision: number) => JSON.stringify({ Resources: {
    Domain: { Type: 'AWS::OpenSearchService::Domain', Properties: { DomainName: 'application-source' } },
    Application: { Type: 'AWS::OpenSearchService::Application', ...(revision > 2 ? { DeletionPolicy: 'Retain' } : {}), Properties: { Name: revision > 2 ? 'replacement-app' : 'cfn-app', DataSources: [{ DataSourceArn: { 'Fn::GetAtt': ['Domain', 'Arn'] }, DataSourceDescription: `Revision ${revision}` }], AppConfigs: revision === 1 ? [{ Key: 'opensearchDashboards.dashboardAdmin.users', Value: '*' }] : [], Tags: [{ Key: 'revision', Value: String(revision) }] } },
  }, Outputs: { Name: { Value: { Ref: 'Application' } }, Arn: { Value: { 'Fn::GetAtt': ['Application', 'Arn'] } }, Id: { Value: { 'Fn::GetAtt': ['Application', 'Id'] } }, Endpoint: { Value: { 'Fn::GetAtt': ['Application', 'Endpoint'] } } } });
  try {
    await sim.start(); cfn = new Cfn.CloudFormationClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: 'admin', secretAccessKey: 'password' }, maxAttempts: 1 });
    const wait = async (status: string) => { for (let i = 0; i < 400; i++) { const stack = (await cfn.send(new Cfn.DescribeStacksCommand({ StackName: 'application-stack' }))).Stacks![0]; if (stack.StackStatus === status) return Object.fromEntries(stack.Outputs!.map(output => [output.OutputKey!, output.OutputValue!])); if (stack.StackStatus?.includes('FAILED') || stack.StackStatus?.includes('ROLLBACK_COMPLETE')) throw new Error(`${stack.StackStatus}: ${stack.StackStatusReason}`); await delay(20); } throw new Error(`Stack did not reach ${status}`); };
    await cfn.send(new Cfn.CreateStackCommand({ StackName: 'application-stack', TemplateBody: template(1) })); const first = await wait('CREATE_COMPLETE');
    assert.equal(first.Name, 'cfn-app'); assert.equal(sim.opensearch.applications.application(region, first.Id).sources[0].generation, sim.opensearch.domain(region, 'application-source').generation); assert.equal(sim.opensearch.applications.application(region, first.Id).tags['aws:cloudformation:logical-id'], 'Application');
    await cfn.send(new Cfn.UpdateStackCommand({ StackName: 'application-stack', TemplateBody: template(2) })); const second = await wait('UPDATE_COMPLETE'); assert.equal(second.Endpoint, first.Endpoint); assert.equal(sim.opensearch.applications.application(region, first.Id).appConfigs.length, 0); assert.equal(sim.opensearch.applications.application(region, first.Id).sources[0].dataSourceDescription, 'Revision 2');
    await cfn.send(new Cfn.UpdateStackCommand({ StackName: 'application-stack', TemplateBody: template(3) })); const third = await wait('UPDATE_COMPLETE'); assert.notEqual(third.Endpoint, first.Endpoint); assert.throws(() => sim.opensearch.applications.application(region, first.Id), { code: 'ResourceNotFoundException' });
    await cfn.send(new Cfn.DeleteStackCommand({ StackName: 'application-stack' })); for (let i = 0; i < 400; i++) { if (!sim.opensearch.applications.application(region, third.Id).owner) break; await delay(20); } assert.equal(sim.opensearch.applications.application(region, third.Id).owner, undefined);
    await cfn.send(new Cfn.CreateStackCommand({ StackName: 'adoption-attempt', TemplateBody: JSON.stringify({ Resources: { App: { Type: 'AWS::OpenSearchService::Application', Properties: { Name: 'replacement-app' } } } }) }));
    for (let i = 0; i < 400; i++) { const status = (await cfn.send(new Cfn.DescribeStacksCommand({ StackName: 'adoption-attempt' }))).Stacks![0].StackStatus; if (status === 'ROLLBACK_COMPLETE') break; await delay(20); }
    assert.equal((await cfn.send(new Cfn.DescribeStacksCommand({ StackName: 'adoption-attempt' }))).Stacks![0].StackStatus, 'ROLLBACK_COMPLETE'); assert.equal(sim.opensearch.applications.application(region, third.Id).status, 'ACTIVE');
  } finally { cfn!?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
