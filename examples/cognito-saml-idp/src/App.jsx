import { useEffect, useMemo, useRef, useState } from "react";

const initialUser = {
  subject: "developer-001",
  name: "Ada Developer",
  email: "ada@example.test",
};

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function pkce() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function randomValue() {
  return base64Url(crypto.getRandomValues(new Uint8Array(24)));
}

function decodeClaims(token) {
  if (!token) return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  const padded = payload.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
  return JSON.parse(atob(padded));
}

function postForm(action, fields) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = action;
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}

function StatusPill({ tone = "neutral", children }) {
  return <span className={`status status-${tone}`}><span className="status-dot" />{children}</span>;
}

function Field({ label, hint, ...input }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...input} />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function RequestDetail({ label, value }) {
  return (
    <div className="request-detail">
      <dt>{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}

const flowSteps = [
  {
    number: "1",
    title: "Request",
    copy: "Cognito asks the IdP to authenticate a user.",
    eyebrow: "COGNITO → IDENTITY PROVIDER",
    lead: "Cognito needs another trusted system to confirm who the person is, so it sends Paper Badge a SAML authentication request.",
    details: [
      {
        title: "Who starts it?",
        copy: "The React app sends your browser to Cognito. Cognito then redirects the browser to Paper Badge with an AuthnRequest.",
      },
      {
        title: "What is in the request?",
        copy: "It names the user pool that is asking, gives the request a unique ID, and says exactly which Cognito URL may receive the answer.",
      },
      {
        title: "Is the user identified yet?",
        copy: "No. The request asks for authentication but contains no password and does not yet claim that a particular person has signed in.",
      },
    ],
    takeaway: "This phase is Cognito saying: “Trusted identity provider, please identify this browser and return the answer only to me.”",
  },
  {
    number: "2",
    title: "Assertion",
    copy: "The IdP signs facts about that user.",
    eyebrow: "IDENTITY PROVIDER → COGNITO",
    lead: "After choosing a pretend employee, Paper Badge creates a SAML assertion: a short-lived, digitally signed statement about that identity.",
    details: [
      {
        title: "What does it say?",
        copy: "It includes a stable subject ID plus the employee's name, email address, and verified-email status.",
      },
      {
        title: "Why is it trusted?",
        copy: "Paper Badge signs it with its private key. Cognito checks that signature with the public certificate it learned from the IdP metadata.",
      },
      {
        title: "How does it travel?",
        copy: "The browser posts the assertion to Cognito's assertion consumer service. Its audience, destination, request ID, and expiry stop it being reused elsewhere.",
      },
    ],
    takeaway: "An assertion is not a password or an app token. It is signed evidence from the identity provider that Cognito can verify.",
  },
  {
    number: "3",
    title: "Tokens",
    copy: "Cognito verifies the assertion and issues its own tokens.",
    eyebrow: "COGNITO → APPLICATION",
    lead: "Once Cognito trusts the SAML assertion, SAML has finished its job. Cognito returns the browser to the React app using a standard OAuth flow.",
    details: [
      {
        title: "Why an authorization code first?",
        copy: "Cognito sends a short-lived, one-time code to the callback URL instead of putting tokens directly in the browser address bar.",
      },
      {
        title: "What does PKCE do?",
        copy: "The app exchanges the code with a secret verifier created at the start. This proves the same browser that began the sign-in is completing it.",
      },
      {
        title: "What are the tokens for?",
        copy: "The ID token describes the signed-in user. The access token represents access granted to the app. This demo decodes both so you can inspect their claims.",
      },
    ],
    takeaway: "The application receives and uses Cognito tokens. It never needs to understand or trust the SAML assertion itself.",
  },
];

function FlowRail({ active }) {
  const [selectedIndex, setSelectedIndex] = useState(null);
  const closeButton = useRef(null);
  const stepButtons = useRef([]);
  const selectedStep = selectedIndex === null ? null : flowSteps[selectedIndex];

  function closeGuide() {
    const returnTo = selectedIndex;
    setSelectedIndex(null);
    if (returnTo !== null) {
      requestAnimationFrame(() => stepButtons.current[returnTo]?.focus());
    }
  }

  useEffect(() => {
    if (selectedIndex === null) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeGuide();
      } else if (event.key === "Tab") {
        event.preventDefault();
        closeButton.current?.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [selectedIndex]);

  return (
    <>
      <ol className="flow-rail" aria-label="SAML learning flow">
        {flowSteps.map((step, index) => (
          <li className={index <= active ? "flow-active" : ""} key={step.number}>
            <button
              type="button"
              className="flow-step"
              onClick={() => setSelectedIndex(index)}
              ref={element => { stepButtons.current[index] = element; }}
              aria-haspopup="dialog"
              aria-current={index === active ? "step" : undefined}
            >
              <span className="flow-number">{step.number}</span>
              <span className="flow-copy">
                <strong>{step.title}</strong>
                <span className="flow-summary">{step.copy}</span>
                <span className="flow-learn">Explain this step <b aria-hidden="true">+</b></span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      {selectedStep ? (
        <div className="flow-guide-backdrop" onMouseDown={closeGuide}>
          <section
            className="flow-guide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="flow-guide-title"
            aria-describedby="flow-guide-lead"
            onMouseDown={event => event.stopPropagation()}
          >
            <div className="flow-guide-topline">
              <p className="eyebrow">{selectedStep.eyebrow}</p>
              <button
                type="button"
                className="flow-guide-close"
                onClick={closeGuide}
                ref={closeButton}
                aria-label={`Close ${selectedStep.title} explanation`}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <div className="flow-guide-title">
              <span className="flow-guide-number">{selectedStep.number}</span>
              <h2 id="flow-guide-title">{selectedStep.title}</h2>
            </div>
            <p className="flow-guide-lead" id="flow-guide-lead">{selectedStep.lead}</p>
            <div className="flow-guide-details">
              {selectedStep.details.map(detail => (
                <section key={detail.title}>
                  <h3>{detail.title}</h3>
                  <p>{detail.copy}</p>
                </section>
              ))}
            </div>
            <div className="flow-guide-takeaway">
              <strong>Beginner takeaway</strong>
              <p>{selectedStep.takeaway}</p>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function WaitingView({ config, onStart, starting }) {
  return (
    <main className="page-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">LOCAL SAML LAB</p>
          <h1>See a trusted login<br />cross the wire.</h1>
          <p className="hero-copy">
            Paper Badge is a deliberately small identity provider. It shows the request from
            Cognito, signs a SAML assertion, and hands the browser back.
          </p>
          <div className="hero-actions">
            <button className="button button-primary" onClick={onStart} disabled={!config?.configured || starting}>
              {starting ? "Preparing secure request…" : "Start SAML sign-in"}
            </button>
            <a className="button button-secondary" href="/saml/metadata">View IdP metadata</a>
          </div>
          {!config?.configured ? (
            <div className="notice notice-warn">
              <strong>One setup step remains.</strong>
              <span>Run <code>npm run setup:cognito</code>, then refresh this page.</span>
            </div>
          ) : null}
        </div>
        <aside className="hero-card">
          <div className="paper-tab">LEARNING IDP</div>
          <div className="badge-mark">PB</div>
          <p className="badge-kicker">TRUSTED BY</p>
          <h2>{config?.poolId ?? "Your local user pool"}</h2>
          <div className="badge-rule" />
          <dl>
            <div><dt>Protocol</dt><dd>SAML 2.0</dd></div>
            <div><dt>Binding</dt><dd>Redirect → POST</dd></div>
            <div><dt>Signature</dt><dd>RSA-SHA256</dd></div>
          </dl>
          <StatusPill tone={config?.configured ? "good" : "neutral"}>
            {config?.configured ? "Cognito configured" : "Waiting for setup"}
          </StatusPill>
        </aside>
      </section>
      <section className="explain-grid">
        <div><span>01</span><h3>Cognito is the service provider</h3><p>It creates an AuthnRequest and decides which local callback may receive the answer.</p></div>
        <div><span>02</span><h3>This app is the identity provider</h3><p>It identifies a pretend employee and signs the attributes you choose below.</p></div>
        <div><span>03</span><h3>Your app receives Cognito tokens</h3><p>SAML stays between the IdP and Cognito. The application only handles OAuth tokens.</p></div>
      </section>
    </main>
  );
}

function LoginView({ request }) {
  const [user, setUser] = useState(initialUser);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function signIn(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          samlRequest: new URLSearchParams(location.search).get("SAMLRequest"),
          relayState: request.relayState,
          user,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not create the SAML response.");
      postForm(result.acsUrl, {
        SAMLResponse: result.samlResponse,
        RelayState: result.relayState,
      });
    } catch (problem) {
      setError(problem.message);
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-heading">
        <div>
          <p className="eyebrow">AUTHENTICATION REQUEST RECEIVED</p>
          <h1>Choose the identity<br />Cognito should trust.</h1>
        </div>
        <StatusPill tone="good">Signature key ready</StatusPill>
      </section>
      <div className="login-grid">
        <form className="identity-card" onSubmit={signIn}>
          <div className="identity-card-head">
            <div className="avatar">{user.name.split(/\s+/).map(value => value[0]).slice(0, 2).join("").toUpperCase()}</div>
            <div><p>SIMULATED EMPLOYEE</p><h2>{user.name || "Unnamed user"}</h2></div>
          </div>
          <Field label="Display name" value={user.name} onChange={event => setUser({ ...user, name: event.target.value })} required />
          <Field label="Email address" type="email" value={user.email} onChange={event => setUser({ ...user, email: event.target.value })} required />
          <Field
            label="Stable subject (NameID)"
            value={user.subject}
            onChange={event => setUser({ ...user, subject: event.target.value })}
            hint="Changing this creates a different external identity in Cognito."
            required
          />
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="button button-primary button-wide" disabled={submitting}>
            {submitting ? "Signing assertion…" : "Sign in as this user"}
          </button>
          <p className="fine-print">No password is checked. This is a transparent learning IdP, not an authentication system.</p>
        </form>
        <aside className="request-card">
          <div className="request-title"><span className="request-icon">↙</span><div><p>FROM COGNITO</p><h2>AuthnRequest</h2></div></div>
          <dl>
            <RequestDetail label="User pool" value={request.poolId} />
            <RequestDetail label="Request ID" value={request.requestId} />
            <RequestDetail label="Issued" value={request.issueInstant} />
            <RequestDetail label="Return to" value={request.acsUrl} />
          </dl>
          <details>
            <summary>Inspect the decoded XML</summary>
            <pre>{request.xml}</pre>
          </details>
        </aside>
      </div>
      <FlowRail active={1} />
    </main>
  );
}

function CallbackView({ config }) {
  const parameters = useMemo(() => new URLSearchParams(location.search), []);
  const code = parameters.get("code");
  const returnedState = parameters.get("state");
  const oauthError = parameters.get("error");
  const [claims, setClaims] = useState();
  const [error, setError] = useState(oauthError ? `${oauthError}: ${parameters.get("error_description") ?? ""}` : "");
  const [exchanging, setExchanging] = useState(false);

  async function exchange() {
    const verifier = sessionStorage.getItem("paper-badge-pkce-verifier");
    const expectedState = sessionStorage.getItem("paper-badge-oauth-state");
    if (!verifier || !code) return setError("The authorization code or saved PKCE verifier is missing.");
    if (expectedState !== returnedState) return setError("The returned OAuth state does not match this browser session.");
    setExchanging(true);
    try {
      const response = await fetch("/api/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, verifier }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error_description ?? result.error ?? "Token exchange failed.");
      setClaims({
        id: decodeClaims(result.id_token),
        access: decodeClaims(result.access_token),
      });
      sessionStorage.removeItem("paper-badge-pkce-verifier");
      sessionStorage.removeItem("paper-badge-oauth-state");
    } catch (problem) {
      setError(problem.message);
    } finally {
      setExchanging(false);
    }
  }

  return (
    <main className="result-shell">
      <section className="result-card">
        <div className="success-mark">✓</div>
        <p className="eyebrow">SAML ACCEPTED</p>
        <h1>Cognito trusted the badge.</h1>
        <p>
          The signed assertion became a Cognito authorization code. Exchange it to see the
          ordinary OAuth claims your application receives.
        </p>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {!claims && code ? (
          <button className="button button-primary" onClick={exchange} disabled={exchanging || !config?.configured}>
            {exchanging ? "Exchanging code…" : "Exchange code for tokens"}
          </button>
        ) : null}
        {claims ? (
          <div className="claims-grid">
            <section><h2>ID token claims</h2><pre>{JSON.stringify(claims.id, null, 2)}</pre></section>
            <section><h2>Access token claims</h2><pre>{JSON.stringify(claims.access, null, 2)}</pre></section>
          </div>
        ) : null}
        <a className="text-link" href="/">Start with another identity →</a>
      </section>
      <FlowRail active={2} />
    </main>
  );
}

export default function App() {
  const [config, setConfig] = useState();
  const [request, setRequest] = useState();
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const isCallback = location.pathname === "/callback";
  const isSso = location.pathname === "/saml/sso";

  useEffect(() => {
    fetch("/api/config").then(response => response.json()).then(setConfig).catch(problem => setError(problem.message));
  }, []);

  useEffect(() => {
    if (!isSso) return;
    fetch(`/api/request${location.search}`)
      .then(async response => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error);
        return value;
      })
      .then(setRequest)
      .catch(problem => setError(problem.message));
  }, [isSso]);

  async function startSignIn() {
    setStarting(true);
    setError("");
    try {
      const { verifier, challenge } = await pkce();
      const state = randomValue();
      const nonce = randomValue();
      sessionStorage.setItem("paper-badge-pkce-verifier", verifier);
      sessionStorage.setItem("paper-badge-oauth-state", state);
      const target = new URL(config.authorizeUrl);
      target.searchParams.set("client_id", config.clientId);
      target.searchParams.set("redirect_uri", config.callbackUrl);
      target.searchParams.set("response_type", "code");
      target.searchParams.set("scope", "openid email profile");
      target.searchParams.set("state", state);
      target.searchParams.set("nonce", nonce);
      target.searchParams.set("code_challenge", challenge);
      target.searchParams.set("code_challenge_method", "S256");
      target.searchParams.set("identity_provider", config.providerName);
      location.assign(target);
    } catch (problem) {
      setError(problem.message);
      setStarting(false);
    }
  }

  return (
    <>
      <header className="site-header">
        <a className="brand" href="/"><span>PB</span><div><strong>Paper Badge</strong><small>SAML learning IdP</small></div></a>
        <div className="header-meta"><span>LOCAL ONLY</span><i />{config?.region ?? "eu-west-1"}</div>
      </header>
      {error ? <div className="top-error" role="alert">{error}</div> : null}
      {isCallback
        ? <CallbackView config={config} />
        : isSso
          ? request
            ? <LoginView request={request} />
            : <main className="loading-view"><p className="eyebrow">READING AUTHNREQUEST</p><h1>Opening the badge desk…</h1></main>
          : <WaitingView config={config} onStart={startSignIn} starting={starting} />}
      <footer><span>Built for stacksim</span><span>Demo key · pretend identities · real signatures</span></footer>
    </>
  );
}
