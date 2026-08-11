import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Boxes,
  Check,
  ChevronRight,
  CircleStop,
  Clock3,
  Code2,
  GitBranch,
  PackageCheck,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Split,
  TimerReset,
  Truck,
  X,
  Zap,
} from "lucide-react";
import { orderflowApi } from "./api.js";

const baseOrder = {
  orderId: "OF-2048",
  customer: "Avery Stone",
  processingDelaySeconds: 1,
  fraudScore: 18,
  transientFailures: 0,
  failInventory: false,
  failItem: "",
  items: [
    { sku: "SKU-LAMP", quantity: 1 },
    { sku: "SKU-BOLT", quantity: 2 },
    { sku: "SKU-MUG", quantity: 1 },
  ],
};

const scenarios = [
  {
    id: "happy",
    label: "Happy path",
    note: "Parallel checks pass and all items package.",
    icon: Sparkles,
    tone: "mint",
    input: baseOrder,
  },
  {
    id: "retry",
    label: "Retry recovery",
    note: "Inventory fails once, backs off, then recovers.",
    icon: RotateCcw,
    tone: "amber",
    input: { ...baseOrder, orderId: "OF-RETRY", transientFailures: 1, processingDelaySeconds: 0 },
  },
  {
    id: "fraud",
    label: "Risk rejection",
    note: "The fraud choice routes to a terminal failure.",
    icon: ShieldCheck,
    tone: "rose",
    input: { ...baseOrder, orderId: "OF-RISK", fraudScore: 86, processingDelaySeconds: 0 },
  },
  {
    id: "package",
    label: "Map failure",
    note: "One mapped item fails and compensation runs.",
    icon: Boxes,
    tone: "violet",
    input: { ...baseOrder, orderId: "OF-MAP", failItem: "SKU-BOLT", processingDelaySeconds: 0 },
  },
  {
    id: "wait",
    label: "Observable wait",
    note: "Pause for 12 seconds so RUNNING stays visible.",
    icon: Clock3,
    tone: "blue",
    input: { ...baseOrder, orderId: "OF-WAIT", processingDelaySeconds: 12 },
  },
];

const nodes = [
  { name: "Validate order", kind: "Task", icon: Check, lane: "main" },
  { name: "Mark order accepted", kind: "Pass", icon: Zap, lane: "main" },
  { name: "Run checks in parallel", kind: "Parallel", icon: Split, lane: "main" },
  { name: "Reserve inventory", kind: "Task + Retry", icon: RotateCcw, lane: "parallel" },
  { name: "Assess fraud", kind: "Task", icon: ShieldCheck, lane: "parallel" },
  { name: "Fraud approved?", kind: "Choice", icon: GitBranch, lane: "main" },
  { name: "Processing window", kind: "Wait", icon: TimerReset, lane: "main" },
  { name: "Package items", kind: "Inline Map", icon: Boxes, lane: "main" },
  { name: "Package item", kind: "Mapped Task", icon: PackageCheck, lane: "map" },
  { name: "Dispatch order", kind: "Task", icon: Truck, lane: "main" },
  { name: "Order complete", kind: "Succeed", icon: Check, lane: "terminal" },
];

const failureNodes = [
  { name: "Reject risky order", kind: "Fail", icon: X, lane: "failure" },
  { name: "Compensate order", kind: "Catch Task", icon: RotateCcw, lane: "failure" },
  { name: "Order failed", kind: "Fail", icon: X, lane: "failure" },
];

const terminal = new Set(["SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"]);

function detailObject(event) {
  return Object.values(event).find((value) => value && typeof value === "object" && typeof value.name === "string");
}

