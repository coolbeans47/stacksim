exports.handler = async function handler(event) {
  const allowed = event.authorizationToken === `Bearer ${process.env.DEMO_TOKEN}`;
  return {
    principalId: allowed ? "local-observer" : "anonymous",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{
        Action: "execute-api:Invoke",
        Effect: allowed ? "Allow" : "Deny",
        Resource: event.methodArn,
      }],
    },
    context: { channel: "aurora-atlas", authenticated: String(allowed) },
  };
};

