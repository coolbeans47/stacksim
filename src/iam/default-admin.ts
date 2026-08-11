import { randomBytes, randomUUID } from "node:crypto";
import type { Clock } from "../core/clock.js";
import type { StateStore } from "../state.js";
import type { IamAccessKeyState, IamUserState } from "../types.js";
import { IamCredentialStore } from "./credentials.js";

const ADMIN_POLICY_ARN = "arn:aws:iam::aws:policy/AdministratorAccess";

function stableId(prefix: "AIDA" | "AGPA"): string {
  return prefix + randomBytes(16).toString("base64url").replace(/[^A-Za-z0-9]/g, "").toUpperCase().padEnd(17, "0").slice(0, 17);
}

export interface DefaultAdministratorOptions {
  seed: boolean;
  userName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export async function initializeDefaultAdministrator(
  store: StateStore,
  vault: IamCredentialStore,
  clock: Clock,
  options: DefaultAdministratorOptions,
): Promise<void> {
  const account = store.ensureAccount();
  const registry = store.state.installation.defaultAdministrators;
  const fingerprint = vault.fingerprint([store.accountId, options.accessKeyId, options.secretAccessKey]);

  // Move legacy STS plaintext into the private store before serving requests.
  for (const [accountId, candidate] of Object.entries(store.state.accounts)) {
    for (const [accessKeyId, session] of Object.entries(candidate.iam.sessions)) {
      if (!session.credentialId) {
        if (!session.secretAccessKey || !session.sessionToken) throw new Error(`STS session ${accessKeyId} has no recoverable credential material`);
        session.credentialId = randomUUID();
        await vault.put({ credentialId: session.credentialId, type: "sts-session", accountId, ownerId: session.principalId, accessKeyId }, { secretAccessKey: session.secretAccessKey, sessionToken: session.sessionToken });
        Reflect.deleteProperty(session, "secretAccessKey");
        Reflect.deleteProperty(session, "sessionToken");
      }
    }
  }

  let initialization = registry[store.accountId];
  if (!initialization) {
    initialization = registry[store.accountId] = {
      version: 1,
      initialized: false,
      accountId: store.accountId,
      firstConsoleLogin: { status: store.wasCreated || store.loadedSchemaVersion >= 58 ? "pending" : "notApplicable" },
    };
  }
  if (!initialization.initialized) {
    if (!options.seed) { await store.save(); return; }
    if (account.iam.users[options.userName]) throw new Error(`Cannot seed default administrator: IAM user ${options.userName} already exists`);
    if (findAccessKey(store, options.accessKeyId)) throw new Error(`Cannot seed default administrator: access key ID ${options.accessKeyId} already exists`);
    const now = clock.now();
    const user: IamUserState = {
      userName: options.userName,
      userId: stableId("AIDA"),
      arn: `arn:aws:iam::${store.accountId}:user/${options.userName}`,
      path: "/",
      createDate: now,
      tags: { "stacksim:default-administrator": "true" },
      attachedPolicyArns: [ADMIN_POLICY_ARN],
      inlinePolicies: {},
    };
    const credentialId = randomUUID();
    await vault.put({ credentialId, type: "iam-user", accountId: store.accountId, ownerId: user.userId, accessKeyId: options.accessKeyId }, { secretAccessKey: options.secretAccessKey });
    const key: IamAccessKeyState = { accessKeyId: options.accessKeyId, userName: user.userName, status: "Active", createDate: now, origin: "configured", credentialId };
    account.iam.users[user.userName] = user;
    account.iam.accessKeys[key.accessKeyId] = key;
    Object.assign(initialization, {
      initialized: true,
      originalUserName: user.userName,
      originalUserId: user.userId,
      currentUserName: user.userName,
      configuredAccessKeyId: key.accessKeyId,
      configurationFingerprint: fingerprint,
      initializedAt: now,
    });
    await store.save();
  } else if (initialization.configurationFingerprint !== fingerprint) {
    const user = Object.values(account.iam.users).find(value => value.userId === initialization.originalUserId);
    if (!user) return;
    const collision = findAccessKey(store, options.accessKeyId);
    const previous = initialization.configuredAccessKeyId ? account.iam.accessKeys[initialization.configuredAccessKeyId] : undefined;
    if (collision && collision.key !== previous) throw new Error(`Cannot rotate configured credentials: access key ID ${options.accessKeyId} already exists`);
    const generatedCount = Object.values(account.iam.accessKeys).filter(value => value.userName === user.userName && value.origin === "generated").length;
    if (!previous && generatedCount >= 2) throw new Error("Cannot rotate configured credentials: the IAM user already has two access keys");
    const credentialId = randomUUID();
    await vault.put({ credentialId, type: "iam-user", accountId: store.accountId, ownerId: user.userId, accessKeyId: options.accessKeyId }, { secretAccessKey: options.secretAccessKey });
    if (previous) {
      delete account.iam.accessKeys[previous.accessKeyId];
      await vault.delete(previous.credentialId);
    }
    account.iam.accessKeys[options.accessKeyId] = { accessKeyId: options.accessKeyId, userName: user.userName, status: "Active", createDate: clock.now(), origin: "configured", credentialId };
    initialization.configuredAccessKeyId = options.accessKeyId;
    initialization.configurationFingerprint = fingerprint;
    delete initialization.deletedConfiguredKeyFingerprint;
    if (initialization.firstConsoleLogin.status === "presented" && !initialization.firstConsoleLogin.outcome) {
      initialization.firstConsoleLogin.outcome = "rotationIncomplete";
      initialization.firstConsoleLogin.staleReason = "configuredCredentialRotated";
      initialization.firstConsoleLogin.outcomeAt = clock.now();
    }
    await store.save();
  }

  // Active metadata without a matching authenticated record is always fatal.
  const referencedCredentialIds = new Set<string>();
  for (const [accountId, candidate] of Object.entries(store.state.accounts)) {
    for (const key of Object.values(candidate.iam.accessKeys)) {
      referencedCredentialIds.add(key.credentialId);
      const user = candidate.iam.users[key.userName];
      if (!user || !vault.get(key.credentialId, { type: "iam-user", accountId, ownerId: user.userId, accessKeyId: key.accessKeyId })) {
        throw new Error(`IAM credential metadata for access key ${key.accessKeyId} does not match the private credential store`);
      }
    }
    for (const session of Object.values(candidate.iam.sessions)) {
      if (session.credentialId) referencedCredentialIds.add(session.credentialId);
      if (!session.credentialId || !vault.get(session.credentialId, { type: "sts-session", accountId, ownerId: session.principalId, accessKeyId: session.accessKeyId })) {
        throw new Error(`STS credential metadata for access key ${session.accessKeyId} does not match the private credential store`);
      }
    }
  }
  await vault.sweep(referencedCredentialIds);
}

function findAccessKey(store: StateStore, accessKeyId: string): { accountId: string; key: IamAccessKeyState } | undefined {
  for (const [accountId, account] of Object.entries(store.state.accounts)) {
    const key = account.iam.accessKeys[accessKeyId];
    if (key) return { accountId, key };
    if (account.iam.sessions[accessKeyId]) return { accountId, key: undefined as any };
  }
  return undefined;
}
