import { a, defineData, type ClientSchema } from "@aws-amplify/backend";

const schema = a.schema({
  Todo: a
    .model({
      title: a.string().required(),
      description: a.string(),
      priority: a.integer(),
      completed: a.boolean(),
      dueAt: a.datetime(),
    })
    .authorization(allow => [allow.authenticated("identityPool")]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
  },
});
