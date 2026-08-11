import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const N = BigInt(`0x${[
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1",
  "29024E088A67CC74020BBEA63B139B22514A08798E3404D",
  "DEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C",
  "245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F40",
  "6B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651EC",
  "E45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8F",
  "D24CF5F83655D23DCA3AD961C62F356208552BB9ED52907",
  "7096966D670C354E4ABC9804F1746C08CA18217C32905E4",
  "62E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55D",
  "F06F4C52C9DE2BCBF6955817183995497CEA956AE515D226",
  "1898FA051015728E5A8AAAC42DAD33170D04507A33A85521",
  "ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F",
  "85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3",
  "D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F",
  "2B18177B200CBBE117577A615D6C770988C0BAD946E208E24",
  "FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFF",
  "FFFFFFFFFFFF",
].join("")}`);
const G = 2n;
const BYTES = 384;

function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let value = base % N;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = result * value % N;
    value = value * value % N;
    power >>= 1n;
  }
  return result;
}

function pad(value: bigint): Buffer {
  return Buffer.from(value.toString(16).padStart(BYTES * 2, "0"), "hex");
}

function hash(...values: Array<string | Buffer>): Buffer {
  const digest = createHash("sha256");
  for (const value of values) digest.update(value);
  return digest.digest();
}

function timestamp(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${date.getUTCDate()} `
    + `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:`
    + `${String(date.getUTCSeconds()).padStart(2, "0")} UTC ${date.getUTCFullYear()}`;
}

test("COG-03 USER_SRP_AUTH verifies Cognito SRP vectors and persists challenge state", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-srp-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  const password = "Valid-password-1!";
  let client: CognitoIdentityProviderClient | undefined;
  try {
    await simulator.start();
    client = new CognitoIdentityProviderClient({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region,
      credentials,
      maxAttempts: 1,
    });
    const created = await client.send(new CreateUserPoolCommand({
      PoolName: "srp-users",
      UsernameAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    }));
    const poolId = created.UserPool!.Id!;
    const app = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "srp-web",
      ExplicitAuthFlows: ["ALLOW_USER_SRP_AUTH"],
    }));
    const clientId = app.UserPoolClient!.ClientId!;
    const email = "srp@example.test";
    await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: email,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
      TemporaryPassword: "Temporary-password-1!",
      MessageAction: "SUPPRESS",
    }));
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: poolId,
      Username: email,
      Password: password,
      Permanent: true,
    }));

    const a = BigInt(`0x${randomBytes(128).toString("hex")}`);
    const A = pow(G, a);
    const started = await client.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_SRP_AUTH",
      AuthParameters: { USERNAME: email, SRP_A: A.toString(16) },
    }));
    assert.equal(started.ChallengeName, "PASSWORD_VERIFIER");
    const parameters = started.ChallengeParameters!;
    const username = parameters.USER_ID_FOR_SRP!;
    const B = BigInt(`0x${parameters.SRP_B}`);
    const salt = Buffer.from(parameters.SALT!, "hex");
    const k = BigInt(`0x${hash(pad(N), pad(G)).toString("hex")}`);
    const u = BigInt(`0x${hash(pad(A), pad(B)).toString("hex")}`);
    const identity = hash(`${poolId.split("_")[1]}${username}:${password}`);
    const x = BigInt(`0x${hash(salt, identity).toString("hex")}`);
    const base = (B - k * pow(G, x)) % N;
    const shared = pow((base + N) % N, a + u * x);
    const prk = createHmac("sha256", pad(u)).update(pad(shared)).digest();
    const key = createHmac("sha256", prk)
      .update(Buffer.concat([Buffer.from("Caldera Derived Key"), Buffer.from([1])]))
      .digest()
      .subarray(0, 16);
    const claimTimestamp = timestamp(new Date());
    const signature = createHmac("sha256", key)
      .update(poolId.split("_")[1])
      .update(username)
      .update(Buffer.from(parameters.SECRET_BLOCK!, "base64"))
      .update(claimTimestamp)
      .digest("base64");
    const validResponses = {
      USERNAME: username,
      PASSWORD_CLAIM_SECRET_BLOCK: parameters.SECRET_BLOCK!,
      PASSWORD_CLAIM_SIGNATURE: signature,
      TIMESTAMP: claimTimestamp,
    };

    client.destroy();
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
    await simulator.start();
    client = new CognitoIdentityProviderClient({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region,
      credentials,
      maxAttempts: 1,
    });

    for (const command of [
      new RespondToAuthChallengeCommand({
        ClientId: clientId,
        ChallengeName: "PASSWORD_VERIFIER",
        Session: `${started.Session}altered`,
        ChallengeResponses: validResponses,
      }),
      new RespondToAuthChallengeCommand({
        ClientId: clientId,
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        Session: started.Session,
        ChallengeResponses: { USERNAME: username, NEW_PASSWORD: "Another-valid-password-1!" },
      }),
      new RespondToAuthChallengeCommand({
        ClientId: clientId,
        ChallengeName: "PASSWORD_VERIFIER",
        Session: started.Session,
        ChallengeResponses: {
          ...validResponses,
          PASSWORD_CLAIM_SECRET_BLOCK: Buffer.from("altered").toString("base64"),
        },
      }),
      new RespondToAuthChallengeCommand({
        ClientId: clientId,
        ChallengeName: "PASSWORD_VERIFIER",
        Session: started.Session,
        ChallengeResponses: {
          ...validResponses,
          TIMESTAMP: timestamp(new Date(Date.now() - 10 * 60_000)),
        },
      }),
      new RespondToAuthChallengeCommand({
        ClientId: clientId,
        ChallengeName: "PASSWORD_VERIFIER",
        Session: started.Session,
        ChallengeResponses: {
          ...validResponses,
          PASSWORD_CLAIM_SIGNATURE: Buffer.alloc(32, 0xa5).toString("base64"),
        },
      }),
    ]) {
      await assert.rejects(
        client.send(command),
        (error: any) => error?.name === "NotAuthorizedException",
      );
    }
    const completed = await client.send(new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: "PASSWORD_VERIFIER",
      Session: started.Session,
      ChallengeResponses: validResponses,
    }));
    assert(completed.AuthenticationResult?.AccessToken);
    assert(completed.AuthenticationResult?.IdToken);
    assert(completed.AuthenticationResult?.RefreshToken);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
