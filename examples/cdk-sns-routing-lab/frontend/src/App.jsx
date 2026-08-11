import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  Check,
  ChevronDown,
  CircleDot,
  Clock3,
  Code2,
  Database,
  Filter,
  FunctionSquare,
  Layers3,
  MessageSquareText,
  Network,
  RadioTower,
  RefreshCw,
  Route,
  Send,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  X,
} from "lucide-react";
import { apiRequest, runtimeConfig } from "./api.js";

const emptyDraft = {
  title: "Inventory reservation timeout",
  summary: "Checkout cannot reserve stock before the inventory service deadline.",
  severity: "critical",
  service: "storefront",
  environment: "production",
};

const fallbackRoutes = [
  { id: "critical-response", name: "Critical response", protocol: "lambda", filterScope: "MessageAttributes", filter: "severity = critical" },
  { id: "payments-triage", name: "Payments triage", protocol: "lambda", filterScope: "MessageBody", filter: "detail.service = payments" },
  { id: "production-watch", name: "Production watch", protocol: "lambda", filterScope: "MessageAttributes", filter: "environment = production" },
  { id: "audit-archive", name: "Audit archive", protocol: "sqs", filterScope: "None", filter: "all messages" },
];

const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
const routeIcons = {
  "critical-response": RadioTower,
  "payments-triage": FunctionSquare,
  "production-watch": Activity,
  "audit-archive": Database,
};

