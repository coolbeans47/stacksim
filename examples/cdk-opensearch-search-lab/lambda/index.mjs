import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { createHandler } from "./api.mjs";

export const handler = createHandler(
  async () =>
    new Client({
      node: process.env.SEARCH_ENDPOINT,
      maxRetries: 0,
      requestTimeout: 10000,
      ...(process.env.SEARCH_CA_PEM
        ? { ssl: { ca: process.env.SEARCH_CA_PEM } }
        : {}),
      ...AwsSigv4Signer({
        region: process.env.AWS_REGION,
        service: "es",
        getCredentials: async () => ({
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          sessionToken: process.env.AWS_SESSION_TOKEN,
        }),
      }),
    }),
  process.env.SEARCH_INDEX,
);
