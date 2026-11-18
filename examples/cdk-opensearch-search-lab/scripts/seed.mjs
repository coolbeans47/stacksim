import { apiRequest, readManifest, requireSimulator } from "./common.mjs";
await requireSimulator();
console.log(
  await apiRequest(await readManifest(), "/seed", { method: "POST" }),
);
