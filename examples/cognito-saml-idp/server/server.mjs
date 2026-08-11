import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createSamlResponse, inspectAuthnRequest, metadataXml } from "./saml.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT ?? 5174);
const baseUrl = process.env.SAML_IDP_BASE_URL ?? `http://localhost:${port}`;
const development = process.argv.includes("--dev");

function json(res, value, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

async function readJson(req, maximum = 64 * 1024) {
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("Expected an application/json request."), { status: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON."), { status: 400 });
  }
}

async function configuredClient() {
  try {
    return JSON.parse(await readFile(join(root, "public", "config.json"), "utf8"));
  } catch {
    return {
      configured: false,
      metadataUrl: `${baseUrl}/saml/metadata`,
    };
  }
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, { ok: true, baseUrl });
  }
  if (req.method === "GET" && url.pathname === "/saml/metadata") {
    res.writeHead(200, {
      "content-type": "application/samlmetadata+xml; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    return res.end(metadataXml(baseUrl));
  }
  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, await configuredClient());
  }
  if (req.method === "GET" && url.pathname === "/api/request") {
    const encodedRequest = url.searchParams.get("SAMLRequest");
    const relayState = url.searchParams.get("RelayState");
    if (!relayState) throw Object.assign(new Error("RelayState is required."), { status: 400 });
    const request = inspectAuthnRequest(encodedRequest);
    return json(res, { ...request, relayState });
  }
  if (req.method === "POST" && url.pathname === "/api/respond") {
    const input = await readJson(req);
    const response = createSamlResponse({
      encodedRequest: input.samlRequest,
      relayState: input.relayState,
      user: input.user,
    });
    return json(res, {
      acsUrl: response.acsUrl,
      relayState: response.relayState,
      samlResponse: response.samlResponse,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/token") {
    const input = await readJson(req);
    const config = await configuredClient();
    if (!config.configured) throw Object.assign(new Error("Run npm run setup:cognito first."), { status: 409 });
    if (typeof input.code !== "string" || typeof input.verifier !== "string") {
      throw Object.assign(new Error("The authorization code and PKCE verifier are required."), { status: 400 });
    }
    const tokenResponse = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        redirect_uri: config.callbackUrl,
        code: input.code,
        code_verifier: input.verifier,
      }),
    });
    const text = await tokenResponse.text();
    res.writeHead(tokenResponse.status, {
      "content-type": tokenResponse.headers.get("content-type") ?? "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    return res.end(text);
  }
  return false;
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function productionFile(res, pathname) {
  const dist = join(root, "dist");
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(dist, requested);
  const safe = candidate === dist || candidate.startsWith(`${dist}${sep}`);
  let file = safe ? candidate : join(dist, "index.html");
  try {
    if (!(await stat(file)).isFile()) file = join(dist, "index.html");
  } catch {
    file = join(dist, "index.html");
  }
  const content = await readFile(file);
  res.writeHead(200, {
    "content-type": mimeTypes[extname(file)] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  res.end(content);
}

let vite;
if (development) {
  const { createServer: createViteServer } = await import("vite");
  vite = await createViteServer({
    root,
    server: { middlewareMode: true },
    appType: "spa",
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", baseUrl);
  try {
    const handled = await api(req, res, url);
    if (handled !== false) return;
    if (vite) return vite.middlewares(req, res);
    await productionFile(res, url.pathname);
  } catch (error) {
    if (!res.headersSent) {
      json(res, { error: error instanceof Error ? error.message : "Request failed." }, error.status ?? 400);
    } else {
      res.end();
    }
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Paper Badge SAML IdP listening at ${baseUrl}`);
  console.log(`Metadata: ${baseUrl}/saml/metadata`);
});

async function stop() {
  await vite?.close();
  server.close();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
