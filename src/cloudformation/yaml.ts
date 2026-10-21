/**
 * Bounded, dependency-free YAML reader for CloudFormation templates.
 *
 * CloudFormation documents YAML 1.1 support without the binary, omap, pairs,
 * set, and timestamp tags, aliases, or hash merges. This reader covers the
 * subset templates use in practice: block and flow collections, plain,
 * single-quoted, double-quoted, literal, and folded scalars, comments,
 * document markers, the core `!!` tags, and the CloudFormation short-form
 * intrinsic tags. Anything outside that subset fails with a line and column
 * instead of being guessed at.
 */

export class CloudFormationYamlError extends Error {
  readonly code = "ValidationError" as const;

  constructor(public readonly detail: string, public readonly line: number, public readonly column: number) {
    super(`Template format error: YAML not well-formed. (line ${line}, column ${column}): ${detail}`);
    this.name = "CloudFormationYamlError";
  }
}

/** Short-form tags and the long-form keys they denote. */
export const CLOUDFORMATION_SHORT_FORM_TAGS: ReadonlyMap<string, string> = new Map([
  ["!Ref", "Ref"],
  ["!Condition", "Condition"],
  ["!GetAtt", "Fn::GetAtt"],
  ["!Sub", "Fn::Sub"],
  ["!Join", "Fn::Join"],
  ["!Select", "Fn::Select"],
  ["!Split", "Fn::Split"],
  ["!If", "Fn::If"],
  ["!Equals", "Fn::Equals"],
  ["!And", "Fn::And"],
  ["!Or", "Fn::Or"],
  ["!Not", "Fn::Not"],
  ["!FindInMap", "Fn::FindInMap"],
  ["!ImportValue", "Fn::ImportValue"],
  ["!GetAZs", "Fn::GetAZs"],
  ["!Base64", "Fn::Base64"],
  ["!Cidr", "Fn::Cidr"],
  ["!Transform", "Fn::Transform"],
  ["!Contains", "Fn::Contains"],
  // Rules-section functions have documented short forms too.
  ["!EachMemberEquals", "Fn::EachMemberEquals"],
  ["!EachMemberIn", "Fn::EachMemberIn"],
  ["!RefAll", "Fn::RefAll"],
  ["!ValueOf", "Fn::ValueOf"],
  ["!ValueOfAll", "Fn::ValueOfAll"],
]);

const CORE_TAGS = new Set(["!!str", "!!int", "!!float", "!!bool", "!!null", "!!seq", "!!map"]);
const UNSUPPORTED_CORE_TAGS = new Set(["!!binary", "!!omap", "!!pairs", "!!set", "!!timestamp"]);
const YAML_TRUE = new Set(["true", "True", "TRUE", "yes", "Yes", "YES", "on", "On", "ON"]);
const YAML_FALSE = new Set(["false", "False", "FALSE", "no", "No", "NO", "off", "Off", "OFF"]);
const YAML_NULL = new Set(["", "~", "null", "Null", "NULL"]);
const MAX_DEPTH = 256;

interface Scalar { readonly kind: "scalar"; readonly text: string; readonly plain: boolean }
interface Collection { readonly kind: "collection"; readonly value: unknown[] | Record<string, unknown>; readonly sequence: boolean }
type Parsed = Scalar | Collection;
interface Tag { readonly name: string; readonly at: number }
interface ContentLine { readonly indent: number; readonly pos: number; readonly marker?: "---" | "..." }

const EMPTY: Scalar = { kind: "scalar", text: "", plain: true };

/** Resolve an untagged plain scalar with CloudFormation's YAML 1.1 rules. */
export function resolvePlainScalar(text: string): unknown {
  if (YAML_NULL.has(text)) return null;
  if (YAML_TRUE.has(text)) return true;
  if (YAML_FALSE.has(text)) return false;
  // Only canonical decimal numbers become JSON numbers. Forms whose text a
  // JSON number cannot preserve (1.0, 0755, 1_000, 0x1F, 1e3) stay strings,
  // which every CloudFormation property that accepts a number also accepts.
  if (/^-?(0|[1-9][0-9]*)$/.test(text)) {
    const value = Number(text);
    if (Number.isSafeInteger(value) && String(value) === text) return value;
  } else if (/^-?[0-9]+\.[0-9]+$/.test(text)) {
    const value = Number(text);
    if (Number.isFinite(value) && String(value) === text) return value;
  }
  return text;
}

