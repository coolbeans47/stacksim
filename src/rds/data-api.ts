import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import mysql, { type Connection } from "mysql2/promise";
import type { Clock } from "../core/clock.js";
import { AwsError, sendAwsError } from "../errors.js";
import { json } from "../util.js";
import { rdsDataOperation, readRdsDataBody } from "./data-protocol.js";
import { invalid, object, prepareStatement, runStatement, sqlError, type DataInput } from "./data-statements.js";

export interface RdsDataWriter { generation: string; port: number; database?: string }
interface Credential { username: string; password: string }
interface RequestScope { resourceArn: string; cancelled: boolean; connection?: Connection }
interface Transaction {
  id: string;
  resourceArn: string;
  generation: string;
  database?: string;
  secretArn: string;
  fingerprint: string;
  connection: Connection;
  busy: boolean;
  deadline: number;
  timer?: ReturnType<Clock["setTimeout"]>;
}
const MINUTE = 60_000;
const transactionMissing = () => new AwsError("TransactionNotFoundException", "The transaction is unavailable or expired", 404);
const unavailable = () => new AwsError("DatabaseUnavailableException", "The cluster writer is unavailable", 504);

export class RdsDataService {
  private readonly transactions = new Map<string, Transaction>();
  private readonly requests = new Set<RequestScope>();
  private readonly credentialKey = randomBytes(32);

  constructor(private readonly clock: Clock, private readonly resolveWriter: (resourceArn: string) => RdsDataWriter,
    private readonly readSecret: (secretArn: string) => Promise<Credential>) {}

  async handle(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    res.setHeader("x-amzn-requestid", requestId);
    try {
      const operation = rdsDataOperation(new URL(req.url ?? "/", "http://localhost").pathname);
      if (!operation || req.method !== "POST") throw new AwsError("NotFoundException", "Unknown Data API operation", 404);
      if (String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "application/json") invalid("Expected an application/json request");
      const body = await readRdsDataBody(req);
      let input: unknown;
      try { input = JSON.parse(body.toString("utf8")); } catch { invalid("Invalid JSON request"); }
      if (!object(input)) invalid("The request must be a JSON object");
      json(res, await this.execute(operation, input));
    } catch (error) {
      sendAwsError(res, error instanceof AwsError ? error : new AwsError("InternalServerErrorException", "Data API execution failed", 500), "rest");
    }
  }

