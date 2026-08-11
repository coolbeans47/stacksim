/*
 * Loaded into every Node process in the pinned CDK subprocess tree. Rejecting
 * non-loopback socket connections here keeps a forgotten SDK endpoint, CDK
 * notice request, proxy, or metadata lookup from reaching the public network.
 */
const net = require("node:net");

const originalConnect = net.Socket.prototype.connect;
const loopback = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);
const allowedPorts = new Set(String(process.env.STACKSIM_NETWORK_ALLOW_PORT ?? "").split(",").filter(Boolean));

function destination(args) {
  if (args.length === 0) return {};
  const first = args[0];
  if (first && typeof first === "object") {
    if (first.path !== undefined) return { path: first.path };
    return { host: first.host ?? first.hostname, port: first.port };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { path: first };
  return { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
}

net.Socket.prototype.connect = function stackSimNetworkTripwire(...args) {
  const target = destination(args);
  if (target.path !== undefined) return originalConnect.apply(this, args);
  const host = target.host === undefined ? "localhost" : String(target.host).toLowerCase();
  const port = target.port === undefined ? undefined : String(target.port);
  if (!loopback.has(host) || (port !== undefined && !allowedPorts.has(port))) {
    const error = new Error(`STACKSIM_NETWORK_TRIPWIRE: blocked outbound connection to ${host}:${target.port ?? ""}`);
    error.code = "STACKSIM_NETWORK_TRIPWIRE";
    throw error;
  }
  return originalConnect.apply(this, args);
};
