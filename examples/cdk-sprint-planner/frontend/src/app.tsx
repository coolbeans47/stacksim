import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Activity,
  ArrowLeft,
  Bell,
  Check,
  ChevronRight,
  CircleDot,
  ClipboardList,
  GripVertical,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  Search,
  Sparkles,
  UserRound,
  Users,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiClient, ApiError, mutationId } from "./api.js";
import { AuthClient, type Tokens } from "./auth.js";
import type { Lane, RuntimeConfig, Session, Ticket } from "./types.js";

const runtime = __SPRINT_PLANNER_RUNTIME__ as RuntimeConfig;
const laneLabels: Record<string, string> = {
  BACKLOG: "Backlog",
  TODO: "To do",
  IN_PROGRESS: "In progress",
  REVIEW: "Review",
  DONE: "Done",
};
const laneOrder = ["TODO", "IN_PROGRESS", "REVIEW", "DONE"];
const priorityClass: Record<string, string> = {
  LOW: "priority low", MEDIUM: "priority medium", HIGH: "priority high", URGENT: "priority urgent",
};
const route = () => location.hash.slice(1).split("?")[0] || "/login";
const go = (path: string) => { location.hash = path; };

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join("");
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function AuthPanel({
  mode,
  auth,
  onTokens,
  invitation,
}: {
  mode: "login" | "signup" | "confirm";
  auth: AuthClient;
  onTokens(tokens: Tokens): void;
  invitation?: { invitationId: string; token: string; email?: string };
}) {
  const [email, setEmail] = useState(invitation?.email ?? sessionStorage.getItem("sprintPlannerEmail") ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (invitation?.email) setEmail(invitation.email);
  }, [invitation?.email]);
  const title = mode === "login" ? "Welcome back" : mode === "signup" ? "Create your account" : "Check your inbox";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      if (mode === "login") {
        onTokens(await auth.login(email, password));
        go(invitation ? "/accept-invite" : "/board");
      } else if (mode === "signup") {
        await auth.signUp(email, password);
        sessionStorage.setItem("sprintPlannerEmail", email);
        go("/confirm");
      } else {
        await auth.confirm(email, code);
        go("/login");
      }
    } catch (cause: any) {
      setError(cause?.message ?? "Authentication could not be completed.");
    } finally { setBusy(false); }
  };
  return (
    <main className="auth-page">
      <section className="auth-brand" aria-label="Sprint Planner introduction">
        <div className="brand-lockup"><span className="brand-mark"><ClipboardList /></span><span>Sprint Planner</span></div>
        <div className="auth-copy">
          <span className="eyebrow light">Northstar Product</span>
          <h1>Turn team momentum into visible progress.</h1>
          <p>A focused sprint space for planning, shipping, and staying in sync—live.</p>
        </div>
        <div className="auth-preview">
          <div><span className="dot purple" /> Invitation flow <strong>29 pts</strong></div>
          <div className="mini-lanes"><i /><i /><i /><i /></div>
        </div>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <div className="mobile-brand"><span className="brand-mark"><ClipboardList /></span>Sprint Planner</div>
          <span className="eyebrow">Northstar workspace</span>
          <h2>{title}</h2>
          <p className="muted">
            {mode === "login" ? "Sign in with your verified Cognito account."
              : mode === "signup" ? "Use your invited or bootstrap email address."
                : `Enter the confirmation code sent to ${email || "your email"}.`}
          </p>
          {error && <div className="alert error" role="alert">{error}</div>}
          <Field label="Email address">
            <input type="email" autoComplete="email" value={email} readOnly={Boolean(invitation?.email)} onChange={event => setEmail(event.target.value)} required />
          </Field>
          {mode !== "confirm" && <Field label="Password">
            <input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={event => setPassword(event.target.value)} required />
          </Field>}
          {mode === "confirm" && <Field label="Confirmation code">
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} required />
          </Field>}
          <button className="primary wide" disabled={busy}>
            {busy && <LoaderCircle className="spin" />} {mode === "login" ? "Sign in" : mode === "signup" ? "Create account" : "Confirm account"}
          </button>
          <div className="auth-links">
            {mode === "login" ? <button type="button" className="link" onClick={() => go("/signup")}>Create an account</button>
              : mode === "signup" ? <button type="button" className="link" onClick={() => go("/login")}>Sign in instead</button>
                : <button type="button" className="link" onClick={() => auth.resend(email).catch(cause => setError(cause.message))}>Send a new code</button>}
          </div>
        </form>
      </section>
    </main>
  );
}

