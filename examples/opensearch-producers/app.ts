import { App, Stack } from 'aws-cdk-lib';
import { buildSync } from 'esbuild';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProducers } from './stack.js';

const base = dirname(fileURLToPath(import.meta.url)), bundle = join(base, 'dist');
mkdirSync(bundle, { recursive: true });
buildSync({ entryPoints: [join(base, 'handler.cjs')], outfile: join(bundle, 'index.js'), bundle: true, platform: 'node', target: 'node22', format: 'cjs' });
const app = new App(), stack = new Stack(app, 'SearchProducers', { env: { account: process.env.CDK_DEFAULT_ACCOUNT ?? '000000000000', region: process.env.CDK_DEFAULT_REGION ?? 'eu-west-1' } });
createProducers(stack, bundle, process.env.AWS_CA_BUNDLE ? readFileSync(process.env.AWS_CA_BUNDLE, 'utf8') : undefined);
app.synth();
