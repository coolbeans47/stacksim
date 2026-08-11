import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Bug, Check, ChevronRight, CircleDot, Clock3, Filter,
  LayoutDashboard, ListRestart, LoaderCircle, Plus, RefreshCw, Search,
  ShieldAlert, Trash2, Users, X,
} from "lucide-react";
import { deleteBug, loadBugs, loadRuntimeConfig, loadUsers, saveBug } from "./api.js";

const STATUSES = ["BACKLOG", "TRIAGE", "IN_PROGRESS", "READY", "RESOLVED"];
const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const STATUS_META = {
  BACKLOG: ["Backlog", CircleDot],
  TRIAGE: ["Triage", AlertTriangle],
  IN_PROGRESS: ["In progress", Clock3],
  READY: ["Ready", ChevronRight],
  RESOLVED: ["Resolved", Check],
};
const EMPTY_DRAFT = {
  title: "", description: "", status: "BACKLOG", severity: "MEDIUM",
  component: "API", environment: "Production", assigneeId: "",
};

const displayTime = value => new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
}).format(new Date(value));
const issueNumber = bugs => `BUG-${Math.max(100, ...bugs.map(item => Number(item.id.match(/\d+/)?.[0] || 100))) + 1}`;
const cleanInput = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== null && item !== undefined));

function Pill({ children, tone = "neutral" }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

function BugCard({ item, user, onOpen, onMove, onDragStart }) {
  return (
    <article
      className="bug-card"
      draggable
      onDragStart={event => onDragStart(event, item.id)}
      onClick={() => onOpen(item)}
      onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(item); } }}
      role="button"
      tabIndex={0}
      aria-label={`${item.id}: ${item.title}. Open details.`}
      data-testid={`bug-card-${item.id}`}
    >
      <div className="card-topline">
        <span>{item.id}</span>
        <Pill tone={item.severity.toLowerCase()}>{item.severity}</Pill>
      </div>
      <h3>{item.title}</h3>
      <div className="card-tags"><Pill>{item.component}</Pill><Pill>{item.environment}</Pill></div>
      <footer>
        <span className="avatar mini" style={{ "--avatar": user?.avatarColor || "#5e6a7d" }}>{user?.name?.slice(0, 1) || "–"}</span>
        <span>{user?.name || "Unassigned"}</span>
        <time dateTime={item.updatedAt}>{displayTime(item.updatedAt)}</time>
      </footer>
      <label className="move-control" onClick={event => event.stopPropagation()}>
        <span className="sr-only">Move {item.id} to status</span>
        <select value={item.status} onChange={event => onMove(item, event.target.value)} aria-label={`Move ${item.id}`}>
          {STATUSES.map(status => <option key={status} value={status}>{STATUS_META[status][0]}</option>)}
        </select>
      </label>
    </article>
  );
}

function Filters({ filters, setFilters, users, bugs }) {
  const components = [...new Set(bugs.map(item => item.component))].sort();
  const environments = [...new Set(bugs.map(item => item.environment))].sort();
  const update = event => setFilters(current => ({ ...current, [event.target.name]: event.target.value }));
  return (
    <section className="filters" aria-label="Board filters">
      <div className="search-field"><Search size={16} /><input name="search" value={filters.search} onChange={update} placeholder="Search bugs" aria-label="Search bugs" /></div>
      <label><span>Assignee</span><select name="assignee" value={filters.assignee} onChange={update}><option value="">All</option><option value="unassigned">Unassigned</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
      <label><span>Severity</span><select name="severity" value={filters.severity} onChange={update}><option value="">All</option>{SEVERITIES.map(value => <option key={value}>{value}</option>)}</select></label>
      <label><span>Component</span><select name="component" value={filters.component} onChange={update}><option value="">All</option>{components.map(value => <option key={value}>{value}</option>)}</select></label>
      <label><span>Environment</span><select name="environment" value={filters.environment} onChange={update}><option value="">All</option>{environments.map(value => <option key={value}>{value}</option>)}</select></label>
      <button className="icon-button" title="Clear filters" onClick={() => setFilters({ search: "", assignee: "", severity: "", component: "", environment: "" })}><ListRestart size={17} /><span className="sr-only">Clear filters</span></button>
    </section>
  );
}

function Editor({ draft, setDraft, users, onSubmit, submitLabel, danger, onDelete }) {
  const update = event => setDraft(current => ({ ...current, [event.target.name]: event.target.value }));
  return (
    <form onSubmit={onSubmit} className="editor">
      <label className="wide"><span>Title</span><input required minLength={3} name="title" value={draft.title} onChange={update} /></label>
      <label className="wide"><span>Description</span><textarea required rows={6} name="description" value={draft.description} onChange={update} /></label>
      <label><span>Status</span><select name="status" value={draft.status} onChange={update}>{STATUSES.map(value => <option key={value} value={value}>{STATUS_META[value][0]}</option>)}</select></label>
      <label><span>Severity</span><select name="severity" value={draft.severity} onChange={update}>{SEVERITIES.map(value => <option key={value}>{value}</option>)}</select></label>
      <label><span>Component</span><input required name="component" value={draft.component} onChange={update} /></label>
      <label><span>Environment</span><input required name="environment" value={draft.environment} onChange={update} /></label>
      <label className="wide"><span>Assignee</span><select name="assigneeId" value={draft.assigneeId || ""} onChange={update}><option value="">Unassigned</option>{users.map(user => <option key={user.id} value={user.id}>{user.name} · {user.team}</option>)}</select></label>
      <div className="form-actions wide">
        {danger && <button type="button" className="danger" onClick={onDelete}><Trash2 size={16} /> Delete</button>}
        <button className="primary" type="submit"><Check size={17} /> {submitLabel}</button>
      </div>
    </form>
  );
}

