import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = dirname(fileURLToPath(import.meta.url));
const modes = ["owner", "iam"];

function amplifyOutputs() {
  return {
    name: "stacksim-amplify-outputs",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const mode = modes.find(value => request.url?.split("?", 1)[0] === `/outputs/${value}/amplify_outputs.json`);
        if (!mode) return next();
        try {
          const output = await readFile(resolve(root, "outputs", mode, "amplify_outputs.json"));
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
          });
          response.end(output);
        } catch (error) {
          if (error?.code !== "ENOENT") server.config.logger.error(String(error));
          response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          response.end('{"configured":false}');
        }
      });
    },
    async closeBundle() {
      for (const mode of modes) {
        try {
          const target = resolve(root, "dist", "outputs", mode);
          await mkdir(target, { recursive: true });
          await copyFile(resolve(root, "outputs", mode, "amplify_outputs.json"), resolve(target, "amplify_outputs.json"));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), amplifyOutputs()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173 },
});