  async execute(operation: string, input: DataInput): Promise<unknown> {
    if (operation === "ExecuteSql") invalid("ExecuteSql is deprecated. Use ExecuteStatement or BatchExecuteStatement");
    const batch = operation === "BatchExecuteStatement";
    const statement = batch || operation === "ExecuteStatement";
    const end = operation === "CommitTransaction" || operation === "RollbackTransaction";
    if (!statement && !end && operation !== "BeginTransaction") invalid("Unknown Data API operation");
    const { resourceArn, secretArn, database, transactionId } = input;
    if (typeof resourceArn !== "string" || !resourceArn || typeof secretArn !== "string" || !secretArn) invalid("resourceArn and secretArn are required");
    if (database !== undefined && (typeof database !== "string" || database.length > 64)) invalid("Invalid database name");
    if (input.schema !== undefined) invalid("The schema parameter is unsupported");
    if ((end && !transactionId) || (transactionId !== undefined && (typeof transactionId !== "string" || !transactionId || operation === "BeginTransaction"))) invalid("Invalid transactionId");
    const writer = this.resolveWriter(resourceArn);
    const prepared = statement ? prepareStatement(input, batch) : undefined;
    const transaction = typeof transactionId === "string" ? this.transactions.get(transactionId) : undefined;
    if (transactionId !== undefined) {
      if (!transaction || transaction.resourceArn !== resourceArn || transaction.secretArn !== secretArn ||
          transaction.generation !== writer.generation || (database !== undefined && database !== transaction.database)) throw transactionMissing();
      if (transaction.busy) throw new AwsError("DatabaseErrorException", "Transaction is still running a query");
      transaction.busy = true;
      this.arm(transaction);
    }
    const request: RequestScope = { resourceArn, cancelled: false };
    this.requests.add(request);
    const work = async () => {
      try {
        const credentials = await this.readSecret(secretArn);
        const fingerprint = createHmac("sha256", this.credentialKey).update(JSON.stringify([credentials.username, credentials.password])).digest("hex");
        const selectedDatabase = database || transaction?.database || writer.database;
        if (request.cancelled || this.resolveWriter(resourceArn).generation !== writer.generation) throw unavailable();
        if (transaction && !this.transactions.has(transaction.id)) throw transactionMissing();
        if (transaction && transaction.fingerprint !== fingerprint) { this.discard(transaction); throw transactionMissing(); }
        const connection = transaction?.connection ?? await this.connect(writer, selectedDatabase, credentials);
        request.connection = connection;
        if (request.cancelled || this.resolveWriter(resourceArn).generation !== writer.generation) throw unavailable();
        if (prepared) return await runStatement(connection, prepared, batch);
        if (transaction) {
          try { if (operation === "CommitTransaction") await connection.commit(); else await connection.rollback(); }
          finally { this.discard(transaction); }
          return { transactionStatus: operation === "CommitTransaction" ? "Transaction Committed" : "Rollback Complete" };
        }
        await connection.beginTransaction();
        if (request.cancelled) throw unavailable();
        const id = randomUUID();
        const created: Transaction = { id, resourceArn, secretArn, database: selectedDatabase, fingerprint, connection,
          generation: writer.generation, busy: false, deadline: this.clock.now() + 60 * MINUTE };
        this.transactions.set(id, created);
        connection.once("error", () => this.discard(created));
        this.arm(created);
        request.connection = undefined; // The open transaction now owns the authenticated connection.
        return { transactionId: id };
      } catch (error) {
        if (error instanceof AwsError) throw error;
        throw sqlError();
      } finally {
        this.requests.delete(request);
        if (transaction) {
          if (this.transactions.has(transaction.id)) { transaction.busy = false; this.arm(transaction); }
        } else request.connection?.destroy();
      }
    };
    if (!statement) return work();
    let timer: ReturnType<Clock["setTimeout"]> | undefined;
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => {
        timer = this.clock.setTimeout(() => {
          if (input.continueAfterTimeout !== true) {
            request.cancelled = true;
            request.connection?.destroy();
            if (transaction) this.discard(transaction);
          }
          reject(new AwsError("StatementTimeoutException", "The Data API statement exceeded its 45-second timeout"));
        }, 45_000);
      })]);
    } finally { if (timer !== undefined) this.clock.clearTimeout(timer); }
  }

  private async connect(writer: RdsDataWriter, database: string | undefined, credential: Credential): Promise<Connection> {
    try {
      return await mysql.createConnection({ host: "127.0.0.1", port: writer.port, database, user: credential.username, password: credential.password,
        connectTimeout: 5_000, rowsAsArray: true, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
    } catch (error) {
      const errno = (error as { errno?: number })?.errno;
      if (errno === 1045) throw new AwsError("InvalidSecretException", "The supplied credential could not authenticate to the cluster");
      if (errno === 1049) throw new AwsError("DatabaseErrorException", "The requested database does not exist");
      throw unavailable();
    }
  }

  private arm(transaction: Transaction): void {
    if (transaction.timer !== undefined) this.clock.clearTimeout(transaction.timer);
    const remaining = transaction.deadline - this.clock.now();
    transaction.timer = this.clock.setTimeout(() => this.discard(transaction), Math.max(0, transaction.busy ? remaining : Math.min(remaining, 3 * MINUTE)));
  }

  private discard(transaction: Transaction): void {
    if (!this.transactions.delete(transaction.id)) return;
    if (transaction.timer !== undefined) this.clock.clearTimeout(transaction.timer);
    transaction.connection.destroy();
  }

  invalidate(resourceArn: string): void {
    for (const request of this.requests) if (request.resourceArn === resourceArn) { request.cancelled = true; request.connection?.destroy(); }
    for (const transaction of this.transactions.values()) if (transaction.resourceArn === resourceArn) this.discard(transaction);
  }

  close(): void {
    for (const request of this.requests) { request.cancelled = true; request.connection?.destroy(); }
    for (const transaction of this.transactions.values()) this.discard(transaction);
  }
}
