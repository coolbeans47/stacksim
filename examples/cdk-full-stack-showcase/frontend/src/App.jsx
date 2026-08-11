import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  Archive,
  ArrowUpRight,
  Box,
  Check,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Database,
  FileText,
  Gauge,
  KeyRound,
  Layers3,
  LoaderCircle,
  Network,
  Orbit,
  Plus,
  Radio,
  RefreshCw,
  Rocket,
  Search,
  Server,
  ShieldCheck,
  Signal as SignalIcon,
  Sparkles,
  Telescope,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import { apiRequest, runtimeConfig } from "./api.js";
import {
  categoryDetails,
  extractJourney,
  extractJourneyMeta,
  extractJourneys,
  extractSignal,
  extractSignals,
  formatJourneyTimestamp,
  formatObservationDate,
} from "./signals.js";

const CATEGORY_OPTIONS = ["oceans", "space", "energy", "climate", "robotics", "civic"];

const SERVICE_PATH = [
  { id: "s3", label: "S3 website", detail: "React + Tailwind", icon: Cloud, accent: "mint" },
  { id: "apiGateway", label: "API Gateway", detail: "REST + validation", icon: Network, accent: "cyan" },
  { id: "lambda", label: "Lambda alias", detail: "Versioned compute", icon: Zap, accent: "gold" },
  { id: "iam", label: "IAM", detail: "Scoped execution", icon: KeyRound, accent: "mint" },
  { id: "dynamodb", label: "DynamoDB", detail: "Signals + stream", icon: Database, accent: "violet" },
  { id: "eventbridge", label: "EventBridge", detail: "Pattern + relay", icon: Activity, accent: "cyan" },
  { id: "sqs", label: "SQS", detail: "Queue + DLQ", icon: Box, accent: "gold" },
  { id: "logs", label: "CloudWatch Logs", detail: "Structured traces", icon: FileText, accent: "coral" },
];

const NAV_ITEMS = [
  { id: "atlas", label: "Live sky", icon: Orbit },
  { id: "signals", label: "Signals", icon: Radio },
  { id: "journeys", label: "Journeys", icon: Activity },
  { id: "topology", label: "Topology", icon: Network },
];

const JOURNEY_STEPS = [
  { id: "dynamodb", label: "DynamoDB", detail: "Stream", icon: Database },
  { id: "eventbridge", label: "EventBridge", detail: "Rule", icon: Activity },
  { id: "relay", label: "Relay", detail: "Lambda", icon: Zap },
  { id: "sqs", label: "SQS", detail: "Queue", icon: Box },
  { id: "worker", label: "Worker", detail: "Lambda", icon: CheckCircle2 },
];

const EMPTY_JOURNEY_META = Object.freeze({
  count: 0,
  processed: 0,
  retrying: 0,
  quarantined: 0,
  queue: Object.freeze({ visible: 0, inFlight: 0, delayed: 0, deadLetters: 0 }),
});

function cx(...values) {
  return values.filter(Boolean).join(" ");
}

function statusLabel({ loading, error }) {
  if (loading) return { label: "Acquiring", className: "is-checking" };
  if (error) return { label: "Signal lost", className: "is-error" };
  return { label: "Stack live", className: "is-live" };
}

