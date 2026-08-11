import { AwsError } from "../errors.js";

export type ParsedScheduleExpression =
  | { kind: "at"; local: string }
  | { kind: "rate"; intervalMs: number }
  | { kind: "cron"; fields: CronFields };

interface CronFields {
  minute: FieldMatcher;
  hour: FieldMatcher;
  dayOfMonth: DayOfMonthMatcher;
  month: FieldMatcher;
  dayOfWeek: DayOfWeekMatcher;
  year: FieldMatcher;
}

interface FieldMatcher { values: Set<number> }
interface DayOfMonthMatcher extends FieldMatcher { any: boolean; last: boolean; lastWeekday: boolean; nearestWeekdays: number[] }
interface DayOfWeekMatcher extends FieldMatcher { any: boolean; lastWeekdays: number[]; nthWeekdays: Array<{ weekday: number; nth: number }> }

export interface NextScheduleOccurrenceInput {
  expression: string;
  timezone?: string;
  after: number;
  anchor: number;
  startDate?: number;
  endDate?: number;
  lastLocalKey?: string;
  rateFirstAtAnchor?: boolean;
}

export interface ScheduleOccurrence { at: number; localKey: string }

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const WEEKDAYS: Record<string, number> = { SUN: 1, MON: 2, TUE: 3, WED: 4, THU: 5, FRI: 6, SAT: 7 };
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function validation(message: string): never { throw new AwsError("ValidationException", message, 400); }

export function validateScheduleTimezone(value: unknown): string {
  const timezone = value === undefined || value === "" ? "UTC" : String(value);
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0); }
  catch { validation(`ScheduleExpressionTimezone ${timezone} is not a valid IANA time zone.`); }
  return timezone;
}

function numeric(value: string, names: Record<string, number>): number {
  const named = names[value.toUpperCase()];
  const parsed = named ?? Number(value);
  if (!Number.isInteger(parsed)) validation(`Invalid schedule expression value ${value}.`);
  return parsed;
}

function addRange(values: Set<number>, start: number, end: number, minimum: number, maximum: number, step: number): void {
  if (start < minimum || start > maximum || end < minimum || end > maximum || step < 1) validation("Schedule expression field is outside its allowed range.");
  if (start <= end) for (let value = start; value <= end; value += step) values.add(value);
  else {
    for (let value = start; value <= maximum; value += step) values.add(value);
    for (let value = minimum; value <= end; value += step) values.add(value);
  }
}

function parseField(raw: string, minimum: number, maximum: number, names: Record<string, number> = {}, question = false): FieldMatcher & { any: boolean } {
  const text = raw.toUpperCase();
  const values = new Set<number>();
  const any = text === "*" || question && text === "?";
  if (any) { addRange(values, minimum, maximum, minimum, maximum, 1); return { values, any }; }
  for (const item of text.split(",")) {
    const [rangePart, stepText] = item.split("/");
    if (!rangePart || item.split("/").length > 2) validation(`Invalid schedule expression field ${raw}.`);
    const step = stepText === undefined ? 1 : numeric(stepText, {});
    if (rangePart === "*") addRange(values, minimum, maximum, minimum, maximum, step);
    else if (rangePart.includes("-")) {
      const [left, right] = rangePart.split("-");
      addRange(values, numeric(left, names), numeric(right, names), minimum, maximum, step);
    } else {
      const start = numeric(rangePart, names);
      addRange(values, start, stepText === undefined ? start : maximum, minimum, maximum, step);
    }
  }
  if (!values.size) validation(`Invalid schedule expression field ${raw}.`);
  return { values, any: false };
}

function parseDayOfMonth(raw: string): DayOfMonthMatcher {
  const upper = raw.toUpperCase();
  const ordinary: string[] = []; let last = false; let lastWeekday = false; const nearestWeekdays: number[] = [];
  for (const item of upper.split(",")) {
    if (item === "L") last = true;
    else if (item === "LW") lastWeekday = true;
    else if (/^\d{1,2}W$/.test(item)) nearestWeekdays.push(Number(item.slice(0, -1)));
    else ordinary.push(item);
  }
  const base = parseField(ordinary.length ? ordinary.join(",") : upper === "?" || upper === "*" ? upper : "?", 1, 31, {}, true);
  if (nearestWeekdays.some(day => day < 1 || day > 31)) validation("The nearest-weekday day-of-month value is invalid.");
  return { values: ordinary.length || upper === "?" || upper === "*" ? base.values : new Set(), any: base.any && !last && !lastWeekday && !nearestWeekdays.length, last, lastWeekday, nearestWeekdays };
}