function setKey(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  else target[key] = value;
}

const isBlank = (ch: string | undefined): boolean => ch === " " || ch === "\t";
const isBreakOrEnd = (ch: string | undefined): boolean => ch === undefined || ch === "\n";
const isSpaceOrEnd = (ch: string | undefined): boolean => ch === undefined || ch === " " || ch === "\t" || ch === "\n";
const isFlowIndicator = (ch: string | undefined): boolean => ch === "," || ch === "[" || ch === "]" || ch === "{" || ch === "}";

class YamlReader {
  private readonly text: string;
  private readonly lineStarts: number[] = [0];
  private pos = 0;
  private depth = 0;

  constructor(source: string) {
    let text = source.replace(/\r\n?/g, "\n");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    this.text = text;
    for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") this.lineStarts.push(index + 1);
  }

  parseDocument(): unknown {
    let first = this.peekContentLine(0);
    while (first && first.indent === 0 && this.text[first.pos] === "%") {
      const lineEnd = this.lineEnd(first.pos);
      if (!/^%YAML[ \t]+1\.[0-9]+[ \t]*(#.*)?$/.test(this.text.slice(first.pos, lineEnd))) this.fail("YAML directives other than %YAML are not supported", first.pos);
      first = this.peekContentLine(lineEnd + 1);
      if (!first || first.marker !== "---") this.fail("a %YAML directive must be followed by a --- document start marker", first?.pos ?? this.text.length);
    }
    let root: unknown = null;
    if (first?.marker === "---") {
      this.pos = first.pos + 3;
      this.skipInline();
      root = this.atCommentOrEnd() ? this.value(this.parseFollowingLines(-1, false)) : this.value(this.parseNodeHere(-1, false));
    } else if (first?.marker === "...") {
      this.fail("a document end marker cannot precede the document", first.pos);
    } else if (first) {
      this.pos = first.pos;
      root = this.value(this.parseNodeHere(-1, true));
    }
    let next = this.peekContentLine(this.pos);
    if (next?.marker === "...") {
      this.pos = next.pos + 3;
      this.finishLine();
      next = this.peekContentLine(this.pos);
    }
    if (next?.marker === "---") this.fail("multiple YAML documents are not supported", next.pos);
    if (next) this.fail("unexpected content after the document root", next.pos);
    return root;
  }

  private fail(message: string, at = this.pos): never {
    const offset = Math.min(Math.max(at, 0), this.text.length);
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.lineStarts[middle] <= offset) low = middle; else high = middle - 1;
    }
    throw new CloudFormationYamlError(message, low + 1, offset - this.lineStarts[low] + 1);
  }

  private column(at = this.pos): number {
    return at - (this.text.lastIndexOf("\n", at - 1) + 1);
  }

  private lineEnd(from: number): number {
    const end = this.text.indexOf("\n", from);
    return end < 0 ? this.text.length : end;
  }

  private skipInline(): void {
    while (isBlank(this.text[this.pos])) this.pos += 1;
  }

  private atCommentOrEnd(): boolean {
    const ch = this.text[this.pos];
    return isBreakOrEnd(ch) || ch === "#";
  }

  /** Consume trailing blanks and a comment, then the line break. */
  private finishLine(): void {
    this.skipInline();
    if (this.text[this.pos] === "#") this.pos = this.lineEnd(this.pos);
    if (this.text[this.pos] === "\n") this.pos += 1;
    else if (this.pos < this.text.length) {
      if (this.text[this.pos] === ":") this.fail("mapping values are not allowed in this context");
      this.fail(`unexpected character ${JSON.stringify(this.text[this.pos])} after a value`);
    }
  }

