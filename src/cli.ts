import { StackSim } from "./server.js";

const simulator = new StackSim({
  appSyncLocalTls: process.argv.includes("--appsync-local-tls") ? true : undefined,
});
await simulator.start();
console.log(`StackSim ready
  SDK endpoint:     http://${simulator.host}:${simulator.port}
  Web console:      http://${simulator.host}:${simulator.port}/_stacksim/console
  API invoke base:  ${simulator.invokeProtocol}://${simulator.host}:${simulator.invokePort}/{apiId}/{stage}
  Region:           ${simulator.region}
  Health:           http://${simulator.host}:${simulator.port}/_stacksim/health`);

async function shutdown(): Promise<void> { await simulator.stop(); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
