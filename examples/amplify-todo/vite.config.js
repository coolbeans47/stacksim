import { access, copyFile, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const outputFile = resolve("amplify_outputs.json");

function amplifyOutputs() {
  return {
    name: "stacksim-amplify-outputs",
    configureServer(server) {
      server.middlewares.use("/amplify_outputs.json", async (_request, response) => {
        try {
          const output = await readFile(outputFile);
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
      try {
        await access(outputFile, constants.R_OK);
        await copyFile(outputFile, resolve("dist", "amplify_outputs.json"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), amplifyOutputs()],
  server: { host: "127.0.0.1", port: 5173 },
  preview: { host: "127.0.0.1", port: 4173 },
});