function Drawer({ bug: item, users, onClose, onSave, onDelete }) {
  const [draft, setDraft] = useState({ ...item, assigneeId: item.assigneeId || "" });
  useEffect(() => setDraft({ ...item, assigneeId: item.assigneeId || "" }), [item]);
  return (
    <div className="overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title">
        <header><div><span className="eyebrow">{item.id}</span><h2 id="detail-title">Bug detail</h2></div><button className="icon-button" onClick={onClose}><X /><span className="sr-only">Close details</span></button></header>
        <div className="detail-meta"><span>Reported by {item.reporterId}</span><span>Created {displayTime(item.createdAt)}</span>{item.resolvedAt && <span>Resolved {displayTime(item.resolvedAt)}</span>}</div>
        <Editor
          draft={draft}
          setDraft={setDraft}
          users={users}
          submitLabel="Save changes"
          danger
          onDelete={() => onDelete(item)}
          onSubmit={event => { event.preventDefault(); onSave(item, draft); }}
        />
      </aside>
    </div>
  );
}

function Workload({ users, bugs, onSelect }) {
  return (
    <section className="workload-grid" aria-label="Team workload">
      {users.map(user => {
        const assigned = bugs.filter(item => item.assigneeId === user.id && item.status !== "RESOLVED");
        const critical = assigned.filter(item => item.severity === "CRITICAL").length;
        return <button key={user.id} className="person-card" onClick={() => onSelect(user.id)}>
          <span className="avatar" style={{ "--avatar": user.avatarColor }}>{user.name.slice(0, 1)}</span>
          <span className="person-copy"><strong>{user.name}</strong><small>{user.team}</small></span>
          <span className="workload-count"><strong>{assigned.length}</strong><small>open</small></span>
          {critical > 0 && <Pill tone="critical">{critical} critical</Pill>}
        </button>;
      })}
    </section>
  );
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [bugs, setBugs] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState("board");
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [polling, setPolling] = useState(false);
  const [filters, setFilters] = useState({ search: "", assignee: "", severity: "", component: "", environment: "" });
  const dragId = useRef("");
  const usersById = useMemo(() => Object.fromEntries(users.map(user => [user.id, user])), [users]);

  const refresh = useCallback(async (runtime = config, quiet = false) => {
    if (!runtime) return;
    quiet ? setRefreshing(true) : setLoading(true);
    setError("");
    try {
      const [nextBugs, nextUsers] = await Promise.all([loadBugs(runtime), loadUsers(runtime)]);
      setBugs(nextBugs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setUsers(nextUsers.sort((a, b) => a.name.localeCompare(b.name)));
    } catch (cause) {
      setError(cause.message);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [config]);

  useEffect(() => {
    let active = true;
    loadRuntimeConfig().then(runtime => {
      if (!active) return;
      setConfig(runtime);
      return refresh(runtime);
    }).catch(cause => { if (active) { setError(cause.message); setLoading(false); } });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!polling || !config) return undefined;
    const timer = setInterval(() => refresh(config, true), 15000);
    return () => clearInterval(timer);
  }, [polling, config, refresh]);

  const filtered = useMemo(() => bugs.filter(item => {
    const search = filters.search.toLowerCase();
    return (!search || `${item.id} ${item.title} ${item.description}`.toLowerCase().includes(search))
      && (!filters.assignee || (filters.assignee === "unassigned" ? !item.assigneeId : item.assigneeId === filters.assignee))
      && (!filters.severity || item.severity === filters.severity)
      && (!filters.component || item.component === filters.component)
      && (!filters.environment || item.environment === filters.environment);
  }), [bugs, filters]);

  const persist = async (input, close = false) => {
    try {
      setError("");
      const saved = await saveBug(config, cleanInput(input));
      setBugs(current => [saved, ...current.filter(item => item.id !== saved.id)]);
      if (close) { setSelected(null); setCreating(false); }
      else setSelected(saved);
    } catch (cause) { setError(cause.message); }
  };
  const move = (item, status) => persist({
    ...item,
    status,
    updatedAt: new Date().toISOString(),
    resolvedAt: status === "RESOLVED" ? (item.resolvedAt || new Date().toISOString()) : undefined,
  }, true);
  const saveEdit = (original, changed) => persist({
    ...cleanInput(changed),
    id: original.id,
    reporterId: original.reporterId,
    createdAt: original.createdAt,
    updatedAt: new Date().toISOString(),
    resolvedAt: changed.status === "RESOLVED" ? (original.resolvedAt || new Date().toISOString()) : undefined,
  }, true);
  const remove = async item => {
    if (!window.confirm(`Delete ${item.id}? This cannot be undone.`)) return;
    try { await deleteBug(config, item.id); setBugs(current => current.filter(candidate => candidate.id !== item.id)); setSelected(null); }
    catch (cause) { setError(cause.message); }
  };
  const create = event => {
    event.preventDefault();
    const now = new Date().toISOString();
    persist({ ...cleanInput(draft), id: issueNumber(bugs), reporterId: "USR-006", createdAt: now, updatedAt: now }, true);
    setDraft(EMPTY_DRAFT);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#"><span className="brand-mark"><Bug size={20} /></span><span><strong>Team Bug Triage</strong><small>AppSync · local workspace</small></span></a>
        <nav aria-label="Primary">
          <button className={view === "board" ? "active" : ""} onClick={() => setView("board")}><LayoutDashboard size={17} /> Board</button>
          <button className={view === "workload" ? "active" : ""} onClick={() => setView("workload")}><Users size={17} /> Workload</button>
        </nav>
        <div className="top-actions">
          <label className="poll"><input type="checkbox" checked={polling} onChange={event => setPolling(event.target.checked)} /> Poll 15s</label>
          <button className="secondary" onClick={() => refresh(config, true)} disabled={!config || refreshing}><RefreshCw size={17} className={refreshing ? "spin" : ""} /> Refresh</button>
          <button className="primary" onClick={() => setCreating(true)} disabled={!config}><Plus size={18} /> New bug</button>
        </div>
      </header>

      <main id="main">
        <section className="hero">
          <div><span className="eyebrow">Operations workspace</span><h1>{view === "board" ? "Triage board" : "Team workload"}</h1><p>{view === "board" ? "Move the work that matters. Every change is saved through AppSync." : "Assigned unresolved bugs across the team."}</p></div>
          <div className="hero-stat"><strong>{bugs.filter(item => item.status !== "RESOLVED").length}</strong><span>open bugs</span></div>
          <div className="hero-stat critical-stat"><strong>{bugs.filter(item => item.status !== "RESOLVED" && item.severity === "CRITICAL").length}</strong><span>critical</span></div>
        </section>

        {error && <div className="error-banner" role="alert"><ShieldAlert size={20} /><div><strong>Couldn’t complete that request</strong><span>{error}</span></div><button onClick={() => setError("")}><X size={18} /><span className="sr-only">Dismiss</span></button></div>}
        {view === "board" && <Filters filters={filters} setFilters={setFilters} users={users} bugs={bugs} />}
        <div className="boundary-note"><Filter size={14} /><span>Explicit refresh only — realtime subscriptions are not enabled in this local showcase.</span></div>

        {loading ? <div className="state-panel"><LoaderCircle className="spin" /><strong>Loading triage workspace…</strong><span>Connecting to the deployed AppSync endpoint.</span></div>
          : view === "workload" ? <Workload users={users} bugs={bugs} onSelect={id => { setFilters(current => ({ ...current, assignee: id })); setView("board"); }} />
            : <section className="board" aria-label="Bug status board">
              {STATUSES.map(status => {
                const [label, Icon] = STATUS_META[status];
                const items = filtered.filter(item => item.status === status);
                return <section
                  className={`column status-${status.toLowerCase()}`}
                  key={status}
                  onDragOver={event => event.preventDefault()}
                  onDrop={event => {
                    event.preventDefault();
                    const item = bugs.find(candidate => candidate.id === dragId.current);
                    if (item && item.status !== status) move(item, status);
                  }}
                >
                  <header><span className="column-title"><Icon size={16} />{label}</span><span className="count">{items.length}</span></header>
                  <div className="card-list">
                    {items.map(item => <BugCard key={item.id} item={item} user={usersById[item.assigneeId]} onOpen={setSelected} onMove={move} onDragStart={(event, id) => { dragId.current = id; event.dataTransfer.setData("text/plain", id); }} />)}
                    {!items.length && <div className="empty-column"><CircleDot size={19} /><span>No matching bugs</span></div>}
                  </div>
                </section>;
              })}
            </section>}
      </main>

      {selected && <Drawer bug={selected} users={users} onClose={() => setSelected(null)} onSave={saveEdit} onDelete={remove} />}
      {creating && <div className="overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setCreating(false); }}>
        <aside className="drawer compact" role="dialog" aria-modal="true" aria-labelledby="new-title">
          <header><div><span className="eyebrow">New report</span><h2 id="new-title">Create a bug</h2></div><button className="icon-button" onClick={() => setCreating(false)}><X /><span className="sr-only">Close</span></button></header>
          <Editor draft={draft} setDraft={setDraft} users={users} onSubmit={create} submitLabel="Create bug" />
        </aside>
      </div>}
    </div>
  );
}
