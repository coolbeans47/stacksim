import { resolve } from "node:path";

const projectRoot = process.cwd();

/** Project-local CLI entry points, invoked by the active Node runtime. */
export const cdkCli = resolve(projectRoot, "node_modules", "cdk", "bin", "cdk");

/** Allows CDK synthesis and deployment to make progress under concurrent test load. */
export const cdkCommandTimeoutMs = 240_000;