function SortableTicket({
  ticket,
  session,
  memberNames,
  onOpen,
  onMove,
  onPlan,
  saving,
}: {
  ticket: Ticket;
  session: Session;
  memberNames: Record<string, string>;
  onOpen(ticket: Ticket): void;
  onMove(ticket: Ticket, status: string): void;
  onPlan?(ticket: Ticket): void;
  saving: boolean;
}) {
  const canMove = session.permissions.administer || ticket.assigneeMemberId === session.membership.memberId;
  const sortable = useSortable({ id: ticket.ticketKey, disabled: !canMove, data: { ticket } });
  return (
    <article
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
      className={`ticket-card ${sortable.isDragging ? "dragging" : ""} ${saving ? "saving" : ""}`}
      data-ticket={ticket.ticketKey}
    >
      <header>
        <button
          className="drag-handle"
          aria-label={`Drag ${ticket.ticketKey}`}
          disabled={!canMove}
          ref={sortable.setActivatorNodeRef}
          {...sortable.attributes}
          {...sortable.listeners}
        ><GripVertical /></button>
        <button className="ticket-key" onClick={() => onOpen(ticket)}>{ticket.ticketKey}</button>
        {saving && <span className="saving-label"><LoaderCircle className="spin" /> Saving</span>}
      </header>
      <button className="ticket-title" onClick={() => onOpen(ticket)}>{ticket.title}</button>
      <footer>
        <span className={priorityClass[ticket.priority]}>{ticket.priority.toLowerCase()}</span>
        <span className="points">{ticket.storyPoints}</span>
        <span className={`avatar tiny ${ticket.assigneeMemberId ? "" : "empty"}`} title={ticket.assigneeMemberId ? memberNames[ticket.assigneeMemberId] : "Unassigned"}>
          {ticket.assigneeMemberId ? initials(memberNames[ticket.assigneeMemberId] ?? "Former member") : "—"}
        </span>
        {canMove && ticket.status !== "BACKLOG" && (
          <select className="move-select" aria-label={`Move ${ticket.ticketKey} to`} value={ticket.status} onChange={event => onMove(ticket, event.target.value)}>
            {laneOrder.map(status => <option key={status} value={status}>{laneLabels[status]}</option>)}
          </select>
        )}
        {canMove && ticket.status === "BACKLOG" && onPlan && <button className="plan-button" onClick={() => onPlan(ticket)}>Add to sprint</button>}
      </footer>
    </article>
  );
}

function LaneColumn({
  lane,
  children,
}: {
  lane: Lane;
  children: React.ReactNode;
}) {
  const droppable = useDroppable({ id: `lane:${lane.status}`, data: { status: lane.status } });
  const points = lane.tickets.reduce((sum, ticket) => sum + ticket.storyPoints, 0);
  return (
    <section className={`lane ${droppable.isOver ? "over" : ""}`} ref={droppable.setNodeRef} aria-label={`${laneLabels[lane.status]} lane`}>
      <header className="lane-header">
        <div><span className={`lane-dot ${lane.status.toLowerCase()}`} />{laneLabels[lane.status]}</div>
        <span>{lane.tickets.length} · {points} pts</span>
      </header>
      <div className="lane-list">{children}{!lane.tickets.length && <div className="lane-empty">Drop work here</div>}</div>
    </section>
  );
}

