import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AwsError } from "./errors.js";
import type { PrincipalContext } from "./auth/sigv4.js";
import type { Clock } from "./core/clock.js";
import type { Scheduler } from "./core/scheduler.js";
import { evaluateTrust } from "./iam/evaluator.js";
import { validatePolicyDocument } from "./iam.js";
import { awsQueryErrorXml, parseAwsQuery, sendAwsQueryXml } from "./protocols/query-xml.js";
import type { StateStore } from "./state.js";
import type { PolicyDocument, PolicyStatement } from "./types.js";
import { readBody } from "./util.js";

const NAMESPACE = "https://sts.amazonaws.com/doc/2011-06-15/";
function list<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function randomCredential(prefix: string, bytes: number, length: number): string { return (prefix + randomBytes(bytes).toString("base64url").replace(/[^A-Za-z0-9]/g, "").toUpperCase()).slice(0, length); }

export class StsService {
  private started = false;
  constructor(private readonly store: StateStore, private readonly clock: Clock, private readonly scheduler: Scheduler) {}
  start(): void { if (this.started) return; this.started = true; const next = () => this.scheduler.schedule(() => { void this.cleanup().finally(next); }, 60_000); next(); }
  private async cleanup(): Promise<void> { let changed = false; for (const account of Object.values(this.store.state.accounts)) for (const [key, session] of Object.entries(account.iam.sessions)) if (session.expiration <= this.clock.now()) { delete account.iam.sessions[key]; if (session.credentialId) await this.store.credentialStore?.delete(session.credentialId); changed = true; } if (changed) await this.store.save(); }

