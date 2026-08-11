export interface PartiqlAuthorizationReference {
  action: "dynamodb:PartiQLSelect" | "dynamodb:PartiQLInsert" | "dynamodb:PartiQLUpdate" | "dynamodb:PartiQLDelete";
  tableName?: string;
  indexName?: string;
}

interface HeaderToken {
  kind: "word" | "identifier" | "string" | "symbol";
  value: string;
}

const actions: Record<string, PartiqlAuthorizationReference["action"]> = {
  SELECT: "dynamodb:PartiQLSelect",
  INSERT: "dynamodb:PartiQLInsert",
  UPDATE: "dynamodb:PartiQLUpdate",
  DELETE: "dynamodb:PartiQLDelete",
};

function headerTokens(statement: string): HeaderToken[] | undefined {
  const tokens: HeaderToken[] = [];
  let index = 0;
  while (index < statement.length) {
    if (/\s/.test(statement[index])) { index++; continue; }
    if (statement[index] === '"') {
      index++; let value = ""; let closed = false;
      while (index < statement.length) {
        if (statement[index] === '"' && statement[index + 1] === '"') { value += '"'; index += 2; continue; }
        if (statement[index] === '"') { index++; closed = true; break; }
        value += statement[index++];
      }
      if (!closed) return undefined;
      tokens.push({ kind: "identifier", value });
      continue;
    }
    if (statement[index] === "'") {
      index++; let value = ""; let closed = false;
      while (index < statement.length) {
        if (statement[index] === "'" && statement[index + 1] === "'") { value += "'"; index += 2; continue; }
        if (statement[index] === "'") { index++; closed = true; break; }
        value += statement[index++];
      }
      if (!closed) return undefined;
      tokens.push({ kind: "string", value });
      continue;
    }
    const word = statement.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
    if (word) { tokens.push({ kind: "word", value: word[0] }); index += word[0].length; continue; }
    tokens.push({ kind: "symbol", value: statement[index++] });
  }
  return tokens;
}

function identifier(tokens: HeaderToken[], index: number): string | undefined {
  return new Set(["word", "identifier"]).has(tokens[index]?.kind) && tokens[index].value ? tokens[index].value : undefined;
}

function selectTargetIndex(tokens: HeaderToken[], selectIndex = 0): number | undefined {
  const closing: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let index = selectIndex + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === "symbol" && closing[token.value]) { stack.push(closing[token.value]); continue; }
    if (token.kind === "symbol" && token.value === stack.at(-1)) { stack.pop(); continue; }
    if (!stack.length && token.kind === "word" && token.value.toUpperCase() === "FROM") return index + 1;
  }
  return undefined;
}

/**
 * Reads only the operation and resource header. Full statement validation remains
 * in the DynamoDB PartiQL parser so malformed batch entries keep their API shape.
 */
export function partiqlAuthorizationReference(statement: unknown): PartiqlAuthorizationReference | undefined {
  if (typeof statement !== "string") return undefined;
  const tokens = headerTokens(statement);
  if (!tokens?.length || tokens[0].kind !== "word") return undefined;
  const outerVerb = tokens[0].value.toUpperCase();
  const existsSelect = outerVerb === "EXISTS" && tokens[1]?.value === "(" && tokens[2]?.kind === "word" && tokens[2].value.toUpperCase() === "SELECT";
  const verb = existsSelect ? "SELECT" : outerVerb;
  const action = actions[verb] ?? (outerVerb === "EXISTS" ? "dynamodb:PartiQLSelect" : undefined);
  if (!action) return undefined;

  let targetIndex: number | undefined;
  if (verb === "SELECT") targetIndex = selectTargetIndex(tokens, existsSelect ? 2 : 0);
  else if (verb === "INSERT" && tokens[1]?.kind === "word" && tokens[1].value.toUpperCase() === "INTO") targetIndex = 2;
  else if (verb === "UPDATE") targetIndex = 1;
  else if (verb === "DELETE" && tokens[1]?.kind === "word" && tokens[1].value.toUpperCase() === "FROM") targetIndex = 2;

  const tableName = targetIndex === undefined ? undefined : identifier(tokens, targetIndex);
  if (!tableName) return { action };
  if (verb !== "SELECT" || tokens[targetIndex! + 1]?.value !== ".") return { action, tableName };
  const indexName = identifier(tokens, targetIndex! + 2);
  return { action, tableName, ...(indexName ? { indexName } : {}) };
}

export function partiqlAuthorizationTarget(statement: unknown, region: string, accountId: string): { action: PartiqlAuthorizationReference["action"]; resource: string } | undefined {
  const reference = partiqlAuthorizationReference(statement);
  if (!reference) return undefined;
  const resource = reference.tableName ? `arn:aws:dynamodb:${region}:${accountId}:table/${reference.tableName}${reference.indexName ? `/index/${reference.indexName}` : ""}` : "*";
  return { action: reference.action, resource };
}
