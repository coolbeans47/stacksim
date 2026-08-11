const CATEGORY_DETAILS = {
  oceans: { label: "Oceans", color: "#64d9ff", soft: "rgba(100,217,255,.14)" },
  space: { label: "Space", color: "#a899ff", soft: "rgba(168,153,255,.14)" },
  energy: { label: "Energy", color: "#d4fa79", soft: "rgba(212,250,121,.14)" },
  climate: { label: "Climate", color: "#7cf6c8", soft: "rgba(124,246,200,.14)" },
  robotics: { label: "Robotics", color: "#ff8e83", soft: "rgba(255,142,131,.14)" },
  civic: { label: "Civic", color: "#ffd782", soft: "rgba(255,215,130,.14)" },
};

const FALLBACK_DETAILS = [
  { color: "#7cf6c8", soft: "rgba(124,246,200,.14)" },
  { color: "#64d9ff", soft: "rgba(100,217,255,.14)" },
  { color: "#a899ff", soft: "rgba(168,153,255,.14)" },
  { color: "#ff8e83", soft: "rgba(255,142,131,.14)" },
  { color: "#ffd782", soft: "rgba(255,215,130,.14)" },
];

function hash(input) {
  let result = 2166136261;
  for (const character of String(input)) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function categoryDetails(category) {
  const key = String(category || "oceans").toLowerCase();
  const known = CATEGORY_DETAILS[key];
  if (known) return { key, ...known };
  const fallback = FALLBACK_DETAILS[hash(key) % FALLBACK_DETAILS.length];
  return {
    key,
    label: key.replace(/[-_]+/g, " ").replace(/\b\w/g, character => character.toUpperCase()),
    ...fallback,
  };
}

export function normalizeSignal(input, index = 0) {
  const id = String(input?.id ?? input?.signalId ?? `signal-${index + 1}`);
  const seed = hash(id);
  const candidateIntensity = Number(input?.intensity ?? input?.strength ?? 48);
  const candidateX = Number(input?.x ?? input?.coordinates?.x ?? 9 + (seed % 82));
  const candidateY = Number(input?.y ?? input?.coordinates?.y ?? 11 + ((seed >>> 8) % 76));
  const candidateContributors = Number(input?.contributors ?? 1);
  const intensity = clamp(Number.isFinite(candidateIntensity) ? candidateIntensity : 48, 1, 100);
  const x = clamp(Number.isFinite(candidateX) ? candidateX : 9 + (seed % 82), 6, 94);
  const y = clamp(Number.isFinite(candidateY) ? candidateY : 11 + ((seed >>> 8) % 76), 8, 92);
  return {
    id,
    title: String(input?.title ?? input?.name ?? `Signal ${index + 1}`),
    summary: String(input?.summary ?? input?.description ?? "A newly catalogued signal awaiting field notes."),
    category: String(input?.category ?? input?.type ?? "oceans").toLowerCase(),
    intensity,
    x,
    y,
    status: String(input?.status ?? "active").toLowerCase(),
    contributors: Math.max(0, Number.isFinite(candidateContributors) ? candidateContributors : 1),
    observedAt: input?.observedAt ?? input?.createdAt ?? input?.updatedAt ?? null,
  };
}

export function extractSignals(payload) {
  const candidates = Array.isArray(payload)
    ? payload
    : payload?.signals ?? payload?.items ?? payload?.data?.signals ?? payload?.data?.items ?? [];
  return Array.isArray(candidates) ? candidates.map(normalizeSignal) : [];
}

export function extractSignal(payload, fallback) {
  const candidate = payload?.signal ?? payload?.item ?? payload?.data?.signal ?? payload?.data?.item;
  return normalizeSignal(candidate ?? fallback);
}

function count(value, fallback = 0) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? Math.max(0, Math.round(candidate)) : fallback;
}

function normalizeJourneyStatus(value, processedAt) {
  const candidate = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["quarantined", "dead-lettered", "deadlettered", "dlq"].includes(candidate)) return "quarantined";
  if (["retrying", "retry", "failed", "processing-failed"].includes(candidate)) return "retrying";
  if (["processed", "complete", "completed", "succeeded", "success"].includes(candidate) || processedAt) return "processed";
  return candidate || "stored";
}

export function normalizeJourney(input, index = 0) {
  const occurredAt = input?.occurredAt ?? input?.createdAt ?? input?.storedAt ?? null;
  const processedAt = input?.processedAt ?? input?.completedAt ?? null;
  const eventId = String(input?.eventId ?? input?.id ?? `journey-${index + 1}`);
  const correlationId = String(input?.correlationId ?? input?.journeyId ?? eventId);
  return {
    eventId,
    signalId: String(input?.signalId ?? input?.signal?.id ?? "unknown-signal"),
    correlationId,
    action: String(input?.action ?? input?.type ?? "observed").trim().toLowerCase(),
    title: String(input?.title ?? input?.signalTitle ?? input?.signal?.title ?? "Untitled signal"),
    category: String(input?.category ?? input?.signal?.category ?? "oceans").trim().toLowerCase(),
    intensity: clamp(Number(input?.intensity ?? input?.signal?.intensity ?? 0) || 0, 0, 100),
    status: normalizeJourneyStatus(input?.status, processedAt),
    attempt: count(input?.attempt ?? input?.attempts, 1),
    occurredAt,
    processedAt,
  };
}

export function extractJourneys(payload) {
  const candidates = Array.isArray(payload)
    ? payload
    : payload?.journeys ?? payload?.items ?? payload?.data?.journeys ?? payload?.data?.items ?? [];
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map(normalizeJourney)
    .sort((left, right) => String(right.processedAt ?? right.occurredAt ?? "").localeCompare(String(left.processedAt ?? left.occurredAt ?? "")));
}

export function extractJourney(payload, fallback) {
  const candidate = payload?.journey
    ?? payload?.data?.journey
    ?? (payload?.correlationId || payload?.eventId ? payload : undefined);
  return (candidate || fallback) ? normalizeJourney(candidate ?? fallback) : null;
}

export function extractJourneyMeta(payload, journeys = []) {
  const source = payload?.meta ?? payload?.data?.meta ?? {};
  const queue = source?.queue ?? {};
  const statuses = journeys.reduce((summary, journey) => {
    if (journey.status === "processed") summary.processed += 1;
    if (journey.status === "retrying") summary.retrying += 1;
    if (journey.status === "quarantined") summary.quarantined += 1;
    return summary;
  }, { processed: 0, retrying: 0, quarantined: 0 });
  return {
    count: count(source.count, journeys.length),
    processed: count(source.processed, statuses.processed),
    retrying: count(source.retrying, statuses.retrying),
    quarantined: count(source.quarantined, statuses.quarantined),
    queue: {
      visible: count(queue.visible),
      inFlight: count(queue.inFlight),
      delayed: count(queue.delayed),
      deadLetters: count(queue.deadLetters),
    },
  };
}

export function formatObservationDate(value) {
  if (!value) return "Recently observed";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently observed";
  return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

export function formatJourneyTimestamp(value) {
  if (!value) return "Awaiting handoff";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Awaiting handoff";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