function stateStatuses(events) {
  const values = {};
  const pendingOperations = [];
  let lastEntered = "";
  const operationNames = {
    inventory: "Reserve inventory",
    fraud: "Assess fraud",
    package: "Package item",
  };
  for (const event of events) {
    const detail = detailObject(event);
    const name = detail?.name;
    if (name && event.type.endsWith("Entered")) {
      values[name] = "RUNNING";
      lastEntered = name;
    }
    if (name && event.type.endsWith("Exited")) values[name] = "SUCCEEDED";
    if (event.type === "LambdaFunctionScheduled") {
      try {
        const input = JSON.parse(event.lambdaFunctionScheduledEventDetails?.input || "{}");
        const operationName = operationNames[input.operation];
        if (operationName) {
          values[operationName] = "RUNNING";
          pendingOperations.push(operationName);
        }
      } catch {
        // A malformed diagnostic payload should not break the observatory.
      }
    }
    if (event.type === "LambdaFunctionSucceeded") {
      const operationName = pendingOperations.pop();
      if (operationName) values[operationName] = "SUCCEEDED";
    }
    if (event.type === "TaskFailed") {
      const operationName = pendingOperations.pop();
      if (operationName) values[operationName] = "FAILED";
      const activeState = Object.keys(values).reverse().find((candidate) => values[candidate] === "RUNNING");
      if (activeState) values[activeState] = "FAILED";
    }
    if (["ExecutionFailed", "ExecutionAborted", "ExecutionTimedOut"].includes(event.type)) {
      const activeState = Object.keys(values).reverse().find((candidate) => values[candidate] === "RUNNING");
      if (activeState) values[activeState] = "FAILED";
      else if (lastEntered) values[lastEntered] = "FAILED";
    }
  }
  return values;
}