function Board({
  lanes,
  setLanes,
  session,
  members,
  openTicket,
  api,
  notice,
  setNotice,
  scope,
}: {
  lanes: Lane[];
  setLanes(value: Lane[]): void;
  session: Session;
  members: any[];
  openTicket(ticket: Ticket): void;
  api: ApiClient;
  notice: string;
  setNotice(value: string): void;
  scope: "active" | "backlog";
}) {
  const [active, setActive] = useState<Ticket>();
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [mobileLane, setMobileLane] = useState("TODO");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 7 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const names = useMemo(() => Object.fromEntries(members.map(member => [member.memberId, member.displayName])), [members]);
  useEffect(() => {
    if (lanes.length && !lanes.some(lane => lane.status === mobileLane)) setMobileLane(lanes[0].status);
  }, [lanes, mobileLane]);
  const plan = useCallback(async (ticket: Ticket) => {
    const source = lanes.find(lane => lane.status === "BACKLOG");
    if (!source) return;
    setSaving(current => new Set(current).add(ticket.ticketKey));
    try {
      const planned = await api.request<{ lanes: Lane[] }>("GET", "/board?scope=sprint:sprint-09");
      const target = planned.lanes.find(lane => lane.status === "TODO")!;
      await api.request("POST", `/tickets/${ticket.ticketKey}/move`, {
        fromScope: "BACKLOG", fromStatus: "BACKLOG",
        toScope: "SPRINT#sprint-09", toStatus: "TODO",
        previousTicketKey: target.tickets.at(-1)?.ticketKey ?? null, nextTicketKey: null,
        expectedTicketVersion: ticket.version,
        expectedSourceLaneVersion: source.version, expectedTargetLaneVersion: target.version,
        clientMutationId: mutationId(),
      });
      setLanes([{ ...source, version: source.version + 1, tickets: source.tickets.filter(value => value.ticketKey !== ticket.ticketKey) }]);
      setNotice(`${ticket.ticketKey} added to Sprint 09.`);
    } catch (cause: any) { setNotice(cause.message ?? "Ticket could not be planned."); }
    finally { setSaving(current => { const next = new Set(current); next.delete(ticket.ticketKey); return next; }); }
  }, [api, lanes, setLanes, setNotice]);
  const move = useCallback(async (ticket: Ticket, status: string) => {
    if (status === ticket.status) return;
    const source = lanes.find(lane => lane.status === ticket.status)!;
    const target = lanes.find(lane => lane.status === status)!;
    const optimistic = lanes.map(lane => {
      if (lane.status === source.status) return { ...lane, tickets: lane.tickets.filter(value => value.ticketKey !== ticket.ticketKey) };
      if (lane.status === target.status) return { ...lane, tickets: [...lane.tickets, { ...ticket, status: status as Ticket["status"] }] };
      return lane;
    });
    setLanes(optimistic);
    setSaving(current => new Set(current).add(ticket.ticketKey));
    try {
      const previous = target.tickets.at(-1);
      const result = await api.request<{ ticket: Ticket; sourceLaneVersion: number; targetLaneVersion: number }>("POST", `/tickets/${encodeURIComponent(ticket.ticketKey)}/move`, {
        fromScope: `SPRINT#${session.activeSprint.sprintId}`,
        fromStatus: ticket.status,
        toScope: `SPRINT#${session.activeSprint.sprintId}`,
        toStatus: status,
        previousTicketKey: previous?.ticketKey ?? null,
        nextTicketKey: null,
        expectedTicketVersion: ticket.version,
        expectedSourceLaneVersion: source.version,
        expectedTargetLaneVersion: target.version,
        clientMutationId: mutationId(),
      });
      setLanes(optimistic.map(lane => ({
        ...lane,
        version: lane.status === source.status ? result.sourceLaneVersion : lane.status === target.status ? result.targetLaneVersion : lane.version,
        tickets: lane.tickets.map(value => value.ticketKey === ticket.ticketKey ? result.ticket : value),
      })));
      setNotice(`${ticket.ticketKey} moved to ${laneLabels[status]}.`);
    } catch (cause) {
      setLanes(lanes);
      setNotice(cause instanceof ApiError && cause.code === "BOARD_CONFLICT"
        ? "The board changed in another browser. Refreshing the affected lanes."
        : "The ticket could not be moved.");
    } finally {
      setSaving(current => { const next = new Set(current); next.delete(ticket.ticketKey); return next; });
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-ticket="${ticket.ticketKey}"] .drag-handle`)?.focus());
    }
  }, [api, lanes, session, setLanes, setNotice]);
  const endDrag = (event: DragEndEvent) => {
    const ticket = event.active.data.current?.ticket as Ticket | undefined;
    const over = event.over?.id?.toString() ?? "";
    const status = over.startsWith("lane:") ? over.slice(5) : lanes.find(lane => lane.tickets.some(value => value.ticketKey === over))?.status;
    setActive(undefined);
    if (ticket && status) void move(ticket, status);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={(event: DragStartEvent) => setActive(event.active.data.current?.ticket)}
      onDragCancel={() => setActive(undefined)}
      onDragEnd={endDrag}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `Picked up ${active.id}.`,
          onDragOver: ({ active, over }) => over ? `${active.id} is over ${over.id}.` : `${active.id} is no longer over a lane.`,
          onDragEnd: ({ active, over }) => over ? `${active.id} was dropped on ${over.id}.` : `${active.id} was not moved.`,
          onDragCancel: ({ active }) => `Moving ${active.id} was cancelled.`,
        },
      }}
    >
      <div className="mobile-lane-tabs" role="tablist" aria-label="Sprint lanes">
        {lanes.map(lane => <button role="tab" aria-selected={mobileLane === lane.status} key={lane.status} onClick={() => setMobileLane(lane.status)}>{laneLabels[lane.status]} <span>{lane.tickets.length}</span></button>)}
      </div>
      {notice && <div className="toast" role="status">{notice}<button aria-label="Dismiss" onClick={() => setNotice("")}><X /></button></div>}
      <div className="board-grid">
        {lanes.map(lane => (
          <div key={lane.status} className={mobileLane === lane.status ? "mobile-active" : ""}>
            <LaneColumn lane={lane}>
              <SortableContext items={lane.tickets.map(ticket => ticket.ticketKey)} strategy={verticalListSortingStrategy}>
                {lane.tickets.map(ticket => <SortableTicket key={ticket.ticketKey} ticket={ticket} session={session} memberNames={names} onOpen={openTicket} onMove={move} onPlan={scope === "backlog" ? plan : undefined} saving={saving.has(ticket.ticketKey)} />)}
              </SortableContext>
            </LaneColumn>
          </div>
        ))}
      </div>
      <DragOverlay>{active ? <div className="ticket-card overlay"><span className="ticket-key">{active.ticketKey}</span><strong>{active.title}</strong></div> : null}</DragOverlay>
    </DndContext>
  );
}

function TicketDrawer({
  ticket,
  api,
  onClose,
  onUpdated,
  members,
  session,
}: {
  ticket: Ticket;
  api: ApiClient;
  onClose(): void;
  onUpdated(ticket: Ticket): void;
  members: any[];
  session: Session;
}) {
  const [detail, setDetail] = useState<any>();
  const [comment, setComment] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [assignmentError, setAssignmentError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const load = useCallback(() => api.request("GET", `/tickets/${encodeURIComponent(ticket.ticketKey)}`).then(setDetail), [api, ticket.ticketKey]);
  useEffect(() => { void load(); closeRef.current?.focus(); }, [load]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await api.request("POST", `/tickets/${ticket.ticketKey}/comments`, { body: comment, expectedVersion: detail.ticket.version, clientMutationId: mutationId() });
    setComment(""); await load();
  };
  const currentTicket: Ticket = detail?.ticket ?? ticket;
  const member = members.find(value => value.memberId === currentTicket.assigneeMemberId);
  const canAssign = session.permissions.administer || currentTicket.assigneeMemberId === session.membership.memberId;
  const assign = async (assigneeMemberId: string) => {
    const nextAssignee = assigneeMemberId || null;
    if (nextAssignee === currentTicket.assigneeMemberId) return;
    setAssigning(true); setAssignmentError("");
    try {
      const result = await api.request<{ ticket: Ticket }>("POST", `/tickets/${encodeURIComponent(currentTicket.ticketKey)}/assign`, {
        assigneeMemberId: nextAssignee,
        expectedVersion: currentTicket.version,
        clientMutationId: mutationId(),
      });
      setDetail((value: any) => ({ ...value, ticket: result.ticket }));
      onUpdated(result.ticket);
    } catch (cause: any) {
      setAssignmentError(cause.message ?? "The ticket could not be assigned.");
    } finally {
      setAssigning(false);
    }
  };
  return (
    <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="ticket-heading">
      <header className="drawer-head">
        <div><span className="ticket-key">{currentTicket.ticketKey}</span><span className={priorityClass[currentTicket.priority]}>{currentTicket.priority.toLowerCase()}</span></div>
        <button ref={closeRef} className="icon-button" aria-label="Close ticket details" onClick={onClose}><X /></button>
      </header>
      <div className="drawer-scroll">
        <h2 id="ticket-heading">{currentTicket.title}</h2>
        <div className="ticket-meta-grid">
          <div><span>Status</span><strong><CircleDot /> {laneLabels[currentTicket.status]}</strong></div>
          <div><span>Story points</span><strong>{currentTicket.storyPoints} pts</strong></div>
          <div>
            <span>Assignee</span>
            {canAssign ? (
              <select
                className="assignee-select"
                aria-label="Assignee"
                value={currentTicket.assigneeMemberId ?? ""}
                disabled={assigning}
                onChange={event => void assign(event.target.value)}
              >
                <option value="">Unassigned</option>
                {members.map(value => <option key={value.memberId} value={value.memberId}>{value.displayName}</option>)}
              </select>
            ) : (
              <strong><span className="avatar tiny">{member ? initials(member.displayName) : "—"}</span>{member?.displayName ?? "Unassigned"}</strong>
            )}
            {assignmentError && <small className="assignment-error" role="alert">{assignmentError}</small>}
          </div>
          <div><span>Sprint</span><strong>Sprint 08</strong></div>
        </div>
        <section className="detail-section"><h3>Description</h3><p>{currentTicket.description || "No description yet."}</p></section>
        <section className="detail-section acceptance"><h3><Check /> Acceptance criteria</h3><p>{currentTicket.acceptanceCriteria || "No acceptance criteria yet."}</p></section>
        <section className="detail-section">
          <h3><MessageSquare /> Comments <span>{detail?.comments?.length ?? 0}</span></h3>
          <div className="comments">
            {detail?.comments?.map((entry: any) => <article key={entry.commentId}><span className="avatar tiny">{initials(entry.authorDisplayName)}</span><div><strong>{entry.authorDisplayName}</strong><p>{entry.body}</p></div></article>)}
          </div>
          <form className="comment-box" onSubmit={submit}>
            <input aria-label="Add a comment" placeholder="Add a comment…" value={comment} onChange={event => setComment(event.target.value)} />
            <button className="secondary" disabled={!comment.trim()}>Comment</button>
          </form>
        </section>
        <section className="detail-section"><h3><Activity /> Activity</h3><div className="activity-list">{detail?.activity?.slice(0, 6).map((entry: any) => <p key={entry.eventId}><span />{entry.summary}</p>)}</div></section>
      </div>
    </aside>
  );
}

function NewTicketDialog({ api, onClose, onCreated }: { api: ApiClient; onClose(): void; onCreated(): void }) {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [points, setPoints] = useState(3);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try {
      await api.request("POST", "/tickets", { title, priority, storyPoints: points, sprintId: null, clientMutationId: mutationId() });
      onCreated();
    } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" aria-labelledby="new-ticket" onSubmit={submit}>
    <header><div><span className="eyebrow">Northstar Product</span><h2 id="new-ticket">Create a ticket</h2></div><button type="button" className="icon-button" onClick={onClose}><X /></button></header>
    <Field label="Title"><input autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={160} required /></Field>
    <div className="form-row"><Field label="Priority"><select value={priority} onChange={event => setPriority(event.target.value)}>{["LOW", "MEDIUM", "HIGH", "URGENT"].map(value => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Story points"><select value={points} onChange={event => setPoints(Number(event.target.value))}>{[1, 2, 3, 5, 8, 13].map(value => <option key={value}>{value}</option>)}</select></Field></div>
    <footer><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy && <LoaderCircle className="spin" />} Create ticket</button></footer>
  </form></div>;
}

function TeamPage({ api, session }: { api: ApiClient; session: Session }) {
  const [data, setData] = useState<any>({ members: [], invitations: [] });
  const [invite, setInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(() => api.request<any>("GET", "/team").then(setData), [api]);
  useEffect(() => { void load(); }, [load]);
  const send = async (event: FormEvent) => {
    event.preventDefault(); setMessage("");
    try {
      await api.request("POST", "/invitations", { email, displayName: displayName || undefined, clientMutationId: mutationId() });
      setInvite(false); setEmail(""); setDisplayName(""); setMessage("Invitation sent."); await load();
    } catch (cause: any) { setMessage(cause.message); }
  };
  return <div className="content-page">
    <header className="page-title"><div><span className="eyebrow">Workspace</span><h2>Team</h2><p>People who plan and ship Northstar Product.</p></div>{session.permissions.manageTeam && <button className="primary" onClick={() => setInvite(true)}><Plus /> Invite member</button>}</header>
    {message && <div className="alert">{message}</div>}
    <div className="team-grid">{data.members.map((member: any) => <article className="member-card" key={member.memberId}><span className="avatar large">{initials(member.displayName)}</span><div><h3>{member.displayName}</h3><p>{member.email ?? "Active teammate"}</p></div><span className="role-pill">{member.role.toLowerCase()}</span></article>)}</div>
    {session.permissions.manageTeam && data.invitations?.length > 0 && <section className="pending-section"><h3>Pending invitations</h3>{data.invitations.map((item: any) => <div className="pending-row" key={item.invitationId}><span className="avatar empty"><UserRound /></span><div><strong>{item.displayName}</strong><p>{item.email}</p></div><span className="status-pill">{item.state.replaceAll("_", " ").toLowerCase()}</span></div>)}</section>}
    {invite && <div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" onSubmit={send}><header><div><span className="eyebrow">Northstar Product</span><h2>Invite a teammate</h2></div><button type="button" className="icon-button" onClick={() => setInvite(false)}><X /></button></header><Field label="Email address"><input autoFocus type="email" value={email} onChange={event => setEmail(event.target.value)} required /></Field><Field label="Display name (optional)"><input value={displayName} onChange={event => setDisplayName(event.target.value)} /></Field><footer><button type="button" className="secondary" onClick={() => setInvite(false)}>Cancel</button><button className="primary"><Bell /> Send invitation</button></footer></form></div>}
  </div>;
}

function AppShell({
  session,
  api,
  auth,
  tokens,
  clearTokens,
}: {
  session: Session;
  api: ApiClient;
  auth: AuthClient;
  tokens: Tokens;
  clearTokens(): void;
}) {
  const [currentRoute, setCurrentRoute] = useState(route());
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [selected, setSelected] = useState<Ticket>();
  const [newTicket, setNewTicket] = useState(false);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const scope = currentRoute === "/backlog" ? "backlog" : "active";
    const [board, team] = await Promise.all([
      api.request<{ lanes: Lane[] }>("GET", `/board?scope=${scope}`),
      api.request<{ members: any[] }>("GET", "/team"),
    ]);
    setLanes(board.lanes); setMembers(team.members);
  }, [api, currentRoute]);
  useEffect(() => {
    const update = () => setCurrentRoute(route());
    addEventListener("hashchange", update); return () => removeEventListener("hashchange", update);
  }, []);
  useEffect(() => { if (currentRoute !== "/team") void load(); }, [currentRoute, load]);
  useEffect(() => {
    let socket: WebSocket | undefined;
    let stopped = false;
    let retry: number | undefined;
    const connect = async () => {
      try {
        const minted = await api.request<{ ticket: string; websocketUrl: string }>("POST", "/realtime/tickets", { clientMutationId: mutationId() });
        if (stopped) return;
        socket = new WebSocket(`${minted.websocketUrl}?ticket=${encodeURIComponent(minted.ticket)}`);
        socket.onopen = () => setConnected(true);
        socket.onmessage = event => {
          const envelope = JSON.parse(event.data);
          if (envelope.eventType?.startsWith("Ticket")) void load();
        };
        socket.onclose = () => { setConnected(false); if (!stopped) retry = window.setTimeout(connect, 1500); };
      } catch { setConnected(false); if (!stopped) retry = window.setTimeout(connect, 2500); }
    };
    void connect();
    return () => { stopped = true; if (retry) clearTimeout(retry); socket?.close(); };
  }, [api, load]);
  const links = [
    ["/board", "Board", LayoutDashboard],
    ["/backlog", "Backlog", ClipboardList],
    ["/my-work", "My work", Sparkles],
    ["/team", "Team", Users],
  ] as const;
  const filtered = currentRoute === "/my-work"
    ? lanes.map(lane => ({ ...lane, tickets: lane.tickets.filter(ticket => ticket.assigneeMemberId === session.membership.memberId) }))
    : lanes;
  const completedPoints = lanes.find(lane => lane.status === "DONE")?.tickets.reduce((sum, ticket) => sum + ticket.storyPoints, 0) ?? 0;
  const totalPoints = lanes.reduce((sum, lane) => sum + lane.tickets.reduce((points, ticket) => points + ticket.storyPoints, 0), 0);
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-lockup"><span className="brand-mark"><ClipboardList /></span><span>Sprint Planner</span></div>
      <nav>{links.map(([path, label, Icon]) => <button key={path} className={currentRoute === path ? "active" : ""} onClick={() => go(path)}><Icon />{label}</button>)}</nav>
      <div className="sidebar-team"><span className="avatar">{initials(session.membership.displayName)}</span><div><strong>{session.membership.displayName}</strong><span>{session.membership.role === "ADMIN" ? "Administrator" : "Member"}</span></div><button aria-label="Sign out" onClick={() => auth.signOut(tokens).finally(clearTokens)}><LogOut /></button></div>
    </aside>
    <main id="main-content" className="main">
      {currentRoute === "/team" ? <TeamPage api={api} session={session} /> : <>
        <header className="topbar">
          <div className="topbar-title"><span className="eyebrow">{currentRoute === "/backlog" ? "Planning" : "Active sprint"}</span><h1>{currentRoute === "/backlog" ? "Product backlog" : session.activeSprint?.name}</h1><p>{currentRoute === "/backlog" ? "Shape and prioritize what comes next." : session.activeSprint?.goal}</p></div>
          <div className="topbar-actions">
            <button className="search-button"><Search /> <span>Search tickets</span><kbd>⌘ K</kbd></button>
            <span className={`connection ${connected ? "" : "offline"}`}>{connected ? <Wifi /> : <WifiOff />}{connected ? "Live" : "Reconnecting"}</span>
            {session.permissions.createTickets && <button className="primary" onClick={() => setNewTicket(true)}><Plus /> New ticket</button>}
          </div>
        </header>
        <section className="sprint-strip">
          <div className="progress-ring"><span>{totalPoints ? Math.round(completedPoints / totalPoints * 100) : 0}%</span></div>
          <div><span>SPRINT PROGRESS</span><strong>{completedPoints} / {totalPoints} story points</strong></div>
          <div className="date-block"><span>Timeline</span><strong>{session.activeSprint?.startDate} — {session.activeSprint?.endDate}</strong></div>
          <div className="avatar-stack">{members.slice(0, 4).map(member => <span className="avatar" key={member.memberId}>{initials(member.displayName)}</span>)}</div>
        </section>
        <div className="board-wrap">
          <Board lanes={filtered} setLanes={setLanes} session={session} members={members} openTicket={setSelected} api={api} notice={notice} setNotice={setNotice} scope={currentRoute === "/backlog" ? "backlog" : "active"} />
        </div>
      </>}
    </main>
    <nav className="bottom-nav">{links.map(([path, label, Icon]) => <button key={path} className={currentRoute === path ? "active" : ""} onClick={() => go(path)}><Icon /><span>{label}</span></button>)}</nav>
    {selected && <TicketDrawer
      ticket={selected}
      api={api}
      members={members}
      session={session}
      onClose={() => setSelected(undefined)}
      onUpdated={updated => {
        setSelected(updated);
        setLanes(current => current.map(lane => ({
          ...lane,
          tickets: lane.tickets.map(ticket => ticket.ticketKey === updated.ticketKey ? updated : ticket),
        })));
      }}
    />}
    {newTicket && <NewTicketDialog api={api} onClose={() => setNewTicket(false)} onCreated={() => { setNewTicket(false); void load(); }} />}
  </div>;
}

export function App() {
  const auth = useMemo(() => new AuthClient(runtime), []);
  const [tokens, setTokens] = useState<Tokens>();
  const [session, setSession] = useState<Session>();
  const [currentRoute, setCurrentRoute] = useState(route());
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [invitation, setInvitation] = useState<{ invitationId: string; token: string; email?: string } | undefined>(() => {
    if (!location.hash.startsWith("#/accept-invite?")) return;
    const params = new URLSearchParams(location.hash.split("?")[1]);
    const invitationId = params.get("id");
    const token = params.get("token");
    if (!invitationId || !token) return;
    history.replaceState(null, "", `${location.pathname}#/accept-invite`);
    return { invitationId, token };
  });
  const api = useMemo(() => new ApiClient(runtime, () => tokens), [tokens]);
  useEffect(() => {
    const update = () => setCurrentRoute(route());
    addEventListener("hashchange", update); return () => removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    auth.restore().then(setTokens).catch(() => sessionStorage.removeItem("sprintPlannerRefresh")).finally(() => setLoading(false));
  }, [auth]);
  useEffect(() => {
    if (!tokens) { setSession(undefined); return; }
    api.request<Session>("GET", "/session").then(setSession).catch(cause => {
      if (cause instanceof ApiError && cause.code === "NO_ACTIVE_MEMBERSHIP") setMessage("Your Cognito account is verified, but it is not yet a member of this workspace.");
    });
  }, [tokens, api]);
  useEffect(() => {
    if (!invitation || invitation.email) return;
    api.request<any>("POST", "/invitations/inspect", { invitationId: invitation.invitationId, token: invitation.token }, "none")
      .then(value => setInvitation({ ...invitation, email: value.email }))
      .catch(cause => setMessage(cause.message));
  }, [api, invitation]);
  const accept = async () => {
    if (!invitation || !tokens) return;
    try {
      await api.request("POST", "/invitations/accept", { invitationId: invitation.invitationId, token: invitation.token, clientMutationId: mutationId() }, "id");
      setInvitation(undefined);
      const next = await api.request<Session>("GET", "/session");
      setSession(next); go("/board");
    } catch (cause: any) { setMessage(cause.message); }
  };
  const claim = async () => {
    try {
      await api.request("POST", "/bootstrap/claim", {}, "id");
      setSession(await api.request<Session>("GET", "/session")); go("/board");
    } catch (cause: any) { setMessage(cause.message); }
  };
  if (loading) return <div className="full-loader"><span className="brand-mark"><ClipboardList /></span><LoaderCircle className="spin" /><p>Opening Sprint Planner…</p></div>;
  if (!tokens) {
    const mode = currentRoute === "/signup" || currentRoute === "/accept-invite" ? "signup" : currentRoute === "/confirm" ? "confirm" : "login";
    return <AuthPanel mode={mode} auth={auth} onTokens={setTokens} invitation={invitation} />;
  }
  if (invitation && !session) return <main className="center-state"><span className="brand-mark"><Users /></span><h1>Join Northstar Product</h1><p>You’re signed in as the invited email. Accept to become a member.</p>{message && <div className="alert error">{message}</div>}<button className="primary" onClick={accept}>Accept invitation <ChevronRight /></button></main>;
  if (!session) return <main className="center-state"><span className="brand-mark"><UserRound /></span><h1>Membership needed</h1><p>{message || "Claim the configured administrator membership or open a valid invitation."}</p><div className="state-actions"><button className="primary" onClick={claim}>Claim administrator access</button><button className="secondary" onClick={() => auth.signOut(tokens).finally(() => setTokens(undefined))}>Sign out</button></div></main>;
  return <AppShell session={session} api={api} auth={auth} tokens={tokens} clearTokens={() => setTokens(undefined)} />;
}
