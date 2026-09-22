import { resolve } from "node:path";
import { StackSim } from "../../src/server.js";

// Dedicated lab state and ports: never fall back to the developer's default simulator directory.
const dataDir = resolve(process.env.LAB_STATE_DIR ?? "sqs-recovery-state");
const simulator = new StackSim({ dataDir, port: 4570, invokePort: 4571, cloudFormationCustomResourceCallbackPort: 0, region: "eu-west-1", authMode: "enforce" });
await simulator.start();
console.log(`Recovery lab: http://127.0.0.1:${simulator.port}/_stacksim/console\nState for restart: ${dataDir}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await simulator.stop(); }
process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
