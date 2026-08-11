import { InsightsSyntaxError, type SourceSpan } from "./cloudwatch-insights-types.js";

export type InsightsTokenKind = "identifier" | "string" | "number" | "duration" | "regex" | "operator" | "punctuation" | "eof";

export interface InsightsToken extends SourceSpan {
  kind: InsightsTokenKind;
  text: string;
  value?: string | number;
  flags?: string;
  quoted?: boolean;
}

const OPERATORS = ["!=", ">=", "<=", "=~", "==", "**", "=", ">", "<", "+", "-", "*", "/", "%", "^"];
const DURATION_UNITS: Record<string, string> = { ms: "ms", msec: "ms", msecs: "ms", millisecond: "ms", milliseconds: "ms", s: "s", sec: "s", secs: "s", second: "s", seconds: "s", m: "m", min: "m", mins: "m", minute: "m", minutes: "m", h: "h", hr: "h", hrs: "h", hour: "h", hours: "h", d: "d", day: "d", days: "d", w: "w", week: "w", weeks: "w", mo: "mo", mon: "mo", mons: "mo", month: "mo", months: "mo", q: "q", qtr: "q", qtrs: "q", quarter: "q", quarters: "q", y: "y", yr: "y", yrs: "y", year: "y", years: "y" };

function escapedCharacter(character: string): string {
  if (character === "n") return "\n";
  if (character === "r") return "\r";
  if (character === "t") return "\t";
  if (character === "b") return "\b";
  if (character === "f") return "\f";
  return character;
}

export class InsightsLexer {
  private index = 0;
  private readonly output: InsightsToken[] = [];

  constructor(private readonly source: string) {}

  lex(): InsightsToken[] {
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (/\s/.test(character)) { this.index++; continue; }
      if (character === "#") { this.comment(); continue; }
      if (character === "'" || character === '"') { this.string(character); continue; }
      if (character === "`") { this.backtick(); continue; }
      if (character === "/" && this.regexMayStart()) { this.regex(); continue; }
      if (/\d/.test(character) || (character === "." && /\d/.test(this.source[this.index + 1] ?? ""))) { this.number(); continue; }
      if (/[A-Za-z_@]/.test(character)) { this.identifier(); continue; }
      if ("|(),[]{}:.".includes(character)) {
        this.output.push({ kind: "punctuation", text: character, start: this.index, end: ++this.index });
        continue;
      }
      const operator = OPERATORS.find(candidate => this.source.startsWith(candidate, this.index));
      if (operator) {
        const start = this.index; this.index += operator.length;
        this.output.push({ kind: "operator", text: operator, start, end: this.index });
        continue;
      }
      throw new InsightsSyntaxError(`Unexpected character '${character}'`, this.index, this.index + 1);
    }
    this.output.push({ kind: "eof", text: "", start: this.source.length, end: this.source.length });
    return this.output;
  }

  private comment(): void {
    while (this.index < this.source.length && this.source[this.index] !== "\n" && this.source[this.index] !== "\r") this.index++;
  }

  private string(quote: string): void {
    const start = this.index++; let value = "";
    while (this.index < this.source.length) {
      const character = this.source[this.index++];
      if (character === quote) {
        this.output.push({ kind: "string", text: this.source.slice(start, this.index), value, start, end: this.index });
        return;
      }
      if (character === "\\") {
        if (this.index >= this.source.length) break;
        const escaped = this.source[this.index++];
        if (escaped === "u") {
          const hex = this.source.slice(this.index, this.index + 4);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new InsightsSyntaxError("Invalid Unicode escape", this.index - 2, Math.min(this.source.length, this.index + 4));
          value += String.fromCharCode(Number.parseInt(hex, 16)); this.index += 4;
        } else value += escapedCharacter(escaped);
      } else value += character;
    }
    throw new InsightsSyntaxError("Unterminated string", start, this.source.length);
  }

  private backtick(): void {
    const start = this.index++; let value = "";
    while (this.index < this.source.length) {
      const character = this.source[this.index++];
      if (character === "`") {
        if (this.source[this.index] === "`") { value += "`"; this.index++; continue; }
        if (!value) throw new InsightsSyntaxError("A backtick field name must not be empty", start, this.index);
        this.output.push({ kind: "identifier", text: this.source.slice(start, this.index), value, quoted: true, start, end: this.index });
        return;
      }
      if (character === "\\" && this.source[this.index] === "`") { value += "`"; this.index++; }
      else value += character;
    }
    throw new InsightsSyntaxError("Unterminated backtick field name", start, this.source.length);
  }

  private regexMayStart(): boolean {
    const previous = this.output.at(-1);
    if (!previous) return true;
    let lastPipe = -1; for (let index = this.output.length - 1; index >= 0; index--) if (this.output[index].text === "|") { lastPipe = index; break; }
    if (this.output[lastPipe + 1]?.text.toLowerCase() === "parse") return true;
    if (previous.kind === "operator") return true;
    if (previous.kind === "punctuation" && ["(", "[", "{", ",", "|"].includes(previous.text)) return true;
    return previous.kind === "identifier" && ["like", "parse"].includes(previous.text.toLowerCase());
  }

  private regex(): void {
    const start = this.index++; let value = ""; let inClass = false;
    while (this.index < this.source.length) {
      const character = this.source[this.index++];
      if (character === "\\") {
        if (this.index >= this.source.length) break;
        value += `\\${this.source[this.index++]}`; continue;
      }
      if (character === "[") inClass = true;
      if (character === "]") inClass = false;
      if (character === "/" && !inClass) {
        const flagsStart = this.index;
        while (/[A-Za-z]/.test(this.source[this.index] ?? "")) this.index++;
        const flags = this.source.slice(flagsStart, this.index);
        this.output.push({ kind: "regex", text: this.source.slice(start, this.index), value, flags, start, end: this.index });
        return;
      }
      value += character;
    }
    throw new InsightsSyntaxError("Unterminated regular expression", start, this.source.length);
  }

  private number(): void {
    const start = this.index;
    const match = this.source.slice(this.index).match(/^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/)!;
    this.index += match[0].length;
    const suffix = this.source.slice(this.index).match(/^(\s*)([A-Za-z]+)/); const unit = suffix?.[2].toLowerCase();
    if (unit && DURATION_UNITS[unit]) {
      this.index += suffix![0].length;
      this.output.push({ kind: "duration", text: this.source.slice(start, this.index), value: `${match[0]}${DURATION_UNITS[unit]}`, start, end: this.index });
      return;
    }
    this.output.push({ kind: "number", text: match[0], value: Number(match[0]), start, end: this.index });
  }

  private identifier(): void {
    const start = this.index;
    const match = this.source.slice(this.index).match(/^[A-Za-z_@][A-Za-z0-9_@$-]*/)!;
    this.index += match[0].length;
    this.output.push({ kind: "identifier", text: match[0], value: match[0], start, end: this.index });
  }
}

export function lexInsights(source: string): InsightsToken[] { return new InsightsLexer(source).lex(); }
