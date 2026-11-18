import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDownUp,
  ArrowRight,
  Backpack,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Database,
  Headphones,
  Layers3,
  LoaderCircle,
  Monitor,
  Plus,
  Search,
  SlidersHorizontal,
  Star,
  Trash2,
  X,
} from "lucide-react";

const categories = ["Audio", "Desk", "Travel", "Cameras"];
const icons = {
  Audio: Headphones,
  Desk: Monitor,
  Travel: Backpack,
  Cameras: Camera,
};
const initialFilters = {
  q: "",
  category: "",
  maxPrice: "",
  inStock: false,
  sort: "relevance",
  page: 1,
};
const blankProduct = {
  title: "",
  description: "",
  category: "Audio",
  price: "49",
  rating: "4.5",
  inStock: true,
};
const money = (value) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 2,
  }).format(value);

async function request(path, options = {}) {
  if (!__SEARCH_API__)
    throw new Error(
      "This build is not connected. Run npm run deploy to configure the API.",
    );
  const response = await fetch(`${__SEARCH_API__}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    signal: options.signal ?? AbortSignal.timeout(20000),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.message || `Request failed (${response.status}).`);
  return body;
}

function Dialog({ title, label, onClose, children, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "dialog wide" : "dialog"}
      aria-labelledby={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id={label}>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function ProductEditor({ product, onClose, onSaved }) {
  const [form, setForm] = useState(product ? { ...product } : blankProduct);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmDelete, setConfirmDelete] = useState(false);
  const change = (event) =>
    setForm((previous) => ({
      ...previous,
      [event.target.name]:
        event.target.type === "checkbox"
          ? event.target.checked
          : event.target.value,
    }));
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const { title, description, category, price, rating, inStock } = form;
    try {
      await request(
        product ? `/products/${encodeURIComponent(product.id)}` : "/products",
        {
          method: product ? "PUT" : "POST",
          body: JSON.stringify({
            title,
            description,
            category,
            price: Number(price),
            rating: Number(rating),
            inStock,
          }),
        },
      );
      onSaved(
        product
          ? "Product updated and refreshed in OpenSearch."
          : "Product indexed. Clear any filters to find it in the catalog.",
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await request(`/products/${encodeURIComponent(product.id)}`, {
        method: "DELETE",
      });
      onSaved("Product deleted from OpenSearch.");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={product ? "Edit product" : "Add a product"}
      label="editor-title"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="dialog-intro">
        Save a document to the <code>catalog</code> index. Changes are refreshed
        before the next search.
      </p>
      <form onSubmit={save}>
        <fieldset disabled={busy} className="editor-fields">
          <label>
            Product name
            <input
              name="title"
              value={form.title}
              onChange={change}
              required
              maxLength={100}
              autoFocus
            />
          </label>
          <label>
            Description
            <textarea
              name="description"
              value={form.description}
              onChange={change}
              required
              maxLength={600}
              rows={3}
            />
          </label>
          <label>
            Category
            <select name="category" value={form.category} onChange={change}>
              {categories.map((category) => (
                <option key={category}>{category}</option>
              ))}
            </select>
          </label>
          <div className="field-row">
            <label>
              Price (£)
              <input
                name="price"
                type="number"
                min="0"
                max="10000"
                step="0.01"
                required
                value={form.price}
                onChange={change}
              />
            </label>
            <label>
              Rating (0–5)
              <input
                name="rating"
                type="number"
                min="0"
                max="5"
                step="0.1"
                required
                value={form.rating}
                onChange={change}
              />
            </label>
          </div>
          <label className="check-label">
            <input
              name="inStock"
              type="checkbox"
              checked={form.inStock}
              onChange={change}
            />{" "}
            In stock
          </label>
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {confirmDelete && (
          <div className="delete-confirm">
            <p>Delete “{product.title}” from the index?</p>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={remove}
            >
              Confirm delete
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
            >
              Keep product
            </button>
          </div>
        )}
        <div className="dialog-actions">
          {product && !confirmDelete && (
            <button
              type="button"
              className="text-button delete"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={16} /> Delete product
            </button>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {busy && <LoaderCircle size={16} className="spin" />}{" "}
            {product ? "Save changes" : "Index product"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Inspector({ data, onClose }) {
  const [tab, setTab] = useState("request");
  return (
    <Dialog
      title="Inside the search"
      label="inspector-title"
      onClose={onClose}
      wide
    >
      <p className="dialog-intro">
        The actual request and response from the last completed search, sent by
        Lambda using the official OpenSearch client.
      </p>
      <div className="query-explainer">
        <p>
          <strong>Match</strong> Text searches title and description; title has
          a 3× boost.
        </p>
        <p>
          <strong>Filter</strong> Price and stock narrow matches. Category uses{" "}
          <code>post_filter</code> so other category counts remain visible.
        </p>
        <p>
          <strong>Rank</strong> Sort by relevance, price or rating, with a
          stable ID tie-breaker. Local relevance is simplified, not Lucene
          scoring.
        </p>
      </div>
      <div className="code-toolbar">
        <div role="tablist" aria-label="Query details">
          {["request", "response"].map((value) => (
            <button
              key={value}
              role="tab"
              id={`${value}-tab`}
              aria-controls="query-panel"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
            >
              {value === "request" ? "Request DSL" : "Response JSON"}
            </button>
          ))}
        </div>
        <code>POST /{data.index}/_search</code>
      </div>
      <pre
        id="query-panel"
        role="tabpanel"
        aria-labelledby={`${tab}-tab`}
        tabIndex={0}
      >
        {JSON.stringify(data[tab], null, 2)}
      </pre>
    </Dialog>
  );
}

export default function App() {
  const [filters, setFilters] = useState(initialFilters),
    [draft, setDraft] = useState("");
  const [data, setData] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [revision, setRevision] = useState(0),
    [editor, setEditor] = useState(null),
    [inspector, setInspector] = useState(false),
    [notice, setNotice] = useState(""),
    [seeding, setSeeding] = useState(false);
  const update = (patch) =>
    setFilters((previous) => ({ ...previous, ...patch, page: 1 }));
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timeout = setTimeout(
      () => controller.abort(new Error("Search timed out. Try again.")),
      20000,
    );
    request(
      `/search?${new URLSearchParams({ ...filters, inStock: String(filters.inStock), page: String(filters.page) })}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((failure) => {
        if (failure.name !== "AbortError") setError(failure.message);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (
          !controller.signal.aborted ||
          controller.signal.reason?.name !== "AbortError"
        )
          setLoading(false);
      });
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [filters, revision]);
  const clear = () => {
    setFilters(initialFilters);
    setDraft("");
  };
  const search = (value) => {
    setDraft(value);
    update({ q: value.trim() });
  };
  const seed = async () => {
    setSeeding(true);
    setNotice("");
    try {
      const result = await request("/seed", { method: "POST" });
      setNotice(
        `${result.created} samples added. ${result.skipped} existing products preserved.`,
      );
      setRevision((value) => value + 1);
    } catch (failure) {
      setNotice(failure.message);
    } finally {
      setSeeding(false);
    }
  };
  const hits = data?.response.hits.hits ?? [],
    total = data?.response.hits.total.value ?? 0;
  const counts = Object.fromEntries(
    (data?.response.aggregations.categories.buckets ?? []).map((bucket) => [
      bucket.key,
      bucket.doc_count,
    ]),
  );
  const active =
    filters.q || filters.category || filters.maxPrice || filters.inStock;
  const pages = Math.max(1, Math.ceil(total / 6));
  return (
    <>
      <header className="site-header">
        <a className="brand" href="./">
          <span className="brand-mark">
            <Layers3 size={21} />
          </span>
          fieldwork
          <span className="brand-divider" />
          <span className="lab-label">OpenSearch Lab</span>
        </a>
        <span className="runtime-badge">
          <span /> Embedded in StackSim
        </span>
      </header>
      <main id="main" className="shell">
        <section className="hero">
          <div>
            <p className="eyebrow">A SMALL CATALOG. A REAL SEARCH WORKFLOW.</p>
            <h1>
              Good finds start
              <br />
              with a little curiosity.
            </h1>
            <p className="hero-copy">
              Explore everyday essentials, then explore the query behind them.
            </p>
          </div>
          <div className="architecture">
            <div className="architecture-icon">
              <Search size={30} strokeWidth={1.5} />
            </div>
            <p>
              From a search box
              <br />
              to a search index.
            </p>
            <div>
              <span>React</span>
              <ArrowRight size={12} />
              <span>Lambda</span>
              <ArrowRight size={12} />
              <strong>OpenSearch</strong>
            </div>
            <small>CDK deployed · locally simulated · no Docker</small>
          </div>
        </section>
        <section className="search-section" aria-label="Search products">
          <form
            className="search-box"
            onSubmit={(event) => {
              event.preventDefault();
              search(draft);
            }}
          >
            <Search size={22} aria-hidden="true" />
            <input
              aria-label="Search products"
              placeholder="Try wireless, travel, or something for your desk…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={200}
            />
            {draft && (
              <button
                type="button"
                className="icon-button"
                aria-label="Clear search text"
                onClick={() => search("")}
              >
                <X size={18} />
              </button>
            )}
            <button className="primary" type="submit">
              Search <ArrowRight size={16} />
            </button>
          </form>
          <div className="suggestions">
            <span>Try a search</span>
            {["wireless", "travel", "camera"].map((value) => (
              <button key={value} onClick={() => search(value)}>
                {value}
                <ArrowRight size={12} />
              </button>
            ))}
          </div>
        </section>
        <div className="catalog-heading">
          <div>
            <span className="eyebrow">THE COLLECTION</span>
            <h2>Thoughtfully indexed.</h2>
          </div>
          <button className="secondary" onClick={() => setEditor({})}>
            <Plus size={17} /> Add product
          </button>
        </div>
        {notice && (
          <div className="notice" role="status">
            <Check size={17} />
            <span>{notice}</span>
            <button
              className="icon-button"
              aria-label="Dismiss message"
              onClick={() => setNotice("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="catalog-layout">
          <aside className="filters" aria-label="Search filters">
            <div className="filter-heading">
              <h3>
                <SlidersHorizontal size={16} /> Filters
              </h3>
              <button
                className="text-button"
                onClick={clear}
                disabled={!active}
              >
                Reset
              </button>
            </div>
            <fieldset>
              <legend>Category</legend>
              <label className="category-option">
                <input
                  type="radio"
                  name="category"
                  checked={!filters.category}
                  onChange={() => update({ category: "" })}
                />
                <span>All products</span>
              </label>
              {categories.map((category) => {
                const Icon = icons[category];
                return (
                  <label className="category-option" key={category}>
                    <input
                      type="radio"
                      name="category"
                      checked={filters.category === category}
                      onChange={() => update({ category })}
                    />
                    <Icon size={15} />
                    <span>{category}</span>
                    <small>
                      {loading || error ? "—" : (counts[category] ?? 0)}
                    </small>
                  </label>
                );
              })}
            </fieldset>
            <div className="filter-group">
              <label htmlFor="max-price">Maximum price</label>
              <select
                id="max-price"
                value={filters.maxPrice}
                onChange={(event) => update({ maxPrice: event.target.value })}
              >
                <option value="">Any price</option>
                <option value="50">Up to £50</option>
                <option value="100">Up to £100</option>
                <option value="200">Up to £200</option>
              </select>
            </div>
            <div className="filter-group">
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={filters.inStock}
                  onChange={(event) =>
                    update({ inStock: event.target.checked })
                  }
                />{" "}
                In stock only
              </label>
            </div>
            <div className="index-note">
              <Database size={18} />
              <strong>One index. Many possibilities.</strong>
              <p>
                Text matching, filters and category counts all come from
                OpenSearch.
              </p>
              <code>catalog</code>
              <button className="text-button" disabled={seeding} onClick={seed}>
                {seeding ? "Loading…" : "Load sample data"}
                <Plus size={13} />
              </button>
              <small>Adds missing samples. Keeps your edits.</small>
            </div>
          </aside>
          <section
            className="results"
            aria-label="Search results"
            aria-busy={loading}
          >
            <div className="results-toolbar">
              <p role="status">
                {loading ? (
                  "Searching…"
                ) : error ? (
                  "Search unavailable"
                ) : (
                  <>
                    <strong>{total}</strong>{" "}
                    {total === 1 ? "result" : "results"}
                    {filters.q && (
                      <>
                        {" "}
                        for <strong>“{filters.q}”</strong>
                      </>
                    )}
                  </>
                )}
              </p>
              <div>
                <ArrowDownUp size={14} />
                <label className="sr-only" htmlFor="sort">
                  Sort results
                </label>
                <select
                  id="sort"
                  value={filters.sort}
                  onChange={(event) => update({ sort: event.target.value })}
                >
                  <option value="relevance">Relevance</option>
                  <option value="price-asc">Price: low to high</option>
                  <option value="price-desc">Price: high to low</option>
                  <option value="rating">Highest rated</option>
                </select>
              </div>
            </div>
            {active && (
              <div className="active-filters">
                {filters.category && (
                  <button onClick={() => update({ category: "" })}>
                    {filters.category}
                    <X size={12} />
                  </button>
                )}
                {filters.maxPrice && (
                  <button onClick={() => update({ maxPrice: "" })}>
                    Up to {money(Number(filters.maxPrice))}
                    <X size={12} />
                  </button>
                )}
                {filters.inStock && (
                  <button onClick={() => update({ inStock: false })}>
                    In stock
                    <X size={12} />
                  </button>
                )}
              </div>
            )}
            {error ? (
              <div className="empty-state" role="alert">
                <Search size={30} />
                <h3>Search could not complete</h3>
                <p>{error}</p>
                <button
                  className="secondary"
                  onClick={() => setRevision((value) => value + 1)}
                >
                  Try again
                </button>
              </div>
            ) : loading ? (
              <div className="product-grid" aria-hidden="true">
                {Array.from({ length: 6 }, (_, index) => (
                  <div className="skeleton" key={index} />
                ))}
              </div>
            ) : hits.length ? (
              <div className="product-grid">
                {hits.map((hit) => {
                  const product = hit._source,
                    Icon = icons[product.category] || Monitor;
                  return (
                    <article className="product-card" key={hit._id}>
                      <button
                        className={`product-art ${product.category.toLowerCase()}`}
                        aria-label={`Edit ${product.title}`}
                        onClick={() => setEditor(product)}
                      >
                        <span className="art-ring" />
                        <Icon size={63} strokeWidth={1.15} />
                        <span className="art-caption">
                          FIELDWORK / {product.category.toUpperCase()}
                        </span>
                      </button>
                      <div className="product-content">
                        <div className="product-meta">
                          <span>{product.category}</span>
                          <span>
                            <Star size={12} fill="currentColor" />
                            {product.rating.toFixed(1)}
                          </span>
                        </div>
                        <h3>
                          <button onClick={() => setEditor(product)}>
                            {product.title}
                          </button>
                        </h3>
                        <p>{product.description}</p>
                        <div className="product-bottom">
                          <strong>{money(product.price)}</strong>
                          <span
                            className={
                              product.inStock ? "stock" : "stock unavailable"
                            }
                          >
                            <i />
                            {product.inStock ? "In stock" : "Out of stock"}
                          </span>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state">
                <Search size={32} />
                <h3>
                  {total ? "No products on this page" : "No finds this time."}
                </h3>
                <p>
                  {data?.indexedCount
                    ? "Try another word or give your filters a little more room."
                    : "Load the sample catalog or add your first product."}
                </p>
                <button
                  className="secondary"
                  onClick={data?.indexedCount ? clear : seed}
                >
                  {data?.indexedCount
                    ? "Clear search and filters"
                    : "Load sample data"}
                </button>
              </div>
            )}
            {!loading && !error && total > 0 && (
              <nav className="pagination" aria-label="Result pages">
                <span>
                  Page {filters.page} of {pages}
                </span>
                <div>
                  <button
                    className="icon-button"
                    aria-label="Previous page"
                    disabled={filters.page <= 1}
                    onClick={() =>
                      setFilters((previous) => ({
                        ...previous,
                        page: previous.page - 1,
                      }))
                    }
                  >
                    <ChevronLeft size={19} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Next page"
                    disabled={filters.page >= pages}
                    onClick={() =>
                      setFilters((previous) => ({
                        ...previous,
                        page: previous.page + 1,
                      }))
                    }
                  >
                    <ChevronRight size={19} />
                  </button>
                </div>
              </nav>
            )}
            <div className="query-strip">
              <Code2 size={21} />
              <div>
                <strong>Curious how this search works?</strong>
                <p>
                  {data && !loading && !error
                    ? `${data.indexedCount} indexed documents · ${data.response.took} ms reported by OpenSearch`
                    : "Inspect the request DSL and the actual response."}
                </p>
              </div>
              <button
                className="text-button"
                disabled={!data || loading || !!error}
                onClick={() => setInspector(true)}
              >
                View query
                <ArrowRight size={15} />
              </button>
            </div>
          </section>
        </div>
        <footer>
          <span>
            <Layers3 size={15} /> Built to explore, powered by StackSim.
          </span>
          <span>React → API Gateway → Lambda → embedded OpenSearch</span>
        </footer>
      </main>
      {editor && (
        <ProductEditor
          product={editor.id ? editor : null}
          onClose={() => setEditor(null)}
          onSaved={(message) => {
            setEditor(null);
            setNotice(message);
            setRevision((value) => value + 1);
          }}
        />
      )}
      {inspector && data && (
        <Inspector data={data} onClose={() => setInspector(false)} />
      )}
    </>
  );
}
