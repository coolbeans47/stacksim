import { useCallback, useEffect, useRef, useState } from "react";
import { Amplify } from "aws-amplify";
import { confirmSignUp, fetchAuthSession, getCurrentUser, signIn, signOut, signUp } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { configureLocalAuth } from "./configure.mjs";

const mode = new URLSearchParams(window.location.search).get("mode") === "iam" ? "iam" : "owner";
const authMode = mode === "owner" ? "userPool" : "identityPool";
const control = import.meta.env.VITE_STACKSIM_ENDPOINT || "http://127.0.0.1:4566";
const outputUrl = selected => `/outputs/${selected}/amplify_outputs.json`;
const messages = {
  NotAuthorizedException: "That action is not authorized for this session.",
  UserNotConfirmedException: "Confirm the code from the local SES Inbox, then sign in.",
  UsernameExistsException: "This email is already registered in this mode. Sign in or confirm it.",
  CodeMismatchException: "The confirmation code did not match. Check the latest email.",
  ExpiredCodeException: "That confirmation code has expired.",
  InvalidPasswordException: "Use at least 8 characters, with uppercase, lowercase, a number and a symbol.",
  UserAlreadyAuthenticatedException: "Sign out of the active session before signing in as another user.",
  UserNotFoundException: "No user was found in this mode. Sign up first.",
};
function safeError(error) {
  if (error?.errors?.length) return "The backend rejected this operation for the current session.";
  return messages[error?.name] || "The request failed. Check the local backend and certificate setup in the README.";
}
function dataOrThrow(result) { if (result.errors?.length) throw result; return result.data; }
function dateLabel(value) { return value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"; }

export default function App() {
  const [client, setClient] = useState(null);
  const [ready, setReady] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [user, setUser] = useState(null);
  const [session, setSession] = useState({});
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [authStep, setAuthStep] = useState("signin");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [records, setRecords] = useState([]);
  const [search, setSearch] = useState("");
  const [nextToken, setNextToken] = useState(null);
  const [foreignId, setForeignId] = useState("");
  const [probe, setProbe] = useState("");
  const [events, setEvents] = useState([]);
  const [live, setLive] = useState("Sign in to subscribe");
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const subscriptions = useRef([]);
  const sessionGeneration = useRef(0);

  const stopSubscriptions = useCallback(() => {
    subscriptions.current.forEach(item => item.unsubscribe());
    subscriptions.current = [];
  }, []);
  const clearSessionView = useCallback(() => {
    sessionGeneration.current += 1;
    stopSubscriptions();
    setRecords([]); setEvents([]); setNextToken(null); setProbe("");
    setUser(null); setSession({}); setLive("Sign in to subscribe");
  }, [stopSubscriptions]);
  const inspectSession = useCallback(async (forceRefresh = false) => {
    let current;
    try { current = await getCurrentUser(); } catch { current = null; }
    const currentSession = await fetchAuthSession({ forceRefresh });
    setUser(current ? { id: current.userId, username: current.username, email: current.signInDetails?.loginId || current.username } : null);
    // Keep only safe metadata in React state; never render tokens or credentials.
    setSession({
      identityId: currentSession.identityId,
      tokenExpiry: currentSession.tokens?.accessToken.payload.exp ? Number(currentSession.tokens.accessToken.payload.exp) * 1000 : null,
      credentialExpiry: currentSession.credentials?.expiration?.getTime(),
      hasCredentials: Boolean(currentSession.credentials),
    });
  }, []);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await fetch(outputUrl(mode), { cache: "no-store" });
        if (!response.ok) throw new Error("missing outputs");
        const outputs = await response.json();
        configureLocalAuth(Amplify, outputs, control);
        if (!active) return;
        setClient(generateClient());
        await inspectSession();
        // Finish the initial guest lookup before allowing sign-in, so a late
        // guest response cannot replace the newly authenticated session view.
        if (active) setReady(true);
      } catch {
        if (active) setSetupError("Deploy the two pinned fixtures, then reload this page. If they are deployed, check the local endpoint and certificate instructions in the README.");
      }
    })();
    return () => { active = false; stopSubscriptions(); };
  }, [inspectSession, stopSubscriptions]);

  const loadRecords = useCallback(async (cursor = null, append = false) => {
    if (!client || !user) return;
    const generation = sessionGeneration.current;
    const result = await client.models.Todo.list({ authMode, limit: 5, ...(cursor ? { nextToken: cursor } : {}), ...(search.trim() ? { filter: { title: { contains: search.trim() } } } : {}) });
    const data = dataOrThrow(result);
    if (generation !== sessionGeneration.current) return;
    setRecords(previous => append ? [...previous, ...data] : data);
    setNextToken(result.nextToken || null);
  }, [client, user?.id, search]);
  useEffect(() => {
    if (!client || !user) return undefined;
    let active = true;
    loadRecords().catch(cause => { if (active) setError(safeError(cause)); });
    // The generated subscription applies owner authorization itself. Keep the
    // client filter absent so storage and selected owner representations do not
    // accidentally suppress authorized events.
    const options = { authMode };
    setLive("Subscription requested for this session");
    subscriptions.current = ["onCreate", "onUpdate", "onDelete"].map(operation => client.models.Todo[operation](options).subscribe({
      next: record => {
        if (!active) return;
        setEvents(previous => [{ id: `${Date.now()}-${record.id}-${operation}`, action: operation.slice(2).toLowerCase(), title: record.title, at: Date.now() }, ...previous].slice(0, 6));
        setLive("Authorized event received");
        loadRecords().catch(cause => { if (active) setError(safeError(cause)); });
      },
      error: () => { if (active) setLive("Disconnected — refresh and reconnect"); },
    }));
    return () => { active = false; stopSubscriptions(); };
  }, [client, user?.id, loadRecords, connectionGeneration, stopSubscriptions]);

  async function run(operation) {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (cause) { setError(safeError(cause)); }
    finally { setBusy(false); }
  }
  async function authenticate(event) {
    event.preventDefault();
    await run(async () => {
      if (authStep === "signup") {
        await signUp({ username: email.trim(), password, options: { userAttributes: { email: email.trim() } } });
        setPassword(""); setAuthStep("confirm"); setNotice("Open the local SES Inbox and enter the confirmation code.");
      } else if (authStep === "confirm") {
        await confirmSignUp({ username: email.trim(), confirmationCode: code.trim() });
        setCode(""); setAuthStep("signin"); setNotice("Email confirmed. Sign in with your password.");
      } else {
        const result = await signIn({ username: email.trim(), password, options: { authFlowType: "USER_SRP_AUTH" } });
        setPassword("");
        if (!result.isSignedIn) { setNotice("Complete email confirmation before signing in."); setAuthStep("confirm"); return; }
        await inspectSession(); setNotice("Signed in. The backend authorizes every record operation.");
      }
    });
    setPassword("");
  }
  async function logout() {
    await run(async () => {
      clearSessionView();
      // Amplify 6.20 closes an unused realtime connection after one second.
      // Keep controls busy until disposal, before a different session starts.
      await new Promise(done => setTimeout(done, 1100));
      await signOut({ global: false });
      await inspectSession();
      setNotice("Signed out locally. A fresh guest session has no authenticated Data access.");
    });
  }
  async function changeMode(selected) {
    if (selected === mode) return;
    await run(async () => {
      clearSessionView();
      await new Promise(done => setTimeout(done, 1100));
      if (ready) await signOut({ global: false });
      window.location.assign(`/?mode=${selected}`);
    });
  }
  async function refreshSession() {
    await run(async () => {
      stopSubscriptions();
      setLive("Reconnecting for the refreshed session");
      await new Promise(done => setTimeout(done, 1100));
      await inspectSession(true);
      setConnectionGeneration(value => value + 1);
      setNotice("Session refreshed; subscriptions reconnected for the active user.");
    });
  }
  async function createRecord(event) {
    event.preventDefault();
    await run(async () => {
      dataOrThrow(await client.models.Todo.create({ title: title.trim(), description: description.trim() || null, completed: false }, { authMode }));
      setTitle(""); setDescription(""); await loadRecords(); setNotice("Record created.");
    });
  }
  async function probeRecord(operation) {
    await run(async () => {
      const input = { id: foreignId.trim(), ...(operation === "update" ? { title: "Cross-user attempt" } : {}) };
      const result = await client.models.Todo[operation](input, { authMode });
      if (result.errors?.length || !result.data) setProbe(`${operation}: no record returned. Access was denied or the id is not visible.`);
      else { setProbe(`${operation}: succeeded. This id is accessible to the active user; verify you copied the other user's record.`); await loadRecords(); }
    });
  }
  async function iamDenial(guest) {
    await run(async () => {
      let denied = false;
      if (guest) {
        const result = await client.models.Todo.list({ authMode: "identityPool" });
        denied = Boolean(result.errors?.length);
      } else {
        const response = await fetch(outputUrl("owner"), { cache: "no-store" });
        if (!response.ok) { setProbe("Deploy the owner fixture to test the adjacent resource."); return; }
        const output = await response.json();
        const url = new URL(output.data.url);
        if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("nonlocal output");
        const adjacent = generateClient({ endpoint: url.href, authMode: "identityPool" });
        try { const result = await adjacent.graphql({ query: "{ listTodos { items { id } } }", authMode: "identityPool" }); denied = Boolean(result.errors?.length); }
        catch (cause) { if (!cause?.errors?.length) throw cause; denied = true; }
      }
      setProbe(denied ? (guest ? "Denied: guest credentials cannot access authenticated-only Data." : "Denied: this session's role has no grant on the adjacent owner API.") : "The request succeeded unexpectedly. Review the deployed fixture and IAM policy.");
    });
  }

  return (
    <div className="app-shell">
      <header className="topbar"><a className="brand" href="/">S<span>StackSim</span><small>LEARNING LAB 03</small></a><a href={`${control}/_stacksim/console`} target="_blank" rel="noreferrer">Open console ↗</a></header>
      <main>
        <section className="hero"><div><p className="eyebrow">IDENTITY · AUTHORIZATION · OWNERSHIP</p><h1>A little space.<br /><span>Just for you.</span></h1><p className="intro">Create a private note, switch accounts, and see exactly where access stops.</p></div><div className="lesson-note"><span>THE EXPERIMENT</span><strong>Two people.<br />One application.</strong><p>Alice's records stay Alice's.<br />Bob gets a space of his own.</p></div></section>
        <nav className="mode-switch" aria-label="Authorization experiment"><button className={mode === "owner" ? "selected" : ""} onClick={() => changeMode("owner")} disabled={busy}><span>01</span> Private records <small>User Pool + owner rule</small></button><button className={mode === "iam" ? "selected" : ""} onClick={() => changeMode("iam")} disabled={busy}><span>02</span> Shared signed-in records <small>Identity Pool + IAM</small></button></nav>
        <div className="session-strip"><span className={`status-dot ${user ? "online" : ""}`} /><strong>{user?.email || "Guest session"}</strong><span className="mode-pill">{authMode}</span><span className="session-description">{mode === "owner" ? "The generated owner rule protects each record." : "All signed-in users share this model. Ownership is not enabled."}</span></div>
        {setupError && <section className="setup-banner" role="alert"><strong>Connect your local backend</strong><p>{setupError}</p><code>npm run backend:install &amp;&amp; npm run deploy</code></section>}
        {error && <p className="feedback error" role="alert">{error}</p>}{notice && <p className="feedback" role="status">{notice}</p>}
        <div className="workspace">
          <aside className="account-panel panel"><p className="eyebrow">YOUR SESSION</p><h2>{user ? "Welcome back." : "Make it yours."}</h2>
            {!user ? <><div className="auth-tabs">{[["signin", "Sign in"], ["signup", "Sign up"], ["confirm", "Confirm"]].map(([key, label]) => <button className={authStep === key ? "active" : ""} key={key} onClick={() => setAuthStep(key)} disabled={busy}>{label}</button>)}</div><form onSubmit={authenticate}><label>Email<input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} placeholder="alice@example.test" /></label>{authStep === "confirm" ? <label>Code from the SES Inbox<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={event => setCode(event.target.value)} placeholder="Six-digit code" /></label> : <label>Password<input type="password" autoComplete={authStep === "signup" ? "new-password" : "current-password"} minLength={8} required value={password} onChange={event => setPassword(event.target.value)} /></label>}<button className="primary" disabled={!ready || busy}>{busy ? "Working…" : authStep === "signup" ? "Create account →" : authStep === "confirm" ? "Confirm email →" : "Sign in →"}</button></form><p className="muted small">Use a separate browser profile for Bob. Each mode has its own User Pool and account registration.</p>{mode === "iam" && <button className="outline" disabled={!ready || busy} onClick={() => iamDenial(true)}>Test guest Data access</button>}</> : <><div className="person"><span>{user.email.slice(0, 1).toUpperCase()}</span><div><strong>{user.email}</strong><small>Signed in with SRP</small></div></div><dl className="session-details"><dt>Token expires</dt><dd>{dateLabel(session.tokenExpiry)}</dd><dt>IAM credentials</dt><dd>{session.hasCredentials ? "Present in Amplify session" : "Not requested"}</dd><dt>Credentials expire</dt><dd>{dateLabel(session.credentialExpiry)}</dd></dl><button className="outline" disabled={busy} onClick={refreshSession}>Refresh &amp; reconnect</button><button className="text-button" disabled={busy} onClick={logout}>Sign out locally</button><p className="muted small">Signing out clears this frontend session. Previously issued JWTs and STS credentials keep their documented server lifetime.</p></>}
          </aside>
          <section className="records-panel panel"><div className="panel-heading"><div><p className="eyebrow">{mode === "owner" ? "ONLY YOURS" : "SHARED WITH SIGNED-IN USERS"}</p><h2>{mode === "owner" ? "Private notes" : "Shared notes"}</h2></div><span className="count">{records.length}</span></div>
            {user ? <><form className="composer" onSubmit={createRecord}><input aria-label="Note title" placeholder="What's on your mind?" value={title} maxLength={140} required onChange={event => setTitle(event.target.value)} /><textarea aria-label="Note details" placeholder="A little more detail (optional)" rows={2} value={description} onChange={event => setDescription(event.target.value)} /><div><span>Saved through the generated Data client</span><button className="primary" disabled={busy || !title.trim()}>Add note +</button></div></form><form className="search" onSubmit={event => { event.preventDefault(); run(() => loadRecords()); }}><input aria-label="Filter notes by title" placeholder="Filter titles…" value={search} onChange={event => setSearch(event.target.value)} /><button className="outline" disabled={busy}>Reload</button></form><div className="record-list">{records.length ? records.map(record => <article className="record" key={record.id}><div><h3>{record.title}</h3>{record.description && <p>{record.description}</p>}<code className="record-id">{record.id}</code><small>{mode === "owner" ? "Owner stamped by the backend" : "Visible to authenticated users"} · {record.completed ? "Done" : "Open"}</small></div><div className="record-actions"><button title="Copy record ID" onClick={() => run(async () => { await navigator.clipboard.writeText(record.id); setNotice("Record id copied. Paste it into Bob's access experiment."); })}>Copy ID</button><button disabled={busy} onClick={() => run(async () => { dataOrThrow(await client.models.Todo.update({ id: record.id, completed: !record.completed }, { authMode })); await loadRecords(); })}>{record.completed ? "Reopen" : "Complete"}</button><button className="danger-link" disabled={busy} onClick={() => run(async () => { dataOrThrow(await client.models.Todo.delete({ id: record.id }, { authMode })); await loadRecords(); })}>Delete</button></div></article>) : <div className="empty-state"><span>✳</span><h3>Your page is clear.</h3><p>Create a note to start the experiment.</p></div>}</div>{nextToken && <button className="outline load-more" disabled={busy} onClick={() => run(() => loadRecords(nextToken, true))}>Load next page</button>}</> : <div className="empty-state signed-out"><span>⌁</span><h3>A session opens the door.</h3><p>Sign in to create and read records.<br />Guest credentials do not grant Data access.</p></div>}
          </section>
        </div>
        <div className="experiments"><section className="panel"><p className="eyebrow">TRY THE BOUNDARY</p><h2>{mode === "owner" ? "Can Bob get in?" : "How far does IAM go?"}</h2>{mode === "owner" ? <><p className="muted">Copy Alice's record id into Bob's browser. These buttons make real backend requests with Bob's active session.</p><input aria-label="Other user's record id" value={foreignId} onChange={event => setForeignId(event.target.value)} placeholder="Paste the other user's record id" /><div className="button-row">{["get", "update", "delete"].map(operation => <button className="outline" key={operation} disabled={!user || busy || !foreignId.trim()} onClick={() => probeRecord(operation)}>{operation[0].toUpperCase() + operation.slice(1)}</button>)}</div><p className="small muted">Update and delete attempt to change that id. Use the other account's record for the isolation experiment.</p></> : <><p className="muted">The current session can use this shared model. Its generated IAM role does not grant access to the separate owner API.</p><button className="outline" disabled={!user || busy} onClick={() => iamDenial(false)}>Try the adjacent owner API</button><p className="small muted">Then sign out and test guest Data access. A new guest session must not inherit the authenticated role.</p></>}{probe && <p className="probe-result" role="status">{probe}</p>}</section><section className="panel"><div className="panel-heading"><div><p className="eyebrow">LIVE OBSERVATION</p><h2>Authorized updates</h2></div><span className={`status-dot ${user ? "online" : ""}`} /></div><p className="live-status" aria-live="polite">{live}</p>{events.length ? <ul className="event-list">{events.map(event => <li key={event.id}><span>{event.action}</span><strong>{event.title}</strong><time>{dateLabel(event.at)}</time></li>)}</ul> : <p className="muted">Keep both profiles open. Create or change a note and watch which session receives its event.</p>}<p className="small muted">{mode === "owner" ? "The generated subscription authorizes the active owner. Switching users closes the previous subscriptions." : "This fixture admits authenticated users to the shared model; it does not isolate records by owner."}</p></section></div>
        <footer><strong>Identity answers “who?”<br />Authorization answers “which records?”</strong><p>User Pools issue identity tokens. Identity Pools exchange a verified login for temporary IAM credentials. The generated owner rule controls each private record.</p><span>StackSim · Local learning, real clients</span></footer>
      </main>
    </div>
  );
}