  async handle(req: IncomingMessage, res: ServerResponse, requestId: string, principal: PrincipalContext): Promise<void> {
    try { const input = parseAwsQuery((await readBody(req)).toString("utf8")) as any; const action = String(input.Action ?? ""); if (!action || typeof (this as any)[action] !== "function") throw new AwsError("InvalidAction", `The action ${action} is not valid`, 400); delete input.Action; delete input.Version; const result = await (this as any)[action](input, principal); sendAwsQueryXml(res, `${action}Response`, { [`${action}Result`]: result, ResponseMetadata: { RequestId: requestId } }, NAMESPACE); }
    catch (error) { const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500); res.statusCode = aws.status; res.setHeader("content-type", "text/xml; charset=utf-8"); res.end(awsQueryErrorXml(aws.code, aws.message, requestId)); }
  }

  async GetCallerIdentity(_input: any, principal: PrincipalContext): Promise<any> { return { UserId: principal.principalId, Account: this.store.accountId, Arn: principal.sessionArn ?? principal.principalArn }; }
  async GetAccessKeyInfo(input: any): Promise<any> { const key = String(input.AccessKeyId ?? ""); const owners = Object.entries(this.store.state.accounts).filter(([, account]) => account.iam.sessions[key] || account.iam.accessKeys[key]).map(([accountId]) => accountId); if (owners.length === 1) return { Account: owners[0] }; throw new AwsError("InvalidClientTokenId", "The security token included in the request is invalid", 403); }

  /** Create the temporary role session used internally by an AWS service. */
  async assumeServiceRole(roleArn: string, roleSessionName: string, servicePrincipal: string): Promise<PrincipalContext> {
    const response = await this.AssumeRole({ RoleArn: roleArn, RoleSessionName: roleSessionName, DurationSeconds: 3600 }, {
      principalType: "service",
      accessKeyId: `service:${servicePrincipal}`,
      principalArn: servicePrincipal,
      principalId: servicePrincipal,
      accountId: this.store.accountId,
    });
    const accessKeyId = String(response.Credentials.AccessKeyId);
    const session = this.store.ensureAccount().iam.sessions[accessKeyId];
    if (!session) throw new AwsError("InternalFailure", `STS did not persist the ${servicePrincipal} role session`, 500);
    return {
      principalType: "roleSession",
      accessKeyId,
      principalArn: session.principalArn,
      principalId: session.principalId,
      accountId: this.store.accountId,
      roleArn: session.roleArn,
      sessionArn: session.principalArn,
      sourceIdentity: session.sourceIdentity,
      sessionTags: structuredClone(session.sessionTags),
    };
  }

  async AssumeRole(input: any, principal: PrincipalContext): Promise<any> {
    const role = Object.values(this.store.ensureAccount().iam.roles).find(item => item.arn === input.RoleArn); if (!role) throw new AwsError("AccessDenied", `User ${principal.principalArn} is not authorized to perform sts:AssumeRole on resource ${input.RoleArn}`, 403);
    const sessionName = String(input.RoleSessionName ?? ""); if (!/^[\w+=,.@-]{2,64}$/.test(sessionName)) throw new AwsError("ValidationError", "RoleSessionName must contain 2-64 valid characters", 400);
    const duration = Number(input.DurationSeconds ?? 3600); const maximum = principal.roleArn ? Math.min(3600, role.maxSessionDuration) : role.maxSessionDuration; if (!Number.isInteger(duration) || duration < 900 || duration > maximum) throw new AwsError("ValidationError", `DurationSeconds must be between 900 and ${maximum}`, 400);
    const tags: Record<string, string> = {}; for (const tag of list<any>(input.Tags)) { if (!tag.Key || tag.Value === undefined || tags[tag.Key] !== undefined) throw new AwsError("ValidationError", "Invalid or duplicate session tag", 400); tags[tag.Key] = String(tag.Value); } if (Object.keys(tags).length > 50) throw new AwsError("PackedPolicyTooLarge", "Too many session tags", 400);
    const tagKeys = Object.keys(tags); const transitiveTagKeys = list<unknown>(input.TransitiveTagKeys).map(String);
    const trustContext = {
      "sts:ExternalId": input.ExternalId,
      "sts:SourceIdentity": input.SourceIdentity,
      "aws:PrincipalArn": principal.principalArn,
      "aws:PrincipalAccount": principal.accountId,
      ...(tagKeys.length ? { "aws:TagKeys": tagKeys } : {}),
      ...(transitiveTagKeys.length ? { "sts:TransitiveTagKeys": transitiveTagKeys } : {}),
      ...Object.fromEntries(Object.entries(tags).map(([key, value]) => [`aws:RequestTag/${key}`, value])),
    };
    const trust = evaluateTrust(role.assumeRolePolicyDocument, principal.principalArn, "sts:AssumeRole", trustContext); if (trust.decision !== "allowed") throw new AwsError("AccessDenied", trust.reason, 403);
    if (tagKeys.length || transitiveTagKeys.length) {
      const tagTrust = evaluateTrust(role.assumeRolePolicyDocument, principal.principalArn, "sts:TagSession", trustContext);
      if (tagTrust.decision !== "allowed") {
        const reason = tagTrust.decision === "explicitDeny" ? "Trust policy explicitly denies sts:TagSession" : "Trust policy does not allow sts:TagSession for the principal";
        throw new AwsError("AccessDenied", reason, 403);
      }
    }
    const sessionDocuments: PolicyDocument[] = []; if (input.Policy) sessionDocuments.push(validatePolicyDocument(input.Policy)); for (const item of list<any>(input.PolicyArns)) { const policy = this.store.ensureAccount().iam.policies[item.arn]; if (!policy) throw new AwsError("ValidationError", `Managed session policy ${item.arn} was not found`, 400); sessionDocuments.push(policy.versions[policy.defaultVersionId].document); } if (sessionDocuments.length > 10) throw new AwsError("PackedPolicyTooLarge", "Too many session policies", 400);
    const statements = sessionDocuments.flatMap(document => list<PolicyStatement>(document.Statement)); const sessionPolicy = statements.length ? { Version: "2012-10-17", Statement: statements } as PolicyDocument : undefined; const packedBytes = Buffer.byteLength(JSON.stringify({ sessionPolicy, tags })); if (packedBytes > 2048) throw new AwsError("PackedPolicyTooLarge", "Packed session policy exceeds the allowed size", 400);
    return this.store.withCredentialMutation(this.store.accountId, async () => {
      let accessKeyId: string; do { accessKeyId = randomCredential("ASIA", 16, 20); } while (Object.values(this.store.state.accounts).some(account => account.iam.sessions[accessKeyId] || account.iam.accessKeys[accessKeyId]));
      const secretAccessKey = randomCredential("", 32, 40); const expiration = this.clock.now() + duration * 1000; const assumedRoleId = `${role.roleId}:${sessionName}`; const arn = `arn:aws:sts::${this.store.accountId}:assumed-role/${role.roleName}/${sessionName}`; const tokenPayload = Buffer.from(JSON.stringify({ accessKeyId, expiration, arn })).toString("base64url"); const signature = createHmac("sha256", this.store.state.installation.paginationSecret).update(tokenPayload).digest("base64url"); const sessionToken = `${tokenPayload}.${signature}`;
      const credentialId = randomUUID();
      if (!this.store.credentialStore) throw new AwsError("InternalFailure", "The IAM credential store is unavailable", 500);
      await this.store.credentialStore.put({ credentialId, type: "sts-session", accountId: this.store.accountId, ownerId: assumedRoleId, accessKeyId }, { secretAccessKey, sessionToken });
      const persisted = { accessKeyId, credentialId, principalArn: arn, principalId: assumedRoleId, roleArn: role.arn, roleName: role.roleName, sessionName, expiration, sourceIdentity: input.SourceIdentity, sessionPolicy, sessionTags: tags };
      this.store.ensureAccount().iam.sessions[accessKeyId] = persisted;
      try {
        await this.store.save();
      } catch (error) {
        delete this.store.ensureAccount().iam.sessions[accessKeyId];
        await this.store.credentialStore.delete(credentialId).catch(() => undefined);
        throw error;
      }
      return { Credentials: { AccessKeyId: accessKeyId, SecretAccessKey: secretAccessKey, SessionToken: sessionToken, Expiration: new Date(expiration) }, AssumedRoleUser: { AssumedRoleId: assumedRoleId, Arn: arn }, PackedPolicySize: Math.ceil(packedBytes / 2048 * 100), SourceIdentity: input.SourceIdentity };
    });
  }
}