function shortId(value) {
  if (!value) return "pending";
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function relativeTime(value) {
  const then = new Date(value).getTime();
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Field({ label, children, hint }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

function StatusPill({ status }) {
  const labels = { delivered: "Delivered", filtered: "Filtered out", pending: "In flight" };
  return (
    <span className={`status-pill status-${status}`}>
      {status === "delivered" ? <Check size={13} /> : status === "pending" ? <Clock3 size={13} /> : <X size={13} />}
      {labels[status] ?? status}
    </span>
  );
}

function RouteCard({ route, compact = false }) {
  const Icon = routeIcons[route.id] ?? Route;
  return (
    <article className={`route-card route-${route.status ?? "ready"} ${compact ? "compact" : ""}`}>
      <div className="route-card-head">
        <span className="route-icon"><Icon size={18} /></span>
        <div>
          <h3>{route.name}</h3>
          <p>{route.protocol === "sqs" ? "SQS subscription" : "Lambda subscription"}</p>
        </div>
        {route.status ? <StatusPill status={route.status} /> : null}
      </div>
      <div className="filter-rule">
        <Filter size={13} />
        <code>{route.filter}</code>
      </div>
      {!compact ? (
        <div className="route-meta">
          <span>{route.filterScope === "None" ? "No filter policy" : `${route.filterScope} filter`}</span>
          <span>{route.protocol === "sqs" ? "Raw delivery" : "SNS envelope"}</span>
        </div>
      ) : null}
    </article>
  );
}

function TopicCore({ topic }) {
  return (
    <div className="topic-core">
      <div className="topic-orbit orbit-one" />
      <div className="topic-orbit orbit-two" />
      <div className="topic-core-content">
        <span className="topic-icon"><Network size={30} /></span>
        <span className="eyebrow">Standard topic</span>
        <strong>{topic?.name ?? "sns-routing-lab-incidents"}</strong>
        <small>{shortId(topic?.arn)}</small>
        <div className="topic-actions">
          <span>filter</span><span>fan out</span><span>retry</span>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <Sparkles size={22} />
      <h3>No journeys yet</h3>
      <p>Publish an incident or seed the tutorial to watch SNS evaluate four subscriptions.</p>
    </div>
  );
}

export function App() {
  const [draft, setDraft] = useState(emptyDraft);
  const [incidents, setIncidents] = useState([]);
  const [system, setSystem] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selected = useMemo(
    () => incidents.find((incident) => incident.id === selectedId) ?? incidents[0] ?? null,
    [incidents, selectedId],
  );
  const routes = system?.routes ?? fallbackRoutes;
  const stats = useMemo(() => {
    const decisions = incidents.flatMap((incident) => incident.routes ?? []);
    return {
      published: incidents.length,
      delivered: decisions.filter((route) => route.status === "delivered").length,
      filtered: decisions.filter((route) => route.status === "filtered").length,
      pending: decisions.filter((route) => route.status === "pending").length,
    };
  }, [incidents]);

  async function refresh({ quiet = false } = {}) {
    if (!quiet) setLoading(true);
    try {
      const [incidentResult, systemResult] = await Promise.all([
        apiRequest("/incidents"),
        apiRequest("/system"),
      ]);
      setIncidents(incidentResult.incidents ?? []);
      setSystem(systemResult);
      setError("");
    } catch (caught) {
      if (!quiet) setError(caught.message);
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(() => refresh({ quiet: true }), 2500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(""), 4500);
      return () => clearTimeout(timer);
    }
  }, [notice]);

  async function publish(event) {
    event.preventDefault();
    setPublishing(true);
    setError("");
    try {
      const result = await apiRequest("/incidents", { method: "POST", body: draft });
      setSelectedId(result.incident.id);
      setNotice("Published once to SNS. Watching each subscription decide independently.");
      await new Promise((resolve) => setTimeout(resolve, 250));
      await refresh({ quiet: true });
    } catch (caught) {
      setError(caught.message);
    } finally {
      setPublishing(false);
    }
  }

  async function seed() {
    setSeeding(true);
    setError("");
    try {
      const result = await apiRequest("/demo/seed", { method: "POST" });
      setNotice(result.written ? `Published ${result.written} tutorial incidents through SNS.` : "Tutorial incidents are already seeded.");
      await new Promise((resolve) => setTimeout(resolve, 350));
      await refresh({ quiet: true });
    } catch (caught) {
      setError(caught.message);
    } finally {
      setSeeding(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#" aria-label="Signal Relay home">
          <span className="brand-mark"><RadioTower size={20} /></span>
          <span><strong>Signal Relay</strong><small>SNS routing lab</small></span>
        </a>
        <nav aria-label="Tutorial navigation">
          <a href="#routing">Routing map</a>
          <a href="#journeys">Journeys</a>
          <a href="#learn">How it works</a>
        </nav>
        <div className="live-status"><span /> stacksim connected</div>
      </header>

      <main id="main-content">
        <section className="hero">
          <div className="hero-copy">
            <span className="kicker"><CircleDot size={14} /> Interactive AWS tutorial</span>
            <h1>Publish once.<br /><em>Watch four decisions.</em></h1>
            <p>SNS receives one incident, evaluates every subscription independently, and fans the message out only where its filters match.</p>
            <div className="hero-actions">
              <a className="button primary" href="#composer"><Send size={17} /> Publish an incident</a>
              <button className="button secondary" onClick={seed} disabled={seeding}>
                {seeding ? <RefreshCw className="spin" size={17} /> : <Layers3 size={17} />}
                {seeding ? "Seeding…" : "Load tutorial data"}
              </button>
            </div>
          </div>
          <div className="hero-proof">
            <span className="proof-label">What SNS owns</span>
            {[
              ["01", "Accept one publication"],
              ["02", "Evaluate every filter"],
              ["03", "Create independent deliveries"],
              ["04", "Retry and redrive failures"],
            ].map(([number, label]) => (
              <div className="proof-row" key={number}><span>{number}</span><strong>{label}</strong><Check size={16} /></div>
            ))}
          </div>
        </section>

        {runtimeConfig.isPlaceholder ? (
          <div className="banner warning">This is a placeholder frontend build. Run <code>npm run deploy</code> to inject the deployed API identity.</div>
        ) : null}
        {error ? <div className="banner error"><X size={17} />{error}<button onClick={() => setError("")}>Dismiss</button></div> : null}
        {notice ? <div className="toast"><Check size={17} />{notice}</div> : null}

        <section className="stat-strip" aria-label="Routing totals">
          <div><span>Published</span><strong>{stats.published}</strong><MessageSquareText size={19} /></div>
          <div><span>Delivered</span><strong>{stats.delivered}</strong><Check size={19} /></div>
          <div><span>Filtered out</span><strong>{stats.filtered}</strong><Filter size={19} /></div>
          <div><span>Pending</span><strong>{stats.pending}</strong><Clock3 size={19} /></div>
        </section>

        <section className="workbench" id="routing">
          <form className="composer" id="composer" onSubmit={publish}>
            <div className="section-heading">
              <div><span className="eyebrow">Producer</span><h2>Publish an incident</h2></div>
              <span className="step-number">01</span>
            </div>
            <p className="section-intro">The producer knows only the topic. It does not address queues or functions.</p>
            <Field label="Incident title">
              <input value={draft.title} maxLength={80} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </Field>
            <Field label="Summary">
              <textarea value={draft.summary} maxLength={280} rows={3} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} />
            </Field>
            <div className="field-grid">
              <Field label="Severity">
                <select value={draft.severity} onChange={(event) => setDraft({ ...draft, severity: event.target.value })}>
                  <option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
                </select>
              </Field>
              <Field label="Service">
                <select value={draft.service} onChange={(event) => setDraft({ ...draft, service: event.target.value })}>
                  <option value="payments">Payments</option><option value="identity">Identity</option><option value="search">Search</option><option value="storefront">Storefront</option>
                </select>
              </Field>
            </div>
            <Field label="Environment" hint="These values become SNS message attributes.">
              <select value={draft.environment} onChange={(event) => setDraft({ ...draft, environment: event.target.value })}>
                <option value="production">Production</option><option value="staging">Staging</option><option value="development">Development</option>
              </select>
            </Field>
            <button className="publish-button" disabled={publishing}>
              {publishing ? <RefreshCw className="spin" size={18} /> : <Send size={18} />}
              {publishing ? "Publishing once…" : "Publish once to SNS"}
            </button>
            <div className="payload-preview">
              <span><Code2 size={14} /> Message attributes</span>
              <code>severity="{draft.severity}"</code>
              <code>environment="{draft.environment}"</code>
              <code>service="{draft.service}"</code>
            </div>
          </form>

          <div className="routing-stage">
            <div className="section-heading">
              <div><span className="eyebrow">SNS routing map</span><h2>One topic, four subscriptions</h2></div>
              <button className="icon-button" onClick={() => refresh()} aria-label="Refresh routing data"><RefreshCw className={loading ? "spin" : ""} size={17} /></button>
            </div>
            <div className="routing-visual">
              <div className="producer-node"><TerminalSquare size={20} /><span>Publisher Lambda</span></div>
              <ArrowRight className="route-arrow producer-arrow" />
              <TopicCore topic={system?.topic} />
              <div className="fanout-lines" aria-hidden="true"><span /><span /><span /><span /></div>
              <div className="route-grid">
                {routes.map((route) => <RouteCard key={route.id} route={route} compact />)}
              </div>
            </div>
            <div className="routing-note">
              <ShieldCheck size={18} />
              <p><strong>Independent delivery:</strong> one subscriber can be filtered or retried without changing the outcome for another.</p>
            </div>
          </div>
        </section>

        <section className="journeys-section" id="journeys">
          <div className="section-heading">
            <div><span className="eyebrow">Delivery evidence</span><h2>Message journeys</h2></div>
            <span className="step-number">02</span>
          </div>
          <p className="section-intro wide">Select a published incident to see which subscriptions matched, which were filtered out, and what delivery shape each consumer received.</p>
          <div className="journey-layout">
            <div className="incident-list">
              {loading && !incidents.length ? <div className="loading-card"><RefreshCw className="spin" /> Loading routes…</div> : null}
              {!loading && !incidents.length ? <EmptyState /> : null}
              {[...incidents].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || String(b.occurredAt).localeCompare(String(a.occurredAt))).map((incident) => (
                <button key={incident.id} className={`incident-row ${selected?.id === incident.id ? "selected" : ""}`} onClick={() => setSelectedId(incident.id)}>
                  <span className={`severity-dot severity-${incident.severity}`} />
                  <span className="incident-main"><strong>{incident.title}</strong><small>{incident.service} · {incident.environment}</small></span>
                  <span className="incident-time">{relativeTime(incident.occurredAt)}</span>
                  <ChevronDown size={16} />
                </button>
              ))}
            </div>
            <div className="journey-detail">
              {selected ? (
                <>
                  <div className="detail-head">
                    <div>
                      <span className={`severity-badge severity-${selected.severity}`}>{selected.severity}</span>
                      <h3>{selected.title}</h3>
                      <p>{selected.summary}</p>
                    </div>
                    <div className="message-id"><span>SNS message ID</span><code>{shortId(selected.snsMessageId)}</code></div>
                  </div>
                  <div className="decision-grid">
                    {(selected.routes ?? []).map((route) => <RouteCard key={route.id} route={route} />)}
                  </div>
                </>
              ) : <EmptyState />}
            </div>
          </div>
        </section>

        <section className="learn-section" id="learn">
          <div className="learn-copy">
            <span className="eyebrow">Under the hood</span>
            <h2>SNS is the decision point—not just a pipe.</h2>
            <p>The publisher calls <code>Publish</code> once. SNS durably accepts the message, evaluates each subscription, and creates isolated delivery work for every match.</p>
          </div>
          <ol className="lesson-list">
            <li><span>1</span><div><strong>Publish</strong><p>The API sends JSON plus typed message attributes to one Standard topic.</p></div></li>
            <li><span>2</span><div><strong>Filter</strong><p>Subscriptions match attributes or nested fields from the JSON message body.</p></div></li>
            <li><span>3</span><div><strong>Fan out</strong><p>Lambda receives an SNS envelope while the audit queue receives a raw body.</p></div></li>
            <li><span>4</span><div><strong>Recover</strong><p>Each subscription owns its retry and dead-letter behaviour independently.</p></div></li>
          </ol>
        </section>
      </main>

      <footer>
        <div className="brand compact"><span className="brand-mark"><RadioTower size={17} /></span><span><strong>Signal Relay</strong><small>Built with ordinary AWS CDK</small></span></div>
        <p>Standard SNS topic · Lambda and SQS subscriptions · stacksim</p>
      </footer>
    </div>
  );
}