function Sidebar({ connection, onCreate }) {
  return (
    <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col border-r border-white/[0.07] bg-night-950/75 px-5 py-6 backdrop-blur-2xl lg:flex">
      <a href="#atlas" className="group flex items-center gap-3 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-aurora-mint">
        <span className="brand-mark" aria-hidden="true"><Orbit size={21} strokeWidth={1.7} /></span>
        <span>
          <span className="block text-[15px] font-semibold tracking-[-0.02em] text-white">Aurora Atlas</span>
          <span className="block text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Local observatory</span>
        </span>
      </a>

      <nav className="mt-11 space-y-1" aria-label="Observatory sections">
        {NAV_ITEMS.map(({ id, label, icon: Icon }, index) => (
          <a key={id} href={`#${id}`} className={cx("side-link", index === 0 && "is-active")}>
            <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
            <span>{label}</span>
            {index === 0 && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-aurora-mint shadow-mint" aria-hidden="true" />}
          </a>
        ))}
      </nav>

      <div className="mt-8 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">Deployment</span>
          <span className={cx("connection-dot", connection.className)} aria-hidden="true" />
        </div>
        <p className="mt-3 text-sm font-semibold text-slate-200">{connection.label}</p>
        <p className="mt-1 font-mono text-[10px] leading-5 text-slate-500">eu-west-1 · stacksim</p>
      </div>

      <button type="button" onClick={onCreate} className="primary-button mt-5 w-full">
        <Plus size={16} aria-hidden="true" />
        Log a signal
      </button>

      <div className="mt-auto pt-7">
        <div className="flex items-center gap-3 border-t border-white/[0.07] pt-5">
          <span className="grid h-9 w-9 place-items-center rounded-xl border border-aurora-violet/20 bg-aurora-violet/10 text-aurora-violet">
            <Layers3 size={17} aria-hidden="true" />
          </span>
          <span>
            <span className="block text-xs font-semibold text-slate-300">CDK showcase</span>
            <span className="block text-[10px] text-slate-600">CloudFormation managed</span>
          </span>
        </div>
      </div>
    </aside>
  );
}

function MobileHeader({ connection, onCreate }) {
  return (
    <header className="sticky top-0 z-40 flex items-center justify-between border-b border-white/[0.07] bg-night-950/80 px-4 py-3 backdrop-blur-2xl lg:hidden">
      <a href="#atlas" className="flex items-center gap-2.5 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-aurora-mint">
        <span className="brand-mark brand-mark-small" aria-hidden="true"><Orbit size={18} /></span>
        <span className="text-sm font-semibold text-white">Aurora Atlas</span>
      </a>
      <div className="flex items-center gap-2">
        <span className={cx("connection-pill", connection.className)}>
          <span className="connection-dot" aria-hidden="true" />
          <span className="sr-only">Connection:</span> {connection.label}
        </span>
        <button type="button" onClick={onCreate} className="icon-button" aria-label="Log a new signal">
          <Plus size={18} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

function MobileNavigation() {
  return (
    <nav className="mobile-navigation lg:hidden" aria-label="Mobile observatory sections">
      {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
        <a key={id} href={`#${id}`}>
          <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
          <span>{label}</span>
        </a>
      ))}
    </nav>
  );
}

function StatCard({ icon: Icon, label, value, note, tone = "mint" }) {
  return (
    <div className="stat-card">
      <div className={cx("stat-icon", `tone-${tone}`)}><Icon size={17} strokeWidth={1.8} aria-hidden="true" /></div>
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-slate-500">{label}</p>
        <div className="mt-1 flex items-baseline gap-2">
          <p className="text-2xl font-semibold tracking-[-0.04em] text-white">{value}</p>
          {note && <span className="text-[10px] text-slate-600">{note}</span>}
        </div>
      </div>
    </div>
  );
}

function useElementSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => {
      const rectangle = element.getBoundingClientRect();
      setSize({ width: rectangle.width, height: rectangle.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function constellationConnections(signals) {
  const connections = [];
  for (let index = 1; index < signals.length; index += 1) {
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let previous = 0; previous < index; previous += 1) {
      const dx = signals[index].x - signals[previous].x;
      const dy = signals[index].y - signals[previous].y;
      const distance = (dx * dx) + (dy * dy);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = previous;
      }
    }
    connections.push([signals[closestIndex], signals[index]]);
  }
  return connections;
}

function Constellation({ signals, selectedId, onSelect }) {
  const canvasRef = useRef(null);
  const size = useElementSize(canvasRef);
  const connections = useMemo(() => constellationConnections(signals), [signals]);

  return (
    <div ref={canvasRef} className="constellation-canvas" aria-label={`${signals.length} visible signals in the Aurora Atlas`}>
      <div className="atlas-orbit atlas-orbit-one" aria-hidden="true" />
      <div className="atlas-orbit atlas-orbit-two" aria-hidden="true" />
      <div className="atlas-grid" aria-hidden="true" />
      <div className="atlas-sweep" aria-hidden="true" />

      {size.width > 0 && connections.map(([from, to]) => {
        const x1 = (from.x / 100) * size.width;
        const y1 = (from.y / 100) * size.height;
        const x2 = (to.x / 100) * size.width;
        const y2 = (to.y / 100) * size.height;
        const dx = x2 - x1;
        const dy = y2 - y1;
        return (
          <span
            key={`${from.id}-${to.id}`}
            className={cx("atlas-connector", (selectedId === from.id || selectedId === to.id) && "is-highlighted")}
            style={{
              left: x1,
              top: y1,
              width: Math.hypot(dx, dy),
              transform: `rotate(${Math.atan2(dy, dx)}rad)`,
            }}
            aria-hidden="true"
          />
        );
      })}

      {signals.map((signal, index) => {
        const details = categoryDetails(signal.category);
        const selected = selectedId === signal.id;
        return (
          <button
            key={signal.id}
            type="button"
            className={cx("atlas-node", selected && "is-selected", index % 4 === 0 && "is-radiant")}
            style={{
              left: `${signal.x}%`,
              top: `${signal.y}%`,
              "--node-size": `${10 + Math.round(signal.intensity / 9)}px`,
              "--signal-color": details.color,
              "--signal-soft": details.soft,
            }}
            aria-label={`${signal.title}, ${details.label}, intensity ${Math.round(signal.intensity)} percent`}
            aria-pressed={selected}
            onClick={() => onSelect(signal.id)}
          >
            <span className="atlas-node-halo" aria-hidden="true" />
            <span className="atlas-node-core" aria-hidden="true" />
            <span className={cx("atlas-node-label", selected && "is-visible")} aria-hidden="true">
              {signal.title}
            </span>
          </button>
        );
      })}

      <div className="constellation-legend" aria-hidden="true">
        <span className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-aurora-mint" />LIVE FIELD</span>
        <span>{signals.length.toString().padStart(2, "0")} OBJECTS</span>
      </div>
    </div>
  );
}

function LoadingAtlas() {
  return (
    <div className="constellation-canvas overflow-hidden" role="status" aria-label="Acquiring signals">
      <div className="atlas-grid opacity-50" aria-hidden="true" />
      {["12% 22%", "72% 18%", "38% 48%", "83% 68%", "22% 76%"].map((position, index) => {
        const [left, top] = position.split(" ");
        return <span key={position} className="loading-star" style={{ left, top, animationDelay: `${index * 180}ms` }} aria-hidden="true" />;
      })}
      <span className="absolute inset-x-0 top-1/2 text-center text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
        Acquiring local sky
      </span>
    </div>
  );
}

function SignalDetails({ signal, busy, onBoost, onArchive }) {
  if (!signal) {
    return (
      <aside className="glass-panel flex min-h-[310px] items-center justify-center p-7 text-center xl:min-h-full">
        <div>
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/[0.035] text-slate-500">
            <Telescope size={21} aria-hidden="true" />
          </span>
          <p className="mt-4 text-sm font-semibold text-slate-300">Select a signal</p>
          <p className="mt-1 text-xs leading-5 text-slate-600">Choose a light in the atlas to inspect its field notes.</p>
        </div>
      </aside>
    );
  }

  const details = categoryDetails(signal.category);
  return (
    <aside className="glass-panel detail-panel p-5 sm:p-6" aria-label={`Selected signal: ${signal.title}`}>
      <div className="flex items-start justify-between gap-4">
        <span className="category-pill" style={{ "--category-color": details.color, "--category-soft": details.soft }}>
          <Sparkles size={12} aria-hidden="true" /> {details.label}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-slate-600">#{signal.id.slice(0, 8)}</span>
      </div>

      <div className="mt-7">
        <p className="text-[10px] font-bold uppercase tracking-[0.19em] text-slate-500">Selected object</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-white">{signal.title}</h2>
        <p className="mt-3 text-sm leading-6 text-slate-400">{signal.summary}</p>
      </div>

      <div className="mt-7 rounded-2xl border border-white/[0.07] bg-black/10 p-4">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Signal intensity</p>
            <p className="mt-1 text-3xl font-semibold tracking-[-0.05em] text-white">{Math.round(signal.intensity)}<span className="ml-1 text-sm text-slate-600">%</span></p>
          </div>
          <Gauge size={26} strokeWidth={1.35} style={{ color: details.color }} aria-hidden="true" />
        </div>
        <div className="intensity-track mt-4" aria-hidden="true">
          <span style={{ width: `${signal.intensity}%`, background: details.color }} />
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-3 gap-2.5">
        <div className="detail-stat">
          <dt>Observed</dt>
          <dd>{formatObservationDate(signal.observedAt)}</dd>
        </div>
        <div className="detail-stat">
          <dt>State</dt>
          <dd className="capitalize"><span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-aurora-mint" />{signal.status}</dd>
        </div>
        <div className="detail-stat">
          <dt>Contributors</dt>
          <dd>{Math.round(signal.contributors).toLocaleString("en")}</dd>
        </div>
      </dl>

      <div className="mt-7 grid grid-cols-2 gap-2.5">
        <button type="button" className="secondary-button" onClick={onBoost} disabled={Boolean(busy)}>
          {busy === "boost" ? <LoaderCircle className="animate-spin" size={15} /> : <Zap size={15} />}
          Boost
        </button>
        <button type="button" className="secondary-button danger-button" onClick={onArchive} disabled={Boolean(busy)}>
          {busy === "archive" ? <LoaderCircle className="animate-spin" size={15} /> : <Archive size={15} />}
          Archive
        </button>
      </div>
    </aside>
  );
}

function ErrorAtlas({ message, onRetry }) {
  return (
    <div className="constellation-canvas grid place-items-center p-8 text-center">
      <div className="max-w-sm">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-aurora-coral/20 bg-aurora-coral/10 text-aurora-coral">
          <TriangleAlert size={23} aria-hidden="true" />
        </span>
        <h2 className="mt-5 text-xl font-semibold tracking-[-0.03em] text-white">The sky went quiet</h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">{message}</p>
        <button type="button" className="secondary-button mx-auto mt-5" onClick={onRetry}>
          <RefreshCw size={15} aria-hidden="true" /> Retry acquisition
        </button>
      </div>
    </div>
  );
}

function EmptyAtlas({ onCreate, onReset }) {
  return (
    <div className="constellation-canvas grid place-items-center p-8 text-center">
      <div className="max-w-sm">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-aurora-violet/20 bg-aurora-violet/10 text-aurora-violet">
          <Telescope size={23} aria-hidden="true" />
        </span>
        <h2 className="mt-5 text-xl font-semibold tracking-[-0.03em] text-white">A pristine local sky</h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">Log the first signal, or restore the curated demonstration constellation.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button type="button" className="primary-button" onClick={onCreate}><Plus size={15} /> Log first signal</button>
          <button type="button" className="secondary-button" onClick={onReset}><RefreshCw size={15} /> Restore demo</button>
        </div>
      </div>
    </div>
  );
}

function SignalCard({ signal, selected, onSelect }) {
  const details = categoryDetails(signal.category);
  return (
    <button
      type="button"
      onClick={() => onSelect(signal.id)}
      className={cx("signal-card group", selected && "is-selected")}
      aria-pressed={selected}
    >
      <div className="flex items-start justify-between gap-4">
        <span className="signal-card-star" style={{ "--signal-color": details.color, "--signal-soft": details.soft }} aria-hidden="true">
          <span />
        </span>
        <ArrowUpRight className="text-slate-700 transition-colors group-hover:text-slate-400" size={16} aria-hidden="true" />
      </div>
      <p className="mt-5 text-left text-sm font-semibold text-slate-100">{signal.title}</p>
      <p className="mt-1 line-clamp-2 text-left text-xs leading-5 text-slate-500">{signal.summary}</p>
      <div className="mt-5 flex items-center justify-between border-t border-white/[0.06] pt-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.13em]" style={{ color: details.color }}>{details.label}</span>
        <span className="font-mono text-[10px] text-slate-600">{Math.round(signal.intensity)}%</span>
      </div>
    </button>
  );
}

function journeyState(status) {
  if (status === "processed") {
    return { label: "Processed", className: "is-processed", progress: JOURNEY_STEPS.length };
  }
  if (status === "retrying") {
    return { label: "Retrying", className: "is-retrying", progress: JOURNEY_STEPS.length - 1 };
  }
  if (status === "quarantined") {
    return { label: "Quarantined", className: "is-quarantined", progress: JOURNEY_STEPS.length - 1 };
  }
  if (["processing", "working"].includes(status)) {
    return { label: "Processing", className: "is-processing", progress: JOURNEY_STEPS.length - 1 };
  }
  if (["queued", "enqueued"].includes(status)) {
    return { label: "Queued", className: "is-queued", progress: 4 };
  }
  if (["relayed", "matched", "routed"].includes(status)) {
    return { label: status === "matched" ? "Rule matched" : "Relayed", className: "is-relayed", progress: 3 };
  }
  if (["published", "event-published"].includes(status)) {
    return { label: "Published", className: "is-published", progress: 2 };
  }
  return { label: "Stored", className: "is-stored", progress: 1 };
}

function titleCase(value) {
  return String(value || "observed")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, character => character.toUpperCase());
}

function JourneyStatus({ journey }) {
  const state = journeyState(journey.status);
  return (
    <span className={cx("journey-status", state.className)}>
      {journey.status === "retrying"
        ? <RefreshCw className="animate-spin" size={11} aria-hidden="true" />
        : journey.status === "quarantined"
          ? <TriangleAlert size={11} aria-hidden="true" />
          : journey.status === "processed"
            ? <CheckCircle2 size={11} aria-hidden="true" />
            : <Activity size={11} aria-hidden="true" />}
      {state.label}
    </span>
  );
}

function JourneyFlow({ journey }) {
  const state = journeyState(journey.status);
  return (
    <ol className="journey-flow" aria-label={`Signal path: ${JOURNEY_STEPS.map(step => step.label).join(" to ")}`}>
      {JOURNEY_STEPS.map(({ id, label, detail, icon: Icon }, index) => {
        const complete = journey.status === "processed" || index < state.progress;
        const active = journey.status !== "processed" && journey.status !== "quarantined" && index === state.progress;
        const failed = journey.status === "quarantined" && index === JOURNEY_STEPS.length - 1;
        return (
          <li key={id} className={cx("journey-step", complete && "is-complete", active && "is-active", failed && "is-failed")}>
            <span className="journey-step-marker" aria-hidden="true">
              {complete && !failed ? <Check size={11} /> : <Icon size={12} />}
            </span>
            <strong>{label}</strong>
            <small>{failed ? "DLQ" : detail}</small>
          </li>
        );
      })}
    </ol>
  );
}

function JourneyRow({ journey }) {
  const details = categoryDetails(journey.category);
  return (
    <article className={cx("journey-row", `journey-${journey.status}`)}>
      <div className="journey-row-heading">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="category-pill" style={{ "--category-color": details.color, "--category-soft": details.soft }}>
              <Sparkles size={10} aria-hidden="true" /> {details.label}
            </span>
            <span className="journey-action">{titleCase(journey.action)}</span>
          </div>
          <h3 className="mt-3 truncate text-sm font-semibold text-slate-100">{journey.title}</h3>
          <p className="mt-1 truncate font-mono text-[9px] text-slate-600" title={journey.correlationId}>
            correlation/{journey.correlationId}
          </p>
        </div>
        <div className="journey-row-state">
          <JourneyStatus journey={journey} />
          <span>{formatJourneyTimestamp(journey.processedAt ?? journey.occurredAt)}</span>
        </div>
      </div>

      <JourneyFlow journey={journey} />

      <div className="journey-row-footer">
        <span><SignalIcon size={11} aria-hidden="true" /> {Math.round(journey.intensity)}% intensity</span>
        <span><RefreshCw size={11} aria-hidden="true" /> attempt {Math.max(1, journey.attempt)}</span>
        <span className="min-w-0 truncate font-mono" title={journey.eventId}>event/{journey.eventId}</span>
        {journey.status === "quarantined" && (
          <span className="journey-dlq-note"><TriangleAlert size={11} aria-hidden="true" /> isolated in the dead-letter queue</span>
        )}
      </div>
    </article>
  );
}

function JourneySection({
  journeys,
  meta,
  loading,
  error,
  faultRunning,
  onRefresh,
  onFault,
}) {
  const queueStats = [
    { label: "Ready", value: meta.queue.visible, note: "visible", icon: Box, tone: "mint" },
    { label: "In flight", value: meta.queue.inFlight, note: "leased", icon: Activity, tone: "cyan" },
    { label: "Delayed", value: meta.queue.delayed, note: "waiting", icon: Gauge, tone: "violet" },
    { label: "Dead letters", value: meta.queue.deadLetters, note: "isolated", icon: TriangleAlert, tone: "coral" },
  ];

  return (
    <section id="journeys" className="scroll-mt-24 pt-16 lg:scroll-mt-8 lg:pt-20">
      <div className="flex flex-col justify-between gap-5 xl:flex-row xl:items-end">
        <div className="max-w-2xl">
          <p className="eyebrow"><Activity size={13} aria-hidden="true" /> Signal journey</p>
          <h2 className="section-title">Watch every handoff.</h2>
          <p className="section-copy">
            DynamoDB Streams publish each change to EventBridge. A Lambda relay places the matched event on SQS, where a worker processes it or SQS quarantines it after bounded retries.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="secondary-button" onClick={onRefresh} disabled={loading || faultRunning}>
            <RefreshCw className={loading ? "animate-spin" : ""} size={15} aria-hidden="true" />
            Refresh path
          </button>
          <button type="button" className="secondary-button journey-fault-button" onClick={onFault} disabled={faultRunning}>
            {faultRunning ? <LoaderCircle className="animate-spin" size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}
            {faultRunning ? "Following retries" : "Inject relay fault"}
          </button>
        </div>
      </div>

      <div className="journey-summary" aria-label="Journey status summary">
        <span><strong>{meta.count}</strong> total journeys</span>
        <span className="is-processed"><strong>{meta.processed}</strong> processed</span>
        <span className="is-retrying"><strong>{meta.retrying}</strong> retrying</span>
        <span className="is-quarantined"><strong>{meta.quarantined}</strong> quarantined</span>
        <span className="journey-poll-note"><span className="connection-dot is-live" aria-hidden="true" /> polling live</span>
      </div>

      <div className="journey-queue-grid">
        {queueStats.map(({ label, value, note, icon: Icon, tone }) => (
          <div key={label} className="journey-queue-stat">
            <span className={cx("stat-icon", `tone-${tone}`)}><Icon size={15} aria-hidden="true" /></span>
            <span><small>{label}</small><strong>{value}</strong></span>
            <em>{note}</em>
          </div>
        ))}
      </div>

      <div className="glass-panel journey-panel" aria-busy={loading}>
        <div className="journey-panel-header">
          <div>
            <p className="text-sm font-semibold text-slate-200">Recent paths</p>
            <p className="mt-0.5 text-[10px] text-slate-600">12 newest · automatically refreshed from the journey projection</p>
          </div>
          <span className="hidden font-mono text-[9px] uppercase tracking-[0.14em] text-slate-600 sm:inline">Event bus → queue</span>
        </div>

        {error && (
          <div className="journey-notice is-error" role="status">
            <TriangleAlert size={15} aria-hidden="true" />
            <span><strong>Journey telemetry interrupted</strong><small>{error}</small></span>
            <button type="button" className="text-button ml-auto" onClick={onRefresh}>Retry</button>
          </div>
        )}

        {loading && journeys.length === 0 ? (
          <div className="journey-loading" role="status">
            <LoaderCircle className="animate-spin" size={20} aria-hidden="true" />
            <span>Following the asynchronous path…</span>
          </div>
        ) : journeys.length === 0 ? (
          <div className="journey-empty">
            <span><Activity size={20} aria-hidden="true" /></span>
            <h3>No journeys yet</h3>
            <p>Create, boost, or archive a signal to send it through the event fabric, or inject a safe relay fault to watch SQS redrive it.</p>
          </div>
        ) : (
          <div className="journey-list">
            {journeys.slice(0, 12).map(journey => <JourneyRow key={`${journey.correlationId}-${journey.eventId}`} journey={journey} />)}
          </div>
        )}
      </div>
    </section>
  );
}

function ServiceTopology({ proof, proofRunning, proofError, onProof }) {
  const verified = Boolean(proof);
  const latency = proof?._latencyMs;
  const release = proof?.release ?? proof?.version ?? proof?.functionVersion ?? proof?.data?.release;
  const providerTypes = proof?.cloudFormation?.providerTypes;
  return (
    <section id="topology" className="scroll-mt-24 pt-16 lg:scroll-mt-8 lg:pt-20">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="eyebrow"><Network size={13} aria-hidden="true" /> Service topology</p>
          <h2 className="section-title">One signal. The whole local cloud.</h2>
          <p className="section-copy">Run a protected flight check across the synchronous request path, then follow real mutations through the deployed EventBridge and SQS fabric above.</p>
        </div>
        <button type="button" className="primary-button shrink-0" onClick={onProof} disabled={proofRunning}>
          {proofRunning ? <LoaderCircle className="animate-spin" size={16} /> : verified ? <RefreshCw size={16} /> : <Rocket size={16} />}
          {proofRunning ? "Verifying path" : verified ? "Run again" : "Run flight check"}
        </button>
      </div>

      <div className="glass-panel mt-7 overflow-hidden p-4 sm:p-6">
        <div className="service-path">
          {SERVICE_PATH.map(({ id, label, detail, icon: Icon, accent }, index) => (
            <React.Fragment key={id}>
              <div className={cx("service-node", verified && "is-verified")}>
                <div className={cx("service-node-icon", `tone-${accent}`)}><Icon size={19} strokeWidth={1.7} aria-hidden="true" /></div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-slate-200">{label}</p>
                  <p className="mt-0.5 truncate text-[10px] text-slate-600">{detail}</p>
                </div>
                <span className="service-status" title={verified ? "Verified" : "Awaiting flight check"}>
                  {verified ? <Check size={11} aria-hidden="true" /> : <span aria-hidden="true" />}
                  <span className="sr-only">{verified ? "Verified" : "Not yet verified"}</span>
                </span>
              </div>
              {index < SERVICE_PATH.length - 1 && <ChevronRight className="service-arrow" size={16} aria-hidden="true" />}
            </React.Fragment>
          ))}
        </div>

        <div className={cx("proof-result", verified && "is-success", proofError && "is-error")} role="status" aria-live="polite">
          <div className="flex items-center gap-3">
            <span className="proof-result-icon">
              {proofRunning ? <LoaderCircle className="animate-spin" size={17} /> : verified ? <CheckCircle2 size={17} /> : proofError ? <TriangleAlert size={17} /> : <ShieldCheck size={17} />}
            </span>
            <div>
              <p className="text-xs font-semibold text-slate-200">
                {proofRunning ? "Following the service path…" : verified ? "Full-stack path verified" : proofError ? "Flight check interrupted" : "Protected route ready"}
              </p>
              <p className="mt-0.5 text-[10px] text-slate-600">
                {proofError || (verified
                  ? `${release ? `Release ${release} · ` : ""}${latency ? `${latency} ms · ` : ""}${providerTypes ? `${providerTypes} CFN providers · ` : ""}authorizer and API key accepted`
                  : "Credentials are compiled as demonstration values and never grant control-plane access.")}
              </p>
            </div>
          </div>
          {verified && <span className="hidden font-mono text-[9px] uppercase tracking-[0.15em] text-aurora-mint sm:inline">Verified</span>}
        </div>
      </div>

      <div className="mt-4">
        <div className="future-card sm:max-w-sm">
          <Server size={16} aria-hidden="true" />
          <span><strong>RDS analytics</strong><small>Future historical projection</small></span>
          <span className="ml-auto rounded-full border border-white/[0.08] px-2 py-1 text-[8px] font-bold uppercase tracking-[0.12em] text-slate-600">Runway</span>
        </div>
      </div>
    </section>
  );
}

function CreateSignalDialog({ open, busy, onClose, onSubmit }) {
  const [form, setForm] = useState({ title: "", summary: "", category: "oceans", intensity: 62 });

  useEffect(() => {
    if (!open) setForm({ title: "", summary: "", category: "oceans", intensity: 62 });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = event => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, busy, onClose]);

  if (!open) return null;
  const update = event => setForm(current => ({ ...current, [event.target.name]: event.target.value }));
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
      <div className="dialog-panel" role="dialog" aria-modal="true" aria-labelledby="create-signal-title">
        <div className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-5 sm:px-7">
          <div>
            <p className="eyebrow"><Sparkles size={12} /> New observation</p>
            <h2 id="create-signal-title" className="mt-2 text-xl font-semibold tracking-[-0.03em] text-white">Log a signal</h2>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="icon-button" aria-label="Close dialog"><X size={18} /></button>
        </div>
        <form
          className="space-y-5 px-5 py-6 sm:px-7"
          onSubmit={event => {
            event.preventDefault();
            onSubmit({ ...form, intensity: Number(form.intensity) });
          }}
        >
          <label className="field-label">
            <span>Signal name</span>
            <input autoFocus required minLength={3} maxLength={72} name="title" value={form.title} onChange={update} placeholder="e.g. Helix dawn" />
          </label>
          <label className="field-label">
            <span>Field note</span>
            <textarea required minLength={8} maxLength={280} name="summary" value={form.summary} onChange={update} placeholder="What makes this observation worth tracking?" rows={3} />
          </label>
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="field-label">
              <span>Classification</span>
              <select name="category" value={form.category} onChange={update}>
                {CATEGORY_OPTIONS.map(category => <option key={category} value={category}>{categoryDetails(category).label}</option>)}
              </select>
            </label>
            <label className="field-label">
              <span className="flex items-center justify-between"><span>Intensity</span><output>{form.intensity}%</output></span>
              <input className="range-input" type="range" min="10" max="100" step="1" name="intensity" value={form.intensity} onChange={update} />
            </label>
          </div>
          <div className="flex flex-col-reverse gap-2 border-t border-white/[0.07] pt-5 sm:flex-row sm:justify-end">
            <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy || !form.title.trim() || !form.summary.trim()}>
              {busy ? <LoaderCircle className="animate-spin" size={16} /> : <Plus size={16} />}
              {busy ? "Transmitting" : "Add to atlas"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ToastRegion({ toasts, onDismiss }) {
  return (
    <div className="toast-region" aria-live="polite" aria-atomic="false">
      {toasts.map(toast => (
        <div key={toast.id} className={cx("toast", `toast-${toast.type}`)} role="status">
          <span className="toast-icon">
            {toast.type === "error" ? <TriangleAlert size={16} /> : <CheckCircle2 size={16} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-slate-200">{toast.title}</p>
            {toast.message && <p className="mt-0.5 text-[10px] leading-4 text-slate-500">{toast.message}</p>}
          </div>
          <button type="button" onClick={() => onDismiss(toast.id)} aria-label="Dismiss notification"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [signals, setSignals] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [proof, setProof] = useState(null);
  const [proofError, setProofError] = useState("");
  const [journeys, setJourneys] = useState([]);
  const [journeyMeta, setJourneyMeta] = useState(EMPTY_JOURNEY_META);
  const [journeyLoading, setJourneyLoading] = useState(true);
  const [journeyError, setJourneyError] = useState("");
  const [toasts, setToasts] = useState([]);
  const toastSequence = useRef(0);

  const notify = useCallback((type, title, message = "") => {
    toastSequence.current += 1;
    const id = toastSequence.current;
    setToasts(current => [...current.slice(-2), { id, type, title, message }]);
    window.setTimeout(() => setToasts(current => current.filter(toast => toast.id !== id)), 4600);
  }, []);

  const loadSignals = useCallback(async ({ quiet = false, signal } = {}) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const payload = await apiRequest("/signals", { signal });
      const received = extractSignals(payload);
      setSignals(received);
      setSelectedId(current => received.some(item => item.id === current) ? current : (received[0]?.id ?? null));
      return received;
    } catch (requestError) {
      if (requestError?.name === "AbortError") return [];
      setError(requestError.message || "Unable to acquire signals.");
      return [];
    } finally {
      if (!quiet && !signal?.aborted) setLoading(false);
    }
  }, []);

  const loadJourneys = useCallback(async ({ quiet = false, signal } = {}) => {
    if (!quiet) setJourneyLoading(true);
    try {
      const payload = await apiRequest("/journeys", { signal });
      const received = extractJourneys(payload);
      setJourneys(received);
      setJourneyMeta(extractJourneyMeta(payload, received));
      setJourneyError("");
      return received;
    } catch (requestError) {
      if (requestError?.name === "AbortError") return [];
      setJourneyError(requestError.message || "Unable to follow signal journeys.");
      return [];
    } finally {
      if (!quiet && !signal?.aborted) setJourneyLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadSignals({ signal: controller.signal });
    return () => controller.abort();
  }, [loadSignals]);

  useEffect(() => {
    const controller = new AbortController();
    loadJourneys({ signal: controller.signal });
    const interval = window.setInterval(() => {
      if (!document.hidden) loadJourneys({ quiet: true });
    }, 2_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [loadJourneys]);

  const categories = useMemo(() => {
    const unique = [...new Set(signals.map(signal => signal.category))];
    return unique.sort((left, right) => categoryDetails(left).label.localeCompare(categoryDetails(right).label));
  }, [signals]);

  const visibleSignals = useMemo(() => {
    const term = query.trim().toLowerCase();
    return signals.filter(signal => {
      const categoryMatch = filter === "all" || signal.category === filter;
      const termMatch = !term || `${signal.title} ${signal.summary} ${signal.category}`.toLowerCase().includes(term);
      return categoryMatch && termMatch;
    });
  }, [signals, filter, query]);

  useEffect(() => {
    if (!loading && !visibleSignals.some(signal => signal.id === selectedId)) {
      setSelectedId(visibleSignals[0]?.id ?? null);
    }
  }, [loading, selectedId, visibleSignals]);

  const selectedSignal = signals.find(signal => signal.id === selectedId) ?? null;
  const averageIntensity = signals.length
    ? Math.round(signals.reduce((total, signal) => total + signal.intensity, 0) / signals.length)
    : 0;
  const connection = statusLabel({ loading, error });

  const replaceSignal = useCallback(updated => {
    setSignals(current => current.map(signal => signal.id === updated.id ? updated : signal));
  }, []);

  const surfaceJourney = useCallback(payload => {
    const journey = extractJourney(payload);
    if (!journey) return null;
    setJourneys(current => [
      journey,
      ...current.filter(item => item.correlationId !== journey.correlationId && item.eventId !== journey.eventId),
    ]);
    return journey;
  }, []);

  const handleCreate = async form => {
    setBusy("create");
    try {
      const payload = await apiRequest("/signals", { method: "POST", body: form, protectedCall: true });
      const candidate = payload?.signal ?? payload?.item ?? payload?.data?.signal ?? payload?.data?.item;
      if (candidate) {
        const created = extractSignal(payload, form);
        setSignals(current => [created, ...current.filter(signal => signal.id !== created.id)]);
        setSelectedId(created.id);
      } else {
        const received = await loadSignals({ quiet: true });
        setSelectedId(received[0]?.id ?? null);
      }
      surfaceJourney(payload);
      setCreateOpen(false);
      notify("success", "Signal entered the atlas", "Stored in DynamoDB; its asynchronous journey is now in motion.");
    } catch (requestError) {
      notify("error", "Signal transmission failed", requestError.message);
    } finally {
      setBusy("");
    }
  };

  const handleBoost = async () => {
    if (!selectedSignal) return;
    setBusy("boost");
    try {
      const payload = await apiRequest(`/signals/${encodeURIComponent(selectedSignal.id)}`, {
        method: "PUT",
        body: { action: "boost" },
        protectedCall: true,
      });
      const updated = extractSignal(payload, { ...selectedSignal, intensity: Math.min(100, selectedSignal.intensity + 8) });
      replaceSignal(updated);
      surfaceJourney(payload);
      notify("success", "Signal amplified", `${updated.title} is at ${Math.round(updated.intensity)}%; follow its new journey below.`);
    } catch (requestError) {
      notify("error", "Boost failed", requestError.message);
    } finally {
      setBusy("");
    }
  };

  const handleArchive = async () => {
    if (!selectedSignal) return;
    setBusy("archive");
    try {
      const payload = await apiRequest(`/signals/${encodeURIComponent(selectedSignal.id)}`, { method: "DELETE", protectedCall: true });
      const remaining = signals.filter(signal => signal.id !== selectedSignal.id);
      setSignals(remaining);
      setSelectedId(remaining[0]?.id ?? null);
      surfaceJourney(payload);
      notify("success", "Signal archive started", `${selectedSignal.title} has left the live sky while its event completes the queue path.`);
    } catch (requestError) {
      notify("error", "Archive failed", requestError.message);
    } finally {
      setBusy("");
    }
  };

  const handleReset = async () => {
    setBusy("reset");
    try {
      const payload = await apiRequest("/demo/seed", { method: "POST", body: { reset: true }, protectedCall: true });
      const seeded = extractSignals(payload);
      if (seeded.length) {
        setSignals(seeded);
        setSelectedId(seeded[0].id);
      } else {
        await loadSignals({ quiet: true });
      }
      await loadJourneys({ quiet: true });
      setFilter("all");
      setQuery("");
      notify("success", "Demo sky restored", "The deterministic seed constellation is ready to explore.");
    } catch (requestError) {
      notify("error", "Reset failed", requestError.message);
    } finally {
      setBusy("");
    }
  };

  const handleProof = async () => {
    setBusy("proof");
    setProofError("");
    const started = performance.now();
    try {
      const payload = await apiRequest("/system/proof", { protectedCall: true });
      const result = { ...payload, _latencyMs: Math.max(1, Math.round(performance.now() - started)) };
      setProof(result);
      notify("success", "Flight check complete", "Every deployed service in the request path responded.");
    } catch (requestError) {
      setProof(null);
      setProofError(requestError.message);
      notify("error", "Flight check interrupted", requestError.message);
    } finally {
      setBusy("");
    }
  };

  const handleFault = async () => {
    const previous = new Set(journeys.map(journey => `${journey.correlationId}:${journey.eventId}`));
    setBusy("fault");
    try {
      const payload = await apiRequest("/journeys/fault", {
        method: "POST",
        body: {},
        protectedCall: true,
      });
      const targetCorrelationId = String(
        payload?.journey?.correlationId
        ?? payload?.signal?.journeyCorrelationId
        ?? payload?.correlationId
        ?? payload?.requestId
        ?? "",
      );
      let tracked = surfaceJourney(payload);
      notify("success", "Relay fault injected", "The worker will reject this safe probe until SQS moves it to the dead-letter queue.");

      let quarantined = tracked?.status === "quarantined";
      for (let attempt = 0; attempt < 40 && !quarantined; attempt += 1) {
        await new Promise(resolvePromise => window.setTimeout(resolvePromise, 750));
        const received = await loadJourneys({ quiet: true });
        tracked = tracked
          ? received.find(journey => journey.correlationId === tracked.correlationId || journey.eventId === tracked.eventId) ?? tracked
          : received.find(journey => {
            const key = `${journey.correlationId}:${journey.eventId}`;
            return (targetCorrelationId && journey.correlationId === targetCorrelationId)
              || (!previous.has(key) && journey.status !== "processed");
          }) ?? null;
        quarantined = tracked?.status === "quarantined";
      }

      if (quarantined) {
        notify("success", "Fault safely quarantined", `SQS isolated the event after ${Math.max(1, tracked.attempt)} processing attempts.`);
      } else {
        notify("success", "Fault is still travelling", "Live polling will keep following retries after this control is released.");
      }
    } catch (requestError) {
      notify("error", "Fault injection failed", requestError.message);
    } finally {
      setBusy("");
    }
  };

  const displayedAtlasSignals = visibleSignals.slice(0, 16);

  return (
    <div className="relative min-h-screen overflow-x-clip bg-night-950 text-slate-200">
      <div className="aurora-field" aria-hidden="true" />
      <div className="relative flex min-h-screen">
        <Sidebar connection={connection} onCreate={() => setCreateOpen(true)} />
        <div className="min-w-0 flex-1">
          <MobileHeader connection={connection} onCreate={() => setCreateOpen(true)} />
          <main id="main-content" className="mx-auto w-full max-w-[1540px] px-4 pb-32 pt-8 sm:px-6 lg:px-9 lg:pb-16 lg:pt-10 xl:px-12">
            <section id="atlas" className="scroll-mt-24 lg:scroll-mt-8">
              <div className="flex flex-col gap-7 xl:flex-row xl:items-end xl:justify-between">
                <div className="max-w-3xl">
                  <p className="eyebrow"><Sparkles size={13} aria-hidden="true" /> Interactive cloud observatory</p>
                  <h1 className="mt-4 max-w-2xl font-display text-[clamp(2.55rem,6vw,5.7rem)] font-semibold leading-[0.93] tracking-[-0.072em] text-white">
                    Every signal has a <span className="aurora-text">path.</span>
                  </h1>
                  <p className="mt-5 max-w-xl text-sm leading-7 text-slate-400 sm:text-base">
                    Explore a living constellation carried through S3, API Gateway, Lambda, DynamoDB Streams, EventBridge, SQS, and Logs — all inside stacksim.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                  <span className="meta-pill"><span className={cx("connection-dot", connection.className)} /> {connection.label}</span>
                  <span className="meta-pill"><ShieldCheck size={13} /> local-only credentials</span>
                  {runtimeConfig.isPlaceholder && <span className="meta-pill text-aurora-gold"><TriangleAlert size={13} /> placeholder endpoint</span>}
                </div>
              </div>

              <div className="mt-9 grid gap-3 sm:grid-cols-3">
                <StatCard icon={Radio} label="Live signals" value={loading ? "—" : signals.length.toString().padStart(2, "0")} note="in atlas" tone="mint" />
                <StatCard icon={Gauge} label="Mean intensity" value={loading ? "—" : `${averageIntensity}%`} note="field strength" tone="cyan" />
                <StatCard icon={Sparkles} label="Classifications" value={loading ? "—" : categories.length.toString().padStart(2, "0")} note="active spectra" tone="violet" />
              </div>

              <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.75fr)_360px]">
                <div className="glass-panel overflow-hidden p-2 sm:p-3">
                  <div className="flex flex-col gap-3 px-3 pb-3 pt-2 sm:flex-row sm:items-center sm:justify-between sm:px-4">
                    <div>
                      <p className="text-sm font-semibold text-slate-200">Live observation field</p>
                      <p className="mt-0.5 text-[10px] text-slate-600">Select any signal to inspect its DynamoDB record</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="hidden items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-slate-600 sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-aurora-mint" /> API SYNC</span>
                      <button type="button" className="small-icon-button" onClick={() => loadSignals()} disabled={loading} aria-label="Refresh signals">
                        <RefreshCw className={loading ? "animate-spin" : ""} size={15} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  {loading ? <LoadingAtlas /> : error ? (
                    <ErrorAtlas message={error} onRetry={() => loadSignals()} />
                  ) : signals.length === 0 ? (
                    <EmptyAtlas onCreate={() => setCreateOpen(true)} onReset={handleReset} />
                  ) : visibleSignals.length === 0 ? (
                    <div className="constellation-canvas grid place-items-center p-8 text-center">
                      <div><Search className="mx-auto text-slate-600" size={24} /><p className="mt-3 text-sm font-semibold text-slate-300">No matching signals</p><button type="button" className="text-button mt-2" onClick={() => { setFilter("all"); setQuery(""); }}>Clear filters</button></div>
                    </div>
                  ) : (
                    <Constellation signals={displayedAtlasSignals} selectedId={selectedId} onSelect={setSelectedId} />
                  )}
                </div>
                <SignalDetails signal={selectedSignal} busy={busy} onBoost={handleBoost} onArchive={handleArchive} />
              </div>
            </section>

            <section id="signals" className="scroll-mt-24 pt-16 lg:scroll-mt-8 lg:pt-20">
              <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
                <div>
                  <p className="eyebrow"><Radio size={13} aria-hidden="true" /> Signal catalog</p>
                  <h2 className="section-title">The sky, indexed.</h2>
                  <p className="section-copy">Filter the live DynamoDB collection, then select any record to bring it into focus.</p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <label className="search-control">
                    <Search size={15} aria-hidden="true" />
                    <span className="sr-only">Search signals</span>
                    <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search the atlas" />
                    {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={13} /></button>}
                  </label>
                  <button type="button" className="secondary-button" onClick={handleReset} disabled={Boolean(busy)}>
                    {busy === "reset" ? <LoaderCircle className="animate-spin" size={15} /> : <RefreshCw size={15} />}
                    Reset demo
                  </button>
                </div>
              </div>

              <div className="mt-6 flex gap-2 overflow-x-auto pb-2" role="group" aria-label="Filter signals by classification">
                {["all", ...categories].map(category => (
                  <button
                    key={category}
                    type="button"
                    className={cx("filter-chip", filter === category && "is-active")}
                    onClick={() => setFilter(category)}
                    aria-pressed={filter === category}
                  >
                    {category === "all" ? "All signals" : categoryDetails(category).label}
                    <span>{category === "all" ? signals.length : signals.filter(signal => signal.category === category).length}</span>
                  </button>
                ))}
              </div>

              {!loading && !error && (
                visibleSignals.length ? (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {visibleSignals.map(signal => <SignalCard key={signal.id} signal={signal} selected={signal.id === selectedId} onSelect={setSelectedId} />)}
                  </div>
                ) : (
                  <div className="glass-panel mt-4 p-10 text-center">
                    <Search className="mx-auto text-slate-600" size={23} />
                    <p className="mt-3 text-sm font-semibold text-slate-300">No signals match this view</p>
                    <button type="button" className="text-button mt-2" onClick={() => { setFilter("all"); setQuery(""); }}>Clear all filters</button>
                  </div>
                )
              )}
            </section>

            <JourneySection
              journeys={journeys}
              meta={journeyMeta}
              loading={journeyLoading}
              error={journeyError}
              faultRunning={busy === "fault"}
              onRefresh={() => loadJourneys()}
              onFault={handleFault}
            />

            <ServiceTopology proof={proof} proofRunning={busy === "proof"} proofError={proofError} onProof={handleProof} />

            <footer className="mt-20 flex flex-col gap-4 border-t border-white/[0.07] py-7 text-[10px] text-slate-600 sm:flex-row sm:items-center sm:justify-between">
              <span className="flex items-center gap-2"><Orbit size={13} /> Aurora Atlas · stacksim full-stack showcase</span>
              <span className="font-mono">DynamoDB → EventBridge → relay → SQS → worker</span>
            </footer>
          </main>
        </div>
      </div>

      <MobileNavigation />
      <CreateSignalDialog open={createOpen} busy={busy === "create"} onClose={() => setCreateOpen(false)} onSubmit={handleCreate} />
      <ToastRegion toasts={toasts} onDismiss={id => setToasts(current => current.filter(toast => toast.id !== id))} />
    </div>
  );
}
