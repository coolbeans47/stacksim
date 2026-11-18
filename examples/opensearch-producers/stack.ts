import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Domain, EngineVersion } from 'aws-cdk-lib/aws-opensearchservice';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { LogGroup, SubscriptionFilter, FilterPattern } from 'aws-cdk-lib/aws-logs';
import { LambdaDestination } from 'aws-cdk-lib/aws-logs-destinations';
import { Queue } from 'aws-cdk-lib/aws-sqs';

export function createProducers(stack: Stack, bundle: string, ca?: string) {
  const domain = new Domain(stack, 'Search', { version: EngineVersion.OPENSEARCH_2_19, capacity: { dataNodes: 1, dataNodeInstanceType: 'r6gd.large.search' }, ebs: { enabled: false }, zoneAwareness: { enabled: false }, encryptionAtRest: { enabled: false }, nodeToNodeEncryption: false, enforceHttps: true, removalPolicy: RemovalPolicy.DESTROY });
  const environment = { SEARCH_DOMAIN: domain.domainName, ...(ca ? { SEARCH_CA_PEM: ca } : {}) };
  const product = new Function(stack, 'Products', { runtime: Runtime.NODEJS_22_X, timeout: Duration.seconds(15), handler: 'index.product', code: Code.fromAsset(bundle), environment });
  const deadLetters = new Queue(stack, 'FailureQueue');
  const logs = new Function(stack, 'Logs', { runtime: Runtime.NODEJS_22_X, timeout: Duration.seconds(15), handler: 'index.logs', deadLetterQueue: deadLetters, code: Code.fromAsset(bundle), environment });
  for (const fn of [product, logs]) fn.addToRolePolicy(new PolicyStatement({ actions: ['es:DescribeDomain'], resources: [domain.domainArn] }));
  product.addToRolePolicy(new PolicyStatement({ actions: ['es:ESHttpGet', 'es:ESHttpPost', 'es:ESHttpPut', 'es:ESHttpDelete'], resources: [`${domain.domainArn}/products/*`] }));
  logs.addToRolePolicy(new PolicyStatement({ actions: ['es:ESHttpPut'], resources: [`${domain.domainArn}/logs-*/*`] }));
  const group = new LogGroup(stack, 'Source', { removalPolicy: RemovalPolicy.DESTROY });
  new SubscriptionFilter(stack, 'LogSubscription', { logGroup: group, destination: new LambdaDestination(logs), filterPattern: FilterPattern.allEvents() });
  new CfnOutput(stack, 'DomainName', { value: domain.domainName });
  new CfnOutput(stack, 'Endpoint', { value: domain.domainEndpoint });
  new CfnOutput(stack, 'ProductFunction', { value: product.functionName });
  new CfnOutput(stack, 'LogsFunction', { value: logs.functionName });
  new CfnOutput(stack, 'SourceLogGroup', { value: group.logGroupName });
  new CfnOutput(stack, 'FailedLogBatches', { value: deadLetters.queueUrl });
  return { domain, product, logs, group, deadLetters };
}