function parseDayOfWeek(raw: string): DayOfWeekMatcher {
  const upper = raw.toUpperCase();
  const ordinary: string[] = []; const lastWeekdays: number[] = []; const nthWeekdays: Array<{ weekday: number; nth: number }> = [];
  for (const item of upper.split(",")) {
    const last = item.match(/^([1-7]|SUN|MON|TUE|WED|THU|FRI|SAT)L$/);
    const nth = item.match(/^([1-7]|SUN|MON|TUE|WED|THU|FRI|SAT)#([1-5])$/);
    if (last) lastWeekdays.push(numeric(last[1], WEEKDAYS));
    else if (nth) nthWeekdays.push({ weekday: numeric(nth[1], WEEKDAYS), nth: Number(nth[2]) });
    else ordinary.push(item);
  }
  const base = parseField(ordinary.length ? ordinary.join(",") : upper === "?" || upper === "*" ? upper : "?", 1, 7, WEEKDAYS, true);
  return { values: ordinary.length || upper === "?" || upper === "*" ? base.values : new Set(), any: base.any && !lastWeekdays.length && !nthWeekdays.length, lastWeekdays, nthWeekdays };
}

export function parseScheduleExpression(value: unknown): ParsedScheduleExpression {
  const expression = String(value ?? "").trim();
  const at = expression.match(/^at\((\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)\)$/);
  if (at) {
    if (!Number.isFinite(Date.parse(`${at[1]}Z`))) validation("ScheduleExpression contains an invalid at() date.");
    return { kind: "at", local: at[1].length === 16 ? `${at[1]}:00` : at[1] };
  }
  const rate = expression.match(/^rate\(\s*(\d+)\s+(minute|minutes|hour|hours|day|days)\s*\)$/i);
  if (rate) {
    const amount = Number(rate[1]); const unit = rate[2].toLowerCase(); const singular = !unit.endsWith("s");
    if (!Number.isSafeInteger(amount) || amount < 1 || (amount === 1) !== singular) validation("ScheduleExpression contains invalid rate() grammar.");
    return { kind: "rate", intervalMs: amount * (unit.startsWith("minute") ? 60_000 : unit.startsWith("hour") ? 3_600_000 : 86_400_000) };
  }
  const cron = expression.match(/^cron\((.+)\)$/i);
  if (!cron) validation("ScheduleExpression must use at(...), rate(...), or cron(...).");
  const parts = cron[1].trim().split(/\s+/);
  if (parts.length !== 6) validation("A cron schedule expression must contain six fields.");
  const dayOfMonth = parseDayOfMonth(parts[2]); const dayOfWeek = parseDayOfWeek(parts[4]);
  if ((parts[2] === "?") === (parts[4] === "?")) validation("Exactly one of day-of-month or day-of-week must be ?.");
  return { kind: "cron", fields: {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth,
    month: parseField(parts[3], 1, 12, MONTHS),
    dayOfWeek,
    year: parseField(parts[5], 1970, 2199),
  } };
}

function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatterCache.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    formatterCache.set(timezone, value);
  }
  return value;
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }
function localParts(timestamp: number, timezone: string): LocalParts {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(timestamp).filter(item => item.type !== "literal").map(item => [item.type, item.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second), weekday: WEEKDAYS[String(parts.weekday).toUpperCase().slice(0, 3)] };
}
function localKey(parts: LocalParts): string { return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`; }
function daysInMonth(year: number, month: number): number { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function weekdayForDate(year: number, month: number, day: number): number { return new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 1; }
function nearestWeekday(year: number, month: number, requested: number): number {
  const day = Math.min(requested, daysInMonth(year, month)); const weekday = weekdayForDate(year, month, day);
  if (weekday === 7) return day === 1 ? 3 : day - 1;
  if (weekday === 1) return day === daysInMonth(year, month) ? day - 2 : day + 1;
  return day;
}

function cronMatches(fields: CronFields, parts: LocalParts): boolean {
  if (!fields.minute.values.has(parts.minute) || !fields.hour.values.has(parts.hour) || !fields.month.values.has(parts.month) || !fields.year.values.has(parts.year)) return false;
  const dom = fields.dayOfMonth;
  const domMatch = dom.any || dom.values.has(parts.day) || dom.last && parts.day === daysInMonth(parts.year, parts.month) || dom.lastWeekday && nearestWeekday(parts.year, parts.month, daysInMonth(parts.year, parts.month)) === parts.day || dom.nearestWeekdays.some(day => nearestWeekday(parts.year, parts.month, day) === parts.day);
  const dow = fields.dayOfWeek;
  const dowMatch = dow.any || dow.values.has(parts.weekday)
    || dow.lastWeekdays.some(day => day === parts.weekday && parts.day + 7 > daysInMonth(parts.year, parts.month))
    || dow.nthWeekdays.some(item => item.weekday === parts.weekday && Math.floor((parts.day - 1) / 7) + 1 === item.nth);
  return domMatch && dowMatch;
}

function localAtInstant(local: string, timezone: string): ScheduleOccurrence | undefined {
  const match = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/)!;
  const naive = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  for (let candidate = naive - 18 * 3_600_000; candidate <= naive + 18 * 3_600_000; candidate += 60_000) {
    const parts = localParts(candidate, timezone);
    if (localKey(parts) === local) return { at: candidate, localKey: local };
  }
  return undefined;
}

export function nextScheduleOccurrence(input: NextScheduleOccurrenceInput): ScheduleOccurrence | undefined {
  const parsed = parseScheduleExpression(input.expression); const timezone = validateScheduleTimezone(input.timezone); const earliest = Math.max(input.after + 1, input.startDate ?? Number.NEGATIVE_INFINITY);
  if (parsed.kind === "at") {
    const occurrence = localAtInstant(parsed.local, timezone);
    return occurrence && occurrence.at >= earliest && occurrence.at <= (input.endDate ?? Number.POSITIVE_INFINITY) ? occurrence : undefined;
  }
  if (parsed.kind === "rate") {
    const first = input.anchor + (input.rateFirstAtAnchor ? 0 : parsed.intervalMs);
    const minimum = Math.max(earliest, first);
    const steps = Math.max(0, Math.ceil((minimum - first) / parsed.intervalMs));
    const at = first + steps * parsed.intervalMs;
    if (at > (input.endDate ?? Number.POSITIVE_INFINITY)) return undefined;
    return { at, localKey: localKey(localParts(at, timezone)) };
  }
  let candidate = Math.ceil(earliest / 60_000) * 60_000;
  const limit = Math.min(input.endDate ?? Number.POSITIVE_INFINITY, candidate + 6 * 366 * 86_400_000);
  while (candidate <= limit) {
    const parts = localParts(candidate, timezone); const key = localKey(parts);
    if (cronMatches(parsed.fields, parts) && key !== input.lastLocalKey) return { at: candidate, localKey: key };
    candidate += 60_000;
  }
  return undefined;
}
