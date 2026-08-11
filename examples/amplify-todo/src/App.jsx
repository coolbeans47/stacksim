import { useCallback, useEffect, useMemo, useState } from "react";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";

const filters = ["all", "open", "done"];

function messageFrom(error) {
  if (Array.isArray(error?.errors) && error.errors.length) {
    return error.errors.map((item) => item.message).join("; ");
  }
  return error?.message ?? "The request could not be completed.";
}

function SetupCard({ detail }) {
  return (
    <main className="setup-shell">
      <section className="setup-card">
        <span className="eyebrow">Backend source is ready</span>
        <h1>Deploy the Amplify sandbox</h1>
        <p>
          The Todo model and pinned Amplify Gen 2 CLI are included. Start
          StackSim with its Amplify listener, then deploy the checked-in
          backend.
        </p>
        <div className="setup-command">
          <span>Next command</span>
          <code>npm run deploy</code>
        </div>
        <p className="setup-detail">{detail}</p>
      </section>
    </main>
  );
}

function TodoRow({ todo, busy, onToggle, onDelete }) {
  const due = todo.dueAt ? new Date(todo.dueAt) : null;
  return (
    <li className={todo.completed ? "todo-row is-done" : "todo-row"}>
      <button
        className="check-button"
        type="button"
        aria-label={
          todo.completed ? `Mark ${todo.title} open` : `Complete ${todo.title}`
        }
        disabled={busy}
        onClick={() => onToggle(todo)}
      >
        <span aria-hidden="true">{todo.completed ? "✓" : ""}</span>
      </button>
      <div className="todo-copy">
        <div className="todo-title-line">
          <strong>{todo.title}</strong>
          {todo.priority != null && (
            <span className={`priority priority-${todo.priority}`}>
              P{todo.priority}
            </span>
          )}
        </div>
        {todo.description && <p>{todo.description}</p>}
        <div className="todo-meta">
          {due && <span>Due {due.toLocaleDateString()}</span>}
          <span>Updated {new Date(todo.updatedAt).toLocaleString()}</span>
        </div>
      </div>
      <button
        className="delete-button"
        type="button"
        disabled={busy}
        onClick={() => onDelete(todo)}
      >
        Delete
      </button>
    </li>
  );
}