function eventLabel(event) {
  const detail = detailObject(event);
  if (detail?.name) return detail.name;
  if (event.type === "LambdaFunctionScheduled") {
    try {
      const operation = JSON.parse(event.lambdaFunctionScheduledEventDetails?.input || "{}").operation;
      return {
        inventory: "Inventory attempt",
        fraud: "Fraud assessment",
        package: "Package iteration",
        dispatch: "Dispatch operation",
        validate: "Validation operation",
        compensate: "Compensation operation",
      }[operation] || event.type;
    } catch {
      return event.type;
    }
  }
  return event.type.replace("Execution", "Execution ");
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function shortName(execution) {
  return execution?.name?.replace(/^order-/, "") || "execution";
}

function StatusPill({ status = "IDLE" }) {
  return <span className={`status status-${status.toLowerCase()}`}><span />{status}</span>;
}

function WorkflowNode({ node, status }) {
  const Icon = node.icon;
  return (
    <div className={`workflow-node lane-${node.lane} node-${(status || "idle").toLowerCase()}`}>
      <div className="node-icon"><Icon size={16} strokeWidth={1.8} /></div>
      <div className="node-copy">
        <strong>{node.name}</strong>
        <span>{node.kind}</span>
      </div>
      {status === "RUNNING" && <span className="live-pulse" aria-label="Running" />}
      {status === "SUCCEEDED" && <Check className="node-result success" size={16} />}
      {status === "FAILED" && <X className="node-result failure" size={16} />}
    </div>
  );
}

function EmptyInspector() {
  return (
    <div className="empty-inspector">
      <Activity size={26} />
      <strong>No execution selected</strong>
      <span>Launch a scenario or choose a recent run to inspect its input, history, and output.</span>
    </div>
  );
}

export default function App() {
  const [system, setSystem] = useState(null);
  const [executions, setExecutions] = useState([]);
  const [selectedArn, setSelectedArn] = useState("");
  const [execution, setExecution] = useState(null);
  const [events, setEvents] = useState([]);
  const [draft, setDraft] = useState(JSON.stringify(baseOrder, null, 2));
  const [showComposer, setShowComposer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("timeline");

  const refreshList = useCallback(async () => {
    const result = await orderflowApi.executions();
    setExecutions(result.executions || []);
    return result.executions || [];
  }, []);

  const refreshSelected = useCallback(async (arn) => {
    if (!arn) return;
    const [nextExecution, nextHistory] = await Promise.all([
      orderflowApi.execution(arn),
      orderflowApi.history(arn),
    ]);
    setExecution(nextExecution);
    setEvents(nextHistory.events || []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([orderflowApi.system(), refreshList()])
      .then(([nextSystem, nextExecutions]) => {
        if (cancelled) return;
        setSystem(nextSystem);
        if (nextExecutions[0]) setSelectedArn(nextExecutions[0].executionArn);
      })
      .catch((caught) => setError(caught.message));
    return () => { cancelled = true; };
  }, [refreshList]);

  useEffect(() => {
    if (!selectedArn) {
      setExecution(null);
      setEvents([]);
      return undefined;
    }
    let active = true;
    let timer;
    const poll = async () => {
      try {
        await refreshSelected(selectedArn);
        await refreshList();
        if (active) timer = window.setTimeout(poll, execution && terminal.has(execution.status) ? 3500 : 800);
      } catch (caught) {
        if (active) setError(caught.message);
      }
    };
    poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [selectedArn, refreshList, refreshSelected, execution?.status]);

  const launch = async (input) => {
    setBusy(true);
    setError("");
    try {
      const started = await orderflowApi.start({
        ...input,
        orderId: `${input.orderId}-${Date.now().toString(36).slice(-4).toUpperCase()}`,
      });
      setSelectedArn(started.executionArn);
      setShowComposer(false);
      await refreshList();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };

  const launchDraft = async () => {
    try {
      await launch(JSON.parse(draft));
    } catch (caught) {
      setError(`Custom input is not valid JSON: ${caught.message}`);
    }
  };

  const stop = async () => {
    if (!selectedArn) return;
    setBusy(true);
    try {
      await orderflowApi.stop(selectedArn);
      await refreshSelected(selectedArn);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };

  const statuses = useMemo(() => stateStatuses(events), [events]);
  const transitionCount = events.filter((event) => event.type.endsWith("Entered")).length;
  const visibleEvents = events.filter((event) =>
    event.type.endsWith("Entered") ||
    event.type === "LambdaFunctionScheduled" ||
    event.type === "TaskFailed" ||
    event.type.startsWith("Execution"),
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#">
          <span className="brand-mark"><Boxes size={20} /></span>
          <span><strong>OrderFlow</strong><small>Observatory</small></span>
        </a>
        <div className="environment-chip">
          <span className="environment-dot" />
          stacksim · {system?.mode || "STANDARD"}
        </div>
        <a className="console-link" href="#workflow">
          Workflow map <ChevronRight size={15} />
        </a>
      </header>

      <main id="main-content">
        <section className="hero">
          <div className="eyebrow"><Activity size={15} /> STANDARD WORKFLOW TELEMETRY</div>
          <div className="hero-grid">
            <div>
              <h1>See every decision<br />an order makes.</h1>
              <p>Launch a deterministic order journey, then watch Step Functions fan out, retry, wait, map, compensate, and complete in real time.</p>
            </div>
            <div className="hero-stats">
              <div><strong>{executions.length}</strong><span>Recent runs</span></div>
              <div><strong>{system?.stateMachine?.definition?.States ? Object.keys(system.stateMachine.definition.States).length : "—"}</strong><span>States</span></div>
              <div><strong>{execution?.status || "READY"}</strong><span>Selected status</span></div>
            </div>
          </div>
        </section>

        {error && (
          <div className="error-banner" role="alert">
            <AlertTriangle size={17} /><span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}><X size={16} /></button>
          </div>
        )}

        <section className="launcher" aria-labelledby="scenario-heading">
          <div className="section-heading">
            <div>
              <span className="kicker">01 · LAUNCH</span>
              <h2 id="scenario-heading">Choose a workflow story</h2>
            </div>
            <button className="secondary-button" onClick={() => setShowComposer((value) => !value)}>
              <Code2 size={16} /> Custom input
            </button>
          </div>
          <div className="scenario-grid">
            {scenarios.map((scenario) => {
              const Icon = scenario.icon;
              return (
                <button
                  className={`scenario-card tone-${scenario.tone}`}
                  disabled={busy}
                  key={scenario.id}
                  onClick={() => launch(scenario.input)}
                >
                  <span className="scenario-icon"><Icon size={18} /></span>
                  <span className="scenario-copy"><strong>{scenario.label}</strong><small>{scenario.note}</small></span>
                  <Play className="scenario-play" size={17} fill="currentColor" />
                </button>
              );
            })}
          </div>
          {showComposer && (
            <div className="composer">
              <div>
                <strong>Custom execution input</strong>
                <span>Edit any deterministic control: fraudScore, transientFailures, processingDelaySeconds, failInventory, or failItem.</span>
              </div>
              <textarea aria-label="Custom execution JSON" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck="false" />
              <button className="primary-button" disabled={busy} onClick={launchDraft}><Play size={16} /> Start custom run</button>
            </div>
          )}
        </section>

        <section className="observatory">
          <aside className="run-rail">
            <div className="rail-heading">
              <div><span className="kicker">02 · SELECT</span><h2>Executions</h2></div>
              <button aria-label="Refresh executions" onClick={refreshList}><RefreshCw size={16} /></button>
            </div>
            <div className="run-list">
              {executions.length === 0 && <p className="muted">No executions yet. Launch a scenario above.</p>}
              {executions.map((item) => (
                <button
                  className={`run-row ${selectedArn === item.executionArn ? "selected" : ""}`}
                  key={item.executionArn}
                  onClick={() => setSelectedArn(item.executionArn)}
                >
                  <span className="run-line"><strong>{shortName(item)}</strong><StatusPill status={item.status} /></span>
                  <span className="run-meta">{formatTime(item.startDate)}<ArrowRight size={12} />{item.stopDate ? formatTime(item.stopDate) : "live"}</span>
                </button>
              ))}
            </div>
          </aside>

          <div className="workspace" id="workflow">
            <div className="workspace-heading">
              <div>
                <span className="kicker">03 · OBSERVE</span>
                <h2>{execution ? shortName(execution) : "Workflow map"}</h2>
              </div>
              <div className="workspace-actions">
                {execution && <StatusPill status={execution.status} />}
                {execution?.status === "RUNNING" && (
                  <button className="stop-button" disabled={busy} onClick={stop}><CircleStop size={15} /> Stop</button>
                )}
              </div>
            </div>

            <div className="workflow-canvas">
              <div className="canvas-grid" />
              <div className="workflow-column">
                {nodes.slice(0, 3).map((node) => <WorkflowNode key={node.name} node={node} status={statuses[node.name]} />)}
                <div className="branch-block">
                  <div className="branch-label"><Split size={13} /> PARALLEL BRANCHES</div>
                  <div className="branch-grid">
                {nodes.slice(3, 5).map((node) => <WorkflowNode key={node.name} node={node} status={statuses[node.name]} />)}
                  </div>
                </div>
                <WorkflowNode node={nodes[5]} status={statuses[nodes[5].name]} />
                <div className="failure-route">
                  <span>NO / FRAUD SCORE ≥ 70</span>
                  <WorkflowNode node={failureNodes[0]} status={statuses[failureNodes[0].name]} />
                </div>
                {nodes.slice(6, 8).map((node) => <WorkflowNode key={node.name} node={node} status={statuses[node.name]} />)}
                <div className="map-block">
                  <div className="branch-label"><Boxes size={13} /> MAX CONCURRENCY 3</div>
                  <WorkflowNode node={nodes[8]} status={statuses[nodes[8].name]} />
                </div>
                <div className="failure-route compensation-route">
                  <span>CATCH / STATES.ALL</span>
                  <div className="failure-chain">
                    {failureNodes.slice(1).map((node) => <WorkflowNode key={node.name} node={node} status={statuses[node.name]} />)}
                  </div>
                </div>
                {nodes.slice(9).map((node) => <WorkflowNode key={node.name} node={node} status={statuses[node.name]} />)}
              </div>
              <div className="canvas-legend">
                <span><i className="legend-running" />Running</span>
                <span><i className="legend-success" />Succeeded</span>
                <span><i className="legend-failed" />Failed</span>
              </div>
            </div>
          </div>

          <aside className="inspector">
            <div className="inspector-tabs" role="tablist">
              {["timeline", "input", "output"].map((name) => (
                <button role="tab" aria-selected={tab === name} className={tab === name ? "active" : ""} key={name} onClick={() => setTab(name)}>
                  {name}
                </button>
              ))}
            </div>
            {!execution ? <EmptyInspector /> : (
              <div className="inspector-body">
                {tab === "timeline" && (
                  <>
                    <div className="timeline-summary">
                      <div><strong>{transitionCount}</strong><span>state entries</span></div>
                      <div><strong>{events.length}</strong><span>history events</span></div>
                    </div>
                    <div className="timeline">
                      {visibleEvents.map((event) => {
                        const detail = detailObject(event);
                        const failed = event.type.includes("Failed") || event.type.includes("Aborted") || event.type.includes("TimedOut");
                        return (
                          <div className={`timeline-row ${failed ? "timeline-failed" : ""}`} key={event.id}>
                            <span className="timeline-marker" />
                            <div><strong>{eventLabel(event)}</strong><span>{event.type}</span></div>
                            <time>{formatTime(event.timestamp)}</time>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
                {tab === "input" && <pre>{JSON.stringify(execution.input, null, 2)}</pre>}
                {tab === "output" && (
                  <pre>{JSON.stringify(execution.output || {
                    status: execution.status,
                    error: execution.error,
                    cause: execution.cause,
                  }, null, 2)}</pre>
                )}
              </div>
            )}
          </aside>
        </section>
      </main>

      <footer>
        <span><Boxes size={15} /> OrderFlow Observatory</span>
        <span>{system?.stateMachine?.name || "orderflow-observatory"} · CDK + React + Step Functions</span>
      </footer>
    </div>
  );
}