  /** From a line start, find the next line that has content. */
  private peekContentLine(from: number): ContentLine | undefined {
    let lineStart = from;
    while (lineStart < this.text.length) {
      const lineEnd = this.lineEnd(lineStart);
      let cursor = lineStart;
      while (this.text[cursor] === " ") cursor += 1;
      let probe = cursor;
      while (isBlank(this.text[probe])) probe += 1;
      if (probe === lineEnd || this.text[probe] === "#") { lineStart = lineEnd + 1; continue; }
      if (this.text[cursor] === "\t") this.fail("tab characters must not be used for indentation", cursor);
      const indent = cursor - lineStart;
      if (indent === 0) {
        const marker = this.text.slice(cursor, cursor + 3);
        if ((marker === "---" || marker === "...") && isSpaceOrEnd(this.text[cursor + 3])) return { indent, pos: cursor, marker };
      }
      return { indent, pos: cursor };
    }
    return undefined;
  }

  private isSequenceEntryAt(at: number): boolean {
    return this.text[at] === "-" && isSpaceOrEnd(this.text[at + 1]);
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) this.fail(`collections are nested more than ${MAX_DEPTH} levels deep`);
  }

  private value(node: Parsed, tag?: Tag): unknown {
    if (!tag) return node.kind === "scalar" ? (node.plain ? resolvePlainScalar(node.text) : node.text) : node.value;
    const name = tag.name;
    if (CORE_TAGS.has(name)) {
      if (name === "!!seq" || name === "!!map") {
        if (node.kind !== "collection" || node.sequence !== (name === "!!seq")) this.fail(`${name} requires a ${name === "!!seq" ? "sequence" : "mapping"}`, tag.at);
        return node.value;
      }
      if (node.kind !== "scalar") this.fail(`${name} requires a scalar`, tag.at);
      if (name === "!!str") return node.text;
      if (name === "!!null") {
        if (!YAML_NULL.has(node.text)) this.fail(`${JSON.stringify(node.text)} is not a valid !!null value`, tag.at);
        return null;
      }
      if (name === "!!bool") {
        if (YAML_TRUE.has(node.text)) return true;
        if (YAML_FALSE.has(node.text)) return false;
        this.fail(`${JSON.stringify(node.text)} is not a valid !!bool value`, tag.at);
      }
      const number = Number(node.text.trim());
      const pattern = name === "!!int" ? /^[-+]?[0-9]+$/ : /^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][-+]?[0-9]+)?$/;
      if (!pattern.test(node.text.trim()) || !Number.isFinite(number)) this.fail(`${JSON.stringify(node.text)} is not a valid ${name} value`, tag.at);
      return number;
    }
    if (UNSUPPORTED_CORE_TAGS.has(name)) this.fail(`CloudFormation does not support the ${name} tag`, tag.at);
    const key = CLOUDFORMATION_SHORT_FORM_TAGS.get(name);
    if (key === undefined) this.fail(`unknown tag ${name}`, tag.at);
    if (node.kind === "scalar") {
      if (name === "!GetAtt") {
        const dot = node.text.indexOf(".");
        return { [key]: dot < 0 ? node.text : [node.text.slice(0, dot), node.text.slice(dot + 1)] };
      }
      return { [key]: node.text };
    }
    if (name === "!Ref" || name === "!Condition") this.fail(`${name} requires a scalar value`, tag.at);
    return { [key]: node.value };
  }

  private readTag(): Tag {
    const at = this.pos;
    if (this.text[this.pos + 1] === "<") this.fail("verbatim tags are not supported");
    let end = this.pos + 1;
    while (end < this.text.length && !isSpaceOrEnd(this.text[end]) && !isFlowIndicator(this.text[end])) end += 1;
    const name = this.text.slice(this.pos, end);
    if (name === "!" || name === "!!") this.fail("a tag requires a name");
    this.pos = end;
    return { name, at };
  }

  private rejectNodeProperty(): void {
    const ch = this.text[this.pos];
    if (ch === "&") this.fail("anchors are not supported by CloudFormation");
    if (ch === "*") this.fail("aliases are not supported by CloudFormation");
  }

  /**
   * Parse a block-context node whose first character is at the cursor. Every
   * block parser leaves the cursor at the start of the line after the node.
   */
  private parseNodeHere(parentIndent: number, compact: boolean): Parsed {
    this.rejectNodeProperty();
    if (this.text[this.pos] === "!") {
      const tag = this.readTag();
      if (!isSpaceOrEnd(this.text[this.pos])) this.fail(`tag ${tag.name} must be followed by a space`);
      this.skipInline();
      if (this.text[this.pos] === "!") this.fail("a node can have only one tag");
      const node = this.atCommentOrEnd() ? this.parseFollowingLines(parentIndent, false) : this.parseNodeHere(parentIndent, false);
      return this.tagged(node, tag);
    }
    const column = this.column();
    if (compact) {
      if (this.isSequenceEntryAt(this.pos)) return this.parseBlockSequence(column);
      if (this.text[this.pos] === "?" && isSpaceOrEnd(this.text[this.pos + 1])) this.fail("explicit mapping keys are not supported");
      if (this.scanKey()) return this.parseBlockMapping(column);
    }
    return this.parseFlowOrScalar(parentIndent);
  }

  private tagged(node: Parsed, tag: Tag): Parsed {
    const value = this.value(node, tag);
    return { kind: "collection", value: value as Record<string, unknown>, sequence: Array.isArray(value) };
  }

  /** The cursor is at a comment or line end; the node, if any, is on later lines. */
  private parseFollowingLines(parentIndent: number, sequenceAtSameIndent: boolean): Parsed {
    this.finishLine();
    const next = this.peekContentLine(this.pos);
    if (next && !next.marker && (next.indent > parentIndent || (sequenceAtSameIndent && next.indent === parentIndent && this.isSequenceEntryAt(next.pos)))) {
      this.pos = next.pos;
      return this.parseNodeHere(parentIndent, true);
    }
    return EMPTY;
  }

  private parseBlockSequence(column: number): Parsed {
    this.enter();
    const items: unknown[] = [];
    for (;;) {
      this.pos += 1;
      this.skipInline();
      items.push(this.value(this.atCommentOrEnd() ? this.parseFollowingLines(column, false) : this.parseNodeHere(column, true)));
      const next = this.peekContentLine(this.pos);
      if (!next || next.marker || next.indent < column) break;
      if (next.indent > column) this.fail("bad indentation of a sequence entry", next.pos);
      if (!this.isSequenceEntryAt(next.pos)) break;
      this.pos = next.pos;
    }
    this.depth -= 1;
    return { kind: "collection", value: items, sequence: true };
  }

  private parseBlockMapping(column: number): Parsed {
    this.enter();
    const result: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (;;) {
      const keyAt = this.pos;
      this.rejectNodeProperty();
      if (this.text[this.pos] === "!") this.fail("tags on mapping keys are not supported");
      if (this.text[this.pos] === "?" && isSpaceOrEnd(this.text[this.pos + 1])) this.fail("explicit mapping keys are not supported");
      const key = this.scanKey();
      if (!key) this.fail(this.isSequenceEntryAt(this.pos) ? "a sequence entry cannot appear inside a mapping" : "could not find expected ':' after a mapping key");
      if (key.plain && key.text === "<<") this.fail("merge keys (<<) are not supported by CloudFormation", keyAt);
      if (seen.has(key.text)) this.fail(`duplicate mapping key ${JSON.stringify(key.text)}`, keyAt);
      seen.add(key.text);
      this.pos = key.next;
      this.skipInline();
      const node = this.atCommentOrEnd() ? this.parseFollowingLines(column, true) : this.parseNodeHere(column, false);
      setKey(result, key.text, this.value(node));
      const next = this.peekContentLine(this.pos);
      if (!next || next.marker || next.indent < column) break;
      if (next.indent > column) this.fail("bad indentation of a mapping entry", next.pos);
      this.pos = next.pos;
      if (this.isSequenceEntryAt(this.pos)) this.fail("a sequence entry cannot appear inside a mapping");
    }
    this.depth -= 1;
    return { kind: "collection", value: result, sequence: false };
  }

  /** Recognize `key:` on the current line without consuming it. */
  private scanKey(): { text: string; plain: boolean; next: number } | undefined {
    const start = this.pos;
    const ch = this.text[start];
    if (ch === '"' || ch === "'") {
      let text: string;
      try { text = this.readQuoted(true); } catch (error) { this.pos = start; if (error instanceof CloudFormationYamlError) return undefined; throw error; }
      const end = this.pos;
      this.pos = start;
      let cursor = end;
      while (isBlank(this.text[cursor])) cursor += 1;
      return this.text[cursor] === ":" && isSpaceOrEnd(this.text[cursor + 1]) ? { text, plain: false, next: cursor + 1 } : undefined;
    }
    if (ch === undefined || isBlank(ch) || ch === "\n" || isFlowIndicator(ch) || ch === "#" || ch === "|" || ch === ">" || ch === "&" || ch === "*" || ch === "!" || ch === "%" || ch === "@" || ch === "`") return undefined;
    if ((ch === "-" || ch === "?" || ch === ":") && isSpaceOrEnd(this.text[start + 1])) return undefined;
    const lineEnd = this.lineEnd(start);
    for (let cursor = start; cursor < lineEnd; cursor += 1) {
      const current = this.text[cursor];
      if (current === "#" && isBlank(this.text[cursor - 1])) return undefined;
      if (current === ":" && isSpaceOrEnd(this.text[cursor + 1])) {
        const text = this.text.slice(start, cursor).replace(/[ \t]+$/, "");
        return { text, plain: true, next: cursor + 1 };
      }
    }
    return undefined;
  }

  private parseFlowOrScalar(parentIndent: number): Parsed {
    const ch = this.text[this.pos];
    if (ch === "[" || ch === "{") {
      const value = this.parseFlowCollection();
      this.finishLine();
      return value;
    }
    if (ch === "|" || ch === ">") return this.parseBlockScalar(parentIndent);
    if (ch === '"' || ch === "'") {
      const text = this.readQuoted(false);
      this.finishLine();
      return { kind: "scalar", text, plain: false };
    }
    if (ch === "@" || ch === "`") this.fail(`plain scalars cannot start with the reserved character ${ch}`);
    if (ch === "," || ch === "]" || ch === "}") this.fail(`unexpected character ${JSON.stringify(ch)}`);
    const text = this.readPlainBlock(parentIndent);
    this.finishLine();
    return { kind: "scalar", text, plain: true };
  }

  /** Read one line segment of a block plain scalar. */
  private plainSegment(): string {
    const start = this.pos;
    const lineEnd = this.lineEnd(start);
    let cursor = start;
    while (cursor < lineEnd) {
      const ch = this.text[cursor];
      if (ch === "#" && cursor > start && isBlank(this.text[cursor - 1])) break;
      if (ch === ":" && isSpaceOrEnd(this.text[cursor + 1])) this.fail("mapping values are not allowed in this context", cursor);
      cursor += 1;
    }
    let end = cursor;
    while (end > start && isBlank(this.text[end - 1])) end -= 1;
    this.pos = end;
    return this.text.slice(start, end);
  }

  private readPlainBlock(parentIndent: number): string {
    let text = this.plainSegment();
    for (;;) {
      let cursor = this.pos;
      while (isBlank(this.text[cursor])) cursor += 1;
      if (this.text[cursor] !== "\n") break;
      let lineStart = cursor + 1;
      let breaks = 0;
      let continued = false;
      while (lineStart < this.text.length) {
        const lineEnd = this.lineEnd(lineStart);
        let content = lineStart;
        while (isBlank(this.text[content])) content += 1;
        if (content === lineEnd) { breaks += 1; lineStart = lineEnd + 1; continue; }
        let indent = 0;
        while (this.text[lineStart + indent] === " ") indent += 1;
        const markerLine = indent === 0 && /^(---|\.\.\.)$/.test(this.text.slice(lineStart, lineStart + 3)) && isSpaceOrEnd(this.text[lineStart + 3]);
        if (this.text[content] !== "#" && indent > parentIndent && !markerLine) {
          this.pos = content;
          text += (breaks === 0 ? " " : "\n".repeat(breaks)) + this.plainSegment();
          continued = true;
        }
        break;
      }
      if (!continued) break;
    }
    return text;
  }

  /** Read a quoted scalar; multi-line content folds as YAML specifies. */
  private readQuoted(singleLine: boolean): string {
    const quote = this.text[this.pos];
    const start = this.pos;
    this.pos += 1;
    let result = "";
    let pendingWhitespace = "";
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) this.fail(`unterminated ${quote === '"' ? "double" : "single"}-quoted scalar`, start);
      if (ch === quote) {
        if (quote === "'" && this.text[this.pos + 1] === "'") { result += pendingWhitespace + "'"; pendingWhitespace = ""; this.pos += 2; continue; }
        this.pos += 1;
        return result + pendingWhitespace;
      }
      if (ch === "\n") {
        if (singleLine) this.fail("a mapping key cannot span lines", start);
        let breaks = 0;
        while (this.text[this.pos] === "\n" || isBlank(this.text[this.pos])) {
          if (this.text[this.pos] === "\n") {
            breaks += 1;
            const marker = this.text.slice(this.pos + 1, this.pos + 4);
            if ((marker === "---" || marker === "...") && isSpaceOrEnd(this.text[this.pos + 4])) this.fail("document markers are not allowed inside a quoted scalar", this.pos + 1);
          }
          this.pos += 1;
        }
        result += breaks === 1 ? " " : "\n".repeat(breaks - 1);
        pendingWhitespace = "";
        continue;
      }
      if (isBlank(ch)) { pendingWhitespace += ch; this.pos += 1; continue; }
      result += pendingWhitespace;
      pendingWhitespace = "";
      if (quote === '"' && ch === "\\") {
        result += this.readEscape();
        continue;
      }
      result += ch;
      this.pos += 1;
    }
  }

  private readEscape(): string {
    const at = this.pos;
    const ch = this.text[this.pos + 1];
    this.pos += 2;
    const simple: Record<string, string> = { "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\u0085", _: " ", L: " ", P: " " };
    if (ch !== undefined && Object.hasOwn(simple, ch)) return simple[ch];
    if (ch === "\n") {
      while (isBlank(this.text[this.pos])) this.pos += 1;
      return "";
    }
    const width = ch === "x" ? 2 : ch === "u" ? 4 : ch === "U" ? 8 : 0;
    if (width === 0) this.fail(`unknown escape sequence \\${ch ?? ""}`, at);
    const hex = this.text.slice(this.pos, this.pos + width);
    if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== width) this.fail(`invalid \\${ch} escape sequence`, at);
    const codePoint = Number.parseInt(hex, 16);
    if (codePoint > 0x10ffff) this.fail(`invalid \\${ch} escape sequence`, at);
    this.pos += width;
    return String.fromCodePoint(codePoint);
  }

  private parseBlockScalar(parentIndent: number): Parsed {
    const literal = this.text[this.pos] === "|";
    this.pos += 1;
    let chomping: "clip" | "strip" | "keep" = "clip";
    let explicitIndent: number | undefined;
    for (let index = 0; index < 2; index += 1) {
      const ch = this.text[this.pos];
      if ((ch === "-" || ch === "+") && chomping === "clip") { chomping = ch === "-" ? "strip" : "keep"; this.pos += 1; }
      else if (ch !== undefined && ch >= "1" && ch <= "9" && explicitIndent === undefined) { explicitIndent = Number(ch); this.pos += 1; }
    }
    if (!isSpaceOrEnd(this.text[this.pos])) this.fail("invalid block scalar header");
    this.finishLine();
    let contentIndent = explicitIndent === undefined ? undefined : parentIndent + explicitIndent;
    const lines: string[] = [];
    let lineStart = this.pos;
    while (lineStart < this.text.length) {
      const lineEnd = this.lineEnd(lineStart);
      let indent = 0;
      while (this.text[lineStart + indent] === " ") indent += 1;
      const blank = lineStart + indent === lineEnd;
      if (contentIndent === undefined && !blank) {
        if (indent <= parentIndent) break;
        if (this.text[lineStart + indent] === "\t") this.fail("tab characters must not be used for indentation", lineStart + indent);
        contentIndent = indent;
      }
      if (blank) {
        lines.push(contentIndent !== undefined && indent > contentIndent ? this.text.slice(lineStart + contentIndent, lineEnd) : "");
      } else if (indent < (contentIndent ?? 0)) {
        break;
      } else {
        lines.push(this.text.slice(lineStart + (contentIndent ?? 0), lineEnd));
      }
      lineStart = lineEnd + 1;
    }
    if (lineStart > this.text.length) lineStart = this.text.length;
    // Trailing blank lines belong to the scalar only for chomping purposes.
    let trailing = 0;
    while (lines.length > trailing && lines[lines.length - 1 - trailing] === "") trailing += 1;
    const content = lines.slice(0, lines.length - trailing);
    let result = "";
    let emptyLines = 0;
    let didReadContent = false;
    let atMoreIndented = false;
    for (const line of content) {
      if (line === "") { emptyLines += 1; continue; }
      if (!literal) {
        if (isBlank(line[0])) {
          atMoreIndented = true;
          result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
        } else if (atMoreIndented) {
          atMoreIndented = false;
          result += "\n".repeat(emptyLines + 1);
        } else if (emptyLines === 0) {
          if (didReadContent) result += " ";
        } else {
          result += "\n".repeat(emptyLines);
        }
      } else {
        result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
      }
      result += line;
      emptyLines = 0;
      didReadContent = true;
    }
    if (chomping === "keep") result += "\n".repeat(didReadContent ? 1 + emptyLines + trailing : emptyLines + trailing);
    else if (chomping === "clip" && didReadContent) result += "\n";
    this.pos = lineStart;
    return { kind: "scalar", text: result, plain: false };
  }

  private skipFlowSpace(): void {
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === " " || ch === "\t" || ch === "\n") {
        if (ch === "\n") {
          const marker = this.text.slice(this.pos + 1, this.pos + 4);
          if ((marker === "---" || marker === "...") && isSpaceOrEnd(this.text[this.pos + 4])) this.fail("document markers are not allowed inside a flow collection", this.pos + 1);
        }
        this.pos += 1;
      } else if (ch === "#" && (this.pos === 0 || isSpaceOrEnd(this.text[this.pos - 1]))) {
        this.pos = this.lineEnd(this.pos);
      } else return;
    }
  }

  private parseFlowCollection(): Parsed {
    this.enter();
    const open = this.text[this.pos];
    const start = this.pos;
    const close = open === "[" ? "]" : "}";
    this.pos += 1;
    const items: unknown[] = [];
    const mapping: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (;;) {
      this.skipFlowSpace();
      const ch = this.text[this.pos];
      if (ch === undefined) this.fail(`unterminated flow ${open === "[" ? "sequence" : "mapping"}`, start);
      if (ch === close) { this.pos += 1; break; }
      if (ch === "?" && isSpaceOrEnd(this.text[this.pos + 1])) this.fail("explicit mapping keys are not supported");
      const entryAt = this.pos;
      const first = this.parseFlowNode();
      this.skipFlowSpace();
      if (open === "{" || this.text[this.pos] === ":") {
        if (first.node.kind !== "scalar" || first.tag) this.fail("flow mapping keys must be untagged scalars", entryAt);
        const key = first.node.text;
        if (first.node.plain && key === "<<") this.fail("merge keys (<<) are not supported by CloudFormation", entryAt);
        let value: unknown = null;
        if (this.text[this.pos] === ":") {
          this.pos += 1;
          this.skipFlowSpace();
          const next = this.text[this.pos];
          if (next !== "," && next !== close) {
            const parsed = this.parseFlowNode();
            value = this.value(parsed.node, parsed.tag);
            this.skipFlowSpace();
          }
        }
        if (open === "{") {
          if (seen.has(key)) this.fail(`duplicate mapping key ${JSON.stringify(key)}`, entryAt);
          seen.add(key);
          setKey(mapping, key, value);
        } else {
          const pair: Record<string, unknown> = {};
          setKey(pair, key, value);
          items.push(pair);
        }
      } else {
        items.push(this.value(first.node, first.tag));
      }
      const separator = this.text[this.pos];
      if (separator === ",") { this.pos += 1; continue; }
      if (separator === undefined) this.fail(`unterminated flow ${open === "[" ? "sequence" : "mapping"}`, start);
      if (separator !== close) this.fail(`expected ',' or '${close}' in a flow ${open === "[" ? "sequence" : "mapping"}`);
    }
    this.depth -= 1;
    return open === "[" ? { kind: "collection", value: items, sequence: true } : { kind: "collection", value: mapping, sequence: false };
  }

  private parseFlowNode(): { node: Parsed; tag?: Tag } {
    this.skipFlowSpace();
    this.rejectNodeProperty();
    let tag: Tag | undefined;
    if (this.text[this.pos] === "!") {
      tag = this.readTag();
      this.skipFlowSpace();
      if (this.text[this.pos] === "!") this.fail("a node can have only one tag");
      this.rejectNodeProperty();
    }
    const ch = this.text[this.pos];
    if (ch === "," || ch === "]" || ch === "}" || ch === ":" && isSpaceOrEnd(this.text[this.pos + 1])) return { node: EMPTY, tag };
    if (ch === "[" || ch === "{") return { node: this.parseFlowCollection(), tag };
    if (ch === '"' || ch === "'") return { node: { kind: "scalar", text: this.readQuoted(false), plain: false }, tag };
    if (ch === "|" || ch === ">") this.fail("block scalars are not allowed inside a flow collection");
    if (ch === "@" || ch === "`") this.fail(`plain scalars cannot start with the reserved character ${ch}`);
    return { node: { kind: "scalar", text: this.readPlainFlow(), plain: true }, tag };
  }

  private readPlainFlow(): string {
    let text = "";
    for (;;) {
      const start = this.pos;
      for (;;) {
        const ch = this.text[this.pos];
        if (ch === undefined || ch === "\n" || isFlowIndicator(ch)) break;
        if (ch === ":" && (isSpaceOrEnd(this.text[this.pos + 1]) || isFlowIndicator(this.text[this.pos + 1]))) break;
        if (ch === "#" && this.pos > start && isBlank(this.text[this.pos - 1])) break;
        this.pos += 1;
      }
      let end = this.pos;
      while (end > start && isBlank(this.text[end - 1])) end -= 1;
      text += this.text.slice(start, end);
      if (this.text[this.pos] !== "\n") return text;
      // A plain scalar may continue on the next line inside a flow collection.
      let cursor = this.pos;
      let breaks = 0;
      while (this.text[cursor] === "\n" || isBlank(this.text[cursor])) { if (this.text[cursor] === "\n") breaks += 1; cursor += 1; }
      const next = this.text[cursor];
      if (next === undefined || isFlowIndicator(next) || next === "#" || next === ":") { this.pos = end; return text; }
      text += breaks === 1 ? " " : "\n".repeat(breaks - 1);
      this.pos = cursor;
    }
  }
}

/**
 * Parse a CloudFormation YAML template body into JSON-compatible values,
 * converting the short-form intrinsic tags to their long forms.
 */
export function parseCloudFormationYaml(source: string): unknown {
  return new YamlReader(source).parseDocument();
}
