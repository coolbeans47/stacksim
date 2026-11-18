import { compileQuery, fail, fieldMapping, fieldValues, integer, keys, record, values, type Candidate, type Json } from "./query.js";

export function aggregate(spec: any, docs: Candidate[], depth = 0, schemas: Json[] = docs.map(doc => doc.mappings), budget = { buckets: 0, deadline: performance.now() + 30000 }): Json {
  if (spec === undefined) return {};
  if (depth > 12) fail("Aggregation nesting exceeds the local limit");
  record(spec, "aggregations");
  if (Object.keys(spec).length > 100) fail("Too many aggregations");
  const check = () => { if (performance.now() > budget.deadline) fail("Aggregation exceeded its local deadline", "timeout_exception", 408); };
  const bucket = () => { check(); if (++budget.buckets > 10000) fail("Aggregations exceed the local 10000 bucket limit", "too_many_buckets_exception"); };
  return Object.fromEntries(Object.entries<any>(spec).map(([name, definition]) => {
    check();
    record(definition, name);
    if (definition.aggs !== undefined && definition.aggregations !== undefined) fail("Specify either aggs or aggregations");
    const types = Object.keys(definition).filter(key => !["aggs", "aggregations", "meta"].includes(key));
    if (types.length !== 1) fail(`Aggregation [${name}] must specify one type`);
    const type = types[0]; const options = record(definition[type], type);
    const children = definition.aggs ?? definition.aggregations;
    if (children !== undefined) aggregate(children, [], depth + 1, schemas, budget);
    const validateField = (field: string) => {
      for (const schema of schemas) {
        const type = fieldMapping(schema, field).type;
        if (type === "text") fail(`Fielddata is disabled on text field [${field}]; use a keyword field`);
        if (["knn_vector", "nested", "object"].includes(type)) fail(`Field [${field}] does not support aggregations`);
      }
    };
    if (typeof options.field === "string") validateField(options.field);
    const items = (doc: Candidate) => { check(); return fieldValues(doc._source, options.field, doc.mappings); };
    const sub = (subset: Candidate[]) => aggregate(children, subset, depth + 1, schemas, budget);
    let result: Json;
    if (["min", "max", "sum", "avg", "stats", "value_count", "cardinality"].includes(type)) {
      keys(options, ["field", "missing", ...(type === "cardinality" ? ["precision_threshold"] : [])], type);
      if (children !== undefined) fail("Metric aggregations cannot have child aggregations");
      if (options.precision_threshold !== undefined) integer(options.precision_threshold, 3000, 0, 40000);
      if (typeof options.field !== "string") fail(`${type}.field is required`);
      const all = docs.flatMap(doc => { const found = items(doc); return found.length ? found : options.missing === undefined ? [] : [options.missing]; });
      if (type === "value_count") result = { value: all.length };
      else if (type === "cardinality") result = { value: new Set(all.map(item => JSON.stringify(item))).size };
      else {
        if (all.some(item => typeof item !== "number" || !Number.isFinite(item))) fail(`${type} requires numeric values`);
        const sum = all.reduce((a, b) => a + b, 0); const min = all.length ? all.reduce((a, b) => Math.min(a, b), Infinity) : null; const max = all.length ? all.reduce((a, b) => Math.max(a, b), -Infinity) : null;
        const stats = { count: all.length, min, max, avg: all.length ? sum / all.length : null, sum };
        result = type === "stats" ? stats : { value: stats[type as keyof typeof stats] };
      }
    } else if (type === "filter") {
      const predicate = compileQuery(options); const subset = docs.filter(doc => predicate(doc) !== null); result = { doc_count: subset.length, ...sub(subset) };
    } else if (type === "nested") {
      keys(options, ["path"], type); if (typeof options.path !== "string") fail("nested.path is required");
      if (schemas.some(schema => fieldMapping(schema, options.path).type !== "nested")) fail(`Path [${options.path}] is not mapped as nested`);
      const nested = docs.flatMap(doc => values(doc._source, options.path).map(value => { let source = value; for (const part of options.path.split(".").reverse()) source = { [part]: source }; return { ...doc, _source: source }; }));
      result = { doc_count: nested.length, ...sub(nested) };
    } else if (type === "terms") {
      keys(options, ["field", "size", "min_doc_count", "order", "missing", "include", "exclude"], type);
      if (typeof options.field !== "string") fail("terms.field is required");
      if ((options.include && !Array.isArray(options.include)) || (options.exclude && !Array.isArray(options.exclude))) fail("Only explicit include/exclude term arrays are implemented");
      const groups = new Map<string, { key: any; docs: Candidate[] }>();
      for (const doc of docs) {
        const found = items(doc); const unique = new Map((found.length ? found : options.missing === undefined ? [] : [options.missing]).map(value => [JSON.stringify(value), value]));
        for (const [key, value] of unique) {
          if (options.include && !options.include.includes(value) || options.exclude?.includes(value)) continue;
          if (!groups.has(key)) bucket();
          const group = groups.get(key) ?? { key: value, docs: [] }; group.docs.push(doc); groups.set(key, group);
        }
      }
      const order = options.order ?? { _count: "desc" }; if (Object.keys(order).length !== 1 || !["_key", "_count"].includes(Object.keys(order)[0]) || !["asc", "desc"].includes(Object.values(order)[0] as string)) fail("Only _key and _count term ordering is supported");
      const compare = (a: any, b: any) => a < b ? -1 : a > b ? 1 : 0;
      const sorted = [...groups.values()].filter(group => group.docs.length >= integer(options.min_doc_count, 1)).sort((a, b) => (order._key ? compare(a.key, b.key) : compare(a.docs.length, b.docs.length)) * (Object.values(order)[0] === "asc" ? 1 : -1) || compare(a.key, b.key));
      const size = integer(options.size, 10, 0, 1000);
      result = { doc_count_error_upper_bound: 0, sum_other_doc_count: sorted.slice(size).reduce((sum, group) => sum + group.docs.length, 0), buckets: sorted.slice(0, size).map(group => ({ key: group.key, doc_count: group.docs.length, ...sub(group.docs) })) };
    } else if (type === "range") {
      keys(options, ["field", "ranges", "keyed"], type);
      if (typeof options.field !== "string" || !Array.isArray(options.ranges) || options.ranges.length > 1000) fail("range requires a field and at most 1000 ranges");
      if (options.keyed !== undefined && typeof options.keyed !== "boolean") fail("range.keyed must be boolean");
      const buckets = options.ranges.map((range: Json) => {
        bucket();
        keys(record(range, "range"), ["key", "from", "to"], "range");
        if ([range.from, range.to].some(value => value !== undefined && (typeof value !== "number" || !Number.isFinite(value)))) fail("Aggregation range bounds must be finite numbers");
        const subset = docs.filter(doc => items(doc).some(value => (range.from === undefined || value >= range.from) && (range.to === undefined || value < range.to)));
        return { key: range.key ?? `${range.from ?? "*"}-${range.to ?? "*"}`, ...(range.from === undefined ? {} : { from: range.from }), ...(range.to === undefined ? {} : { to: range.to }), doc_count: subset.length, ...sub(subset) };
      });
      result = { buckets: options.keyed ? Object.fromEntries(buckets.map((bucket: Json) => [bucket.key, bucket])) : buckets };
    } else if (type === "date_histogram" || type === "histogram") {
      keys(options, type === "histogram" ? ["field", "interval", "min_doc_count", "extended_bounds"] : ["field", "fixed_interval", "calendar_interval", "min_doc_count", "extended_bounds", "time_zone", "format"], type);
      if (typeof options.field !== "string") fail(`${type}.field is required`);
      if (options.min_doc_count !== undefined) integer(options.min_doc_count, 0, 0, 50000);
      if (options.extended_bounds !== undefined) keys(record(options.extended_bounds, "extended_bounds"), ["min", "max"], "extended_bounds");
      if (type === "histogram" && (typeof options.interval !== "number" || !(options.interval > 0))) fail("histogram.interval must be a positive number");
      if (type === "date_histogram" && Number(options.fixed_interval !== undefined) + Number(options.calendar_interval !== undefined) !== 1) fail("date_histogram requires exactly one fixed_interval or calendar_interval");
      if (options.time_zone && !["UTC", "Z", "+00:00"].includes(options.time_zone)) fail("Only UTC date histogram time zones are implemented");
      if (options.format) fail("Custom histogram date formats are not implemented");
      const calendar = options.calendar_interval;
      if (calendar && !["month", "1M", "year", "1y", "day", "1d", "hour", "1h"].includes(calendar)) fail("Unsupported calendar interval");
      const fixed = options.fixed_interval ?? options.interval ?? "1d";
      const parsed = /^(\d+)(ms|s|m|h|d)$/.exec(String(fixed));
      const width = type === "histogram" ? Number(fixed) : parsed ? Number(parsed[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[parsed[2]] ?? 0) : 0;
      if (!calendar && (!(width > 0) || !Number.isFinite(width))) fail("Invalid histogram interval");
      const floor = (value: any) => {
        const n = type === "histogram" || typeof value === "number" ? value : Date.parse(value);
        if (!Number.isFinite(n)) fail("Invalid date/numeric histogram value");
        const date = new Date(n);
        return !calendar ? Math.floor(n / width) * width : ["month", "1M"].includes(calendar) ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) : ["year", "1y"].includes(calendar) ? Date.UTC(date.getUTCFullYear(), 0, 1) : Math.floor(n / (["day", "1d"].includes(calendar) ? 86400000 : 3600000)) * (["day", "1d"].includes(calendar) ? 86400000 : 3600000);
      };
      const next = (n: number) => !calendar ? n + width : ["month", "1M"].includes(calendar) ? Date.UTC(new Date(n).getUTCFullYear(), new Date(n).getUTCMonth() + 1, 1) : ["year", "1y"].includes(calendar) ? Date.UTC(new Date(n).getUTCFullYear() + 1, 0, 1) : n + (["day", "1d"].includes(calendar) ? 86400000 : 3600000);
      const groups = new Map<number, Candidate[]>();
      for (const doc of docs) for (const key of new Set(items(doc).map(floor))) { if (!groups.has(key)) { bucket(); groups.set(key, []); } groups.get(key)!.push(doc); }
      if ((options.min_doc_count ?? 0) === 0 && (groups.size || options.extended_bounds)) {
        const found = [...groups.keys()]; const start = options.extended_bounds?.min === undefined ? Math.min(...found) : floor(options.extended_bounds.min); const end = options.extended_bounds?.max === undefined ? Math.max(...found) : floor(options.extended_bounds.max);
        let n = start; let count = 0;
        while (n <= end) { if (++count > 10000) fail("Histogram exceeds 10000 buckets"); if (!groups.has(n)) { bucket(); groups.set(n, []); } n = next(n); }
      }
      result = { buckets: [...groups.entries()].sort(([a], [b]) => a - b).filter(([, group]) => group.length >= (options.min_doc_count ?? 0)).map(([key, group]) => ({ key, ...(type === "date_histogram" ? { key_as_string: new Date(key).toISOString() } : {}), doc_count: group.length, ...sub(group) })) };
    } else if (type === "composite") {
      keys(options, ["size", "sources", "after"], type);
      if (!Array.isArray(options.sources) || !options.sources.length || options.sources.length > 5) fail("Composite requires 1–5 sources");
      const sources = options.sources.map((source: Json) => {
        if (Object.keys(record(source, "source")).length !== 1) fail("Each source needs one name");
        const [name, value] = Object.entries<any>(source)[0]; keys(value, ["terms"], "composite source");
        keys(record(value.terms, "terms"), ["field", "order", "missing_bucket"], "composite terms");
        if (typeof value.terms.field !== "string") fail("Composite field is required");
        validateField(value.terms.field);
        if (value.terms.order !== undefined && !["asc", "desc"].includes(value.terms.order)) fail("Composite order must be asc or desc");
        if (value.terms.missing_bucket !== undefined && typeof value.terms.missing_bucket !== "boolean") fail("missing_bucket must be boolean");
        return { name, ...value.terms };
      });
      if (new Set(sources.map(source => source.name)).size !== sources.length) fail("Composite source names must be unique");
      if (options.after !== undefined) { keys(record(options.after, "after"), sources.map(source => source.name), "after"); if (sources.some(source => !Object.hasOwn(options.after, source.name))) fail("after requires every composite source"); }
      const groups = new Map<string, { key: Json; docs: Candidate[] }>();
      for (const doc of docs) {
        check();
        let combinations: Json[] = [{}];
        for (const source of sources) { const found = [...new Set(fieldValues(doc._source, source.field, doc.mappings))]; const values = found.length ? found : source.missing_bucket ? [null] : []; if (combinations.length * values.length > 1000) fail("Too many composite values per document"); combinations = combinations.flatMap(previous => values.map(value => ({ ...previous, [source.name]: value }))); }
        for (const [id, key] of new Map(combinations.map(key => [JSON.stringify(key), key]))) { if (!groups.has(id)) bucket(); const group = groups.get(id) ?? { key, docs: [] }; group.docs.push(doc); groups.set(id, group); }
      }
      const compare = (a: Json, b: Json) => { for (const source of sources) { const av = a[source.name], bv = b[source.name]; const n = av === bv ? 0 : av === null || av < bv ? -1 : 1; if (n) return n * (source.order === "desc" ? -1 : 1); } return 0; };
      const buckets = [...groups.values()].sort((a, b) => compare(a.key, b.key)).filter(group => !options.after || compare(group.key, options.after) > 0).slice(0, integer(options.size, 10, 1, 1000)).map(group => ({ key: group.key, doc_count: group.docs.length, ...sub(group.docs) }));
      result = { ...(buckets.length ? { after_key: buckets.at(-1)!.key } : {}), buckets };
    } else return fail(`Aggregation [${type}] is not implemented`);
    if (definition.meta !== undefined) result.meta = definition.meta;
    return [name, result];
  }));
}
