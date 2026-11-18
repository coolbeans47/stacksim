import { rm } from "node:fs/promises";
import {
  manifestFile,
  readManifest,
  requireSimulator,
  runCdk,
} from "./common.mjs";
await requireSimulator();
await readManifest();
// Use the deployed assembly: teardown must not depend on rebuilding local assets.
await runCdk("delete the demo website, API and search domain", [
  "destroy",
  "--app",
  "cdk.out",
  "SearchLabWebStack",
  "SearchLabApplicationStack",
  "--force",
]);
await rm(manifestFile, { force: true });