export default function App() {
  const [client, setClient] = useState(null);
  const [configuration, setConfiguration] = useState({
    state: "loading",
    detail: "Looking for amplify_outputs.json…",
  });
  const [todos, setTodos] = useState([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [busyIds, setBusyIds] = useState(new Set());
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("2");
  const [dueAt, setDueAt] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/amplify_outputs.json", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("No generated Amplify outputs were found yet.");
        const output = await response.json();
        if (!output?.data?.url || !output?.data?.api_key)
          throw new Error(
            "The generated output does not contain the Todo Data configuration.",
          );
        Amplify.configure(output);
        if (active) {
          setClient(generateClient());
          setConfiguration({ state: "ready", detail: output.data.url });
        }
      })
      .catch((cause) => {
        if (active) setConfiguration({ state: "setup", detail: cause.message });
      });
    return () => {
      active = false;
    };
  }, []);

  const loadTodos = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError("");
    try {
      const result = await client.models.Todo.list();
      if (result.errors?.length) throw result;
      setTodos(
        [...result.data].sort((left, right) =>
          String(right.createdAt).localeCompare(String(left.createdAt)),
        ),
      );
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (!client) return undefined;
    loadTodos();
    const refresh = () => loadTodos();
    const failed = (cause) => setError(messageFrom(cause));
    const subscriptions = [
      client.models.Todo.onCreate().subscribe({ next: refresh, error: failed }),
      client.models.Todo.onUpdate().subscribe({ next: refresh, error: failed }),
      client.models.Todo.onDelete().subscribe({ next: refresh, error: failed }),
    ];
    return () =>
      subscriptions.forEach((subscription) => subscription.unsubscribe());
  }, [client, loadTodos]);

  const visibleTodos = useMemo(
    () =>
      todos.filter((todo) => {
        if (filter === "open") return !todo.completed;
        if (filter === "done") return Boolean(todo.completed);
        return true;
      }),
    [filter, todos],
  );

  const setBusy = (id, value) =>
    setBusyIds((current) => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });

  const createTodo = async (event) => {
    event.preventDefault();
    if (!title.trim() || !client) return;
    setError("");
    try {
      const result = await client.models.Todo.create({
        title: title.trim(),
        description: description.trim() || null,
        priority: Number(priority),
        completed: false,
        dueAt: dueAt ? new Date(`${dueAt}T12:00:00`).toISOString() : null,
      });
      if (result.errors?.length) throw result;
      setTitle("");
      setDescription("");
      setDueAt("");
      await loadTodos();
    } catch (cause) {
      setError(messageFrom(cause));
    }
  };

  const toggleTodo = async (todo) => {
    setBusy(todo.id, true);
    setError("");
    try {
      const result = await client.models.Todo.update({
        id: todo.id,
        completed: !todo.completed,
      });
      if (result.errors?.length) throw result;
      await loadTodos();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(todo.id, false);
    }
  };

  const deleteTodo = async (todo) => {
    setBusy(todo.id, true);
    setError("");
    try {
      const result = await client.models.Todo.delete({ id: todo.id });
      if (result.errors?.length) throw result;
      await loadTodos();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(todo.id, false);
    }
  };

  if (configuration.state !== "ready")
    return <SetupCard detail={configuration.detail} />;

  const openCount = todos.filter((todo) => !todo.completed).length;
  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <span className="eyebrow">Amplify Data · StackSim</span>
          <h1>Make space for what matters.</h1>
          <p>
            A small realtime Todo list, deployed from the Amplify Gen 2 CLI.
          </p>
        </div>
        <div className="status-card">
          <span className="live-dot" />
          <div>
            <strong>Backend connected</strong>
            <small>
              {openCount} open {openCount === 1 ? "task" : "tasks"}
            </small>
          </div>
        </div>
      </header>

      <section className="workspace">
        <form className="composer" onSubmit={createTodo}>
          <span className="section-label">New task</span>
          <label>
            <span>What needs doing?</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
              required
              placeholder="Ship the first sandbox"
            />
          </label>
          <label>
            <span>Notes</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows="3"
              placeholder="Keep it small and specific"
            />
          </label>
          <div className="form-row">
            <label>
              <span>Priority</span>
              <select
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
              >
                <option value="1">P1 · High</option>
                <option value="2">P2 · Normal</option>
                <option value="3">P3 · Low</option>
              </select>
            </label>
            <label>
              <span>Due date</span>
              <input
                type="date"
                value={dueAt}
                onChange={(event) => setDueAt(event.target.value)}
              />
            </label>
          </div>
          <button className="primary-button" type="submit">
            Add task <span aria-hidden="true">→</span>
          </button>
        </form>

        <section className="list-panel">
          <div className="list-toolbar">
            <div>
              <span className="section-label">Your tasks</span>
              <h2>
                {loading
                  ? "Syncing…"
                  : `${visibleTodos.length} ${visibleTodos.length === 1 ? "item" : "items"}`}
              </h2>
            </div>
            <div className="filter-group" aria-label="Filter tasks">
              {filters.map((name) => (
                <button
                  className={filter === name ? "active" : ""}
                  type="button"
                  key={name}
                  onClick={() => setFilter(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <strong>{error}</strong>
              {error === "A network error has occurred." && (
                <p>
                  Follow the setup and troubleshooting steps in the README, then
                  reload this page.
                </p>
              )}
            </div>
          )}
          {!loading && visibleTodos.length === 0 ? (
            <div className="empty-state">
              <span>✓</span>
              <h3>Nothing here yet</h3>
              <p>Add a task or choose another filter.</p>
            </div>
          ) : (
            <ul className="todo-list">
              {visibleTodos.map((todo) => (
                <TodoRow
                  key={todo.id}
                  todo={todo}
                  busy={busyIds.has(todo.id)}
                  onToggle={toggleTodo}
                  onDelete={deleteTodo}
                />
              ))}
            </ul>
          )}
        </section>
      </section>
      <footer>
        <span>Configuration</span>
        <code>{configuration.detail}</code>
      </footer>
    </main>
  );
}
