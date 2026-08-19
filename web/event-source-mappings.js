import { escapeHtml } from "./components.js";

function option(value, label, selected) { return `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`; }

export function eventSourceMappingForm({ sources = [], targets = [], mapping, selectedSourceArn, selectedFunctionName, roleArn, creating = true }) {
  const source = mapping?.EventSourceArn ?? selectedSourceArn ?? sources[0]?.arn ?? ""; const target = selectedFunctionName ?? mapping?.FunctionArn ?? targets[0]?.value ?? "";
  const pattern = mapping?.FilterCriteria?.Filters?.[0]?.Pattern ?? ""; const enabled = mapping?.State !== "Disabled";
  return `<div class="alert info"><strong>DynamoDB Streams trigger</strong><br>Lambda polls the stream four times per second, invokes this function with ordered batches, and checkpoints only after successful handling.</div>
    ${creating ? `<div class="field"><label>Function target</label><select name="functionName" required>${targets.map(item => option(item.value, item.label, target)).join("")}</select><span class="hint">A function, published version, or alias ARN can be the durable target.</span></div><div class="field"><label>DynamoDB table and stream</label><select name="eventSourceArn" required>${sources.map(item => option(item.arn, `${item.name} · ${item.view ?? "stream enabled"}`, source)).join("")}</select></div><div class="field"><label>Starting position</label><select name="startingPosition"><option value="LATEST">Latest</option><option value="TRIM_HORIZON">Trim horizon</option></select><span class="hint">Latest starts after current records. Trim horizon reads retained records from the beginning.</span></div>` : `<div class="detail-grid"><dl class="key-value"><dt>Function target</dt><dd class="mono">${escapeHtml(mapping?.FunctionArn ?? target)}</dd></dl><dl class="key-value"><dt>Event source</dt><dd class="mono">${escapeHtml(source)}</dd></dl></div>`}
    <div class="field"><label class="checkbox-label"><input type="checkbox" name="enabled" value="yes" ${enabled ? "checked" : ""}> Enable trigger</label><span class="hint">Turning a mapping off preserves its checkpoint.</span></div>
    <div class="field-row"><div class="field"><label>Batch size</label><input name="batchSize" type="number" min="1" max="10000" value="${mapping?.BatchSize ?? 10}" required></div><div class="field"><label>Batching window (seconds)</label><input name="batchWindow" type="number" min="0" max="300" value="${mapping?.MaximumBatchingWindowInSeconds ?? 0}" required><span class="hint">Set at least 1 second when batch size is over 10 and explicitly changed.</span></div></div>
    <div class="field-row"><div class="field"><label>Parallelization factor</label><input name="parallelization" type="number" min="1" max="10" value="${mapping?.ParallelizationFactor ?? 1}" required></div><div class="field"><label>Tumbling window (seconds)</label><input name="tumblingWindow" type="number" min="0" max="900" value="${mapping?.TumblingWindowInSeconds ?? 0}" required></div></div>
    <div class="field-row"><div class="field"><label>Maximum retry attempts</label><input name="retries" type="number" min="-1" max="10000" value="${mapping?.MaximumRetryAttempts ?? -1}" required><span class="hint">-1 retries until the record age limit.</span></div><div class="field"><label>Maximum record age (seconds)</label><input name="recordAge" type="number" min="-1" max="604800" value="${mapping?.MaximumRecordAgeInSeconds ?? -1}" required><span class="hint">Use -1 for no age limit; otherwise 60–604800.</span></div></div>
    <div class="field-row"><div class="field"><label class="checkbox-label"><input type="checkbox" name="bisect" value="yes" ${mapping?.BisectBatchOnFunctionError ? "checked" : ""}> Bisect batch on function error</label></div><div class="field"><label class="checkbox-label"><input type="checkbox" name="partial" value="yes" ${mapping?.FunctionResponseTypes?.includes("ReportBatchItemFailures") ? "checked" : ""}> Report partial batch item failures</label></div></div>
    <div class="field"><label>Filter pattern <span class="muted small">– optional JSON</span></label><textarea name="filterPattern" spellcheck="false" placeholder='{"dynamodb":{"NewImage":{"status":{"S":["READY"]}}}}'>${escapeHtml(pattern)}</textarea><span class="hint">DynamoDB filters may use only the dynamodb event key. Up to five filters are supported through the API.</span></div>
    <div class="alert warning"><strong>Execution-role permissions</strong><br>The target role <span class="mono">${escapeHtml(roleArn ?? "selected function role")}</span> needs DescribeStream, GetRecords, GetShardIterator, and ListStreams. Attach <span class="mono">AWSLambdaDynamoDBExecutionRole</span> when needed. SQS discarded-record destinations are supported through the SDK/API when the role also allows <span class="mono">sqs:SendMessage</span>; SNS and S3 remain unavailable.</div>`;
}

export function eventSourceMappingInput(data, creating = true) {
  const batchSize = Number(data.get("batchSize")); const batchWindow = Number(data.get("batchWindow")); const recordAge = Number(data.get("recordAge")); const retries = Number(data.get("retries"));
  if (batchSize > 10 && batchWindow < 1) throw new Error("Set the batching window to at least 1 second when batch size is greater than 10");
  if (recordAge !== -1 && (recordAge < 60 || recordAge > 604800)) throw new Error("Maximum record age must be -1 or between 60 and 604800 seconds");
  const pattern = String(data.get("filterPattern") ?? "").trim(); if (pattern) { let parsed; try { parsed = JSON.parse(pattern); } catch { throw new Error("Filter pattern must be valid JSON"); } if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.keys(parsed).some(key => key !== "dynamodb")) throw new Error("Filter pattern may only use the dynamodb event key"); }
  return {
    ...(creating ? { FunctionName: data.get("functionName"), EventSourceArn: data.get("eventSourceArn"), StartingPosition: data.get("startingPosition") } : {}),
    Enabled: data.get("enabled") === "yes", BatchSize: batchSize, MaximumBatchingWindowInSeconds: batchWindow,
    ParallelizationFactor: Number(data.get("parallelization")), TumblingWindowInSeconds: Number(data.get("tumblingWindow")),
    MaximumRetryAttempts: retries, MaximumRecordAgeInSeconds: recordAge, BisectBatchOnFunctionError: data.get("bisect") === "yes",
    FunctionResponseTypes: data.get("partial") === "yes" ? ["ReportBatchItemFailures"] : [], FilterCriteria: { Filters: pattern ? [{ Pattern: pattern }] : [] },
  };
}

export function sqsEventSourceMappingForm({ sources = [], targets = [], mapping, selectedSourceArn, selectedFunctionName, roleArn, creating = true }) {
  const source = mapping?.EventSourceArn ?? selectedSourceArn ?? sources[0]?.arn ?? ""; const target = selectedFunctionName ?? mapping?.FunctionArn ?? targets[0]?.value ?? "";
  const selectedQueue = sources.find(item => item.arn === source); const fifo = selectedQueue?.fifo ?? source.endsWith(".fifo"); const pattern = mapping?.FilterCriteria?.Filters?.[0]?.Pattern ?? ""; const enabled = mapping?.State !== "Disabled";
  return `<div class="alert info"><strong>SQS trigger</strong><br>Lambda polls the queue and deletes messages only after successful handling. Function errors and throttles leave messages available for retry after their visibility timeout.</div>
    ${creating ? `<div class="field"><label>Function target</label><select name="functionName" required>${targets.map(item => option(item.value, item.label, target)).join("")}</select><span class="hint">A function, published version, or alias ARN can be the durable target.</span></div><div class="field"><label>SQS queue</label><select name="eventSourceArn" required>${sources.map(item => option(item.arn, `${item.name}${item.fifo ? " · FIFO" : " · Standard"}`, source)).join("")}</select></div>` : `<div class="detail-grid"><dl class="key-value"><dt>Function target</dt><dd class="mono">${escapeHtml(mapping?.FunctionArn ?? target)}</dd></dl><dl class="key-value"><dt>Event source</dt><dd class="mono">${escapeHtml(source)}</dd></dl></div>`}
    <div class="field"><label class="checkbox-label"><input type="checkbox" name="enabled" value="yes" ${enabled ? "checked" : ""}> Enable trigger</label></div>
    <div class="field-row"><div class="field"><label>Batch size</label><input name="batchSize" type="number" min="1" max="${fifo ? 10 : 10000}" value="${mapping?.BatchSize ?? 10}" required></div><div class="field"><label>Batching window (seconds)</label><input name="batchWindow" type="number" min="0" max="${fifo ? 0 : 300}" value="${mapping?.MaximumBatchingWindowInSeconds ?? 0}" ${fifo ? "readonly" : ""} required></div></div>
    <div class="field-row"><div class="field"><label>Maximum concurrency (optional)</label><input name="maximumConcurrency" type="number" min="2" max="1000" value="${mapping?.ScalingConfig?.MaximumConcurrency ?? ""}" placeholder="Unbounded"></div><div class="field"><label class="checkbox-label"><input type="checkbox" name="partial" value="yes" ${mapping?.FunctionResponseTypes?.includes("ReportBatchItemFailures") ? "checked" : ""}> Report partial batch item failures</label></div></div>
    <div class="field"><label>Filter pattern <span class="muted small">– optional JSON</span></label><textarea name="filterPattern" spellcheck="false" placeholder='{"body":{"job":["ready"]}}'>${escapeHtml(pattern)}</textarea><span class="hint">The JSON pattern is matched against the SQS event record.</span></div>
    <div class="alert warning"><strong>Execution-role permissions</strong><br>The target role <span class="mono">${escapeHtml(roleArn ?? "selected function role")}</span> needs <span class="mono">sqs:ReceiveMessage</span>, <span class="mono">sqs:DeleteMessage</span>, <span class="mono">sqs:ChangeMessageVisibility</span>, and <span class="mono">sqs:GetQueueAttributes</span> on this queue.</div>`;
}

export function sqsEventSourceMappingInput(data, creating = true) {
  const batchSize = Number(data.get("batchSize")); const batchWindow = Number(data.get("batchWindow"));
  if (batchSize > 10 && batchWindow < 1) throw new Error("Set the batching window to at least 1 second when batch size is greater than 10");
  const maximum = String(data.get("maximumConcurrency") ?? "").trim(); const pattern = String(data.get("filterPattern") ?? "").trim();
  if (maximum && (Number(maximum) < 2 || Number(maximum) > 1000)) throw new Error("Maximum concurrency must be between 2 and 1000");
  if (pattern) { let parsed; try { parsed = JSON.parse(pattern); } catch { throw new Error("Filter pattern must be valid JSON"); } if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Filter pattern must be a JSON object"); }
  return {
    ...(creating ? { FunctionName: data.get("functionName"), EventSourceArn: data.get("eventSourceArn") } : {}),
    Enabled: data.get("enabled") === "yes", BatchSize: batchSize, MaximumBatchingWindowInSeconds: batchWindow,
    FunctionResponseTypes: data.get("partial") === "yes" ? ["ReportBatchItemFailures"] : [], FilterCriteria: { Filters: pattern ? [{ Pattern: pattern }] : [] },
    ...(creating ? (maximum ? { ScalingConfig: { MaximumConcurrency: Number(maximum) } } : {}) : { ScalingConfig: maximum ? { MaximumConcurrency: Number(maximum) } : {} }),
  };
}

export function isSqsEventSourceArn(arn = "") { return arn.includes(":sqs:"); }
export function queueNameFromArn(arn = "") { return arn.split(":").at(-1) || arn; }

export function streamNameFromArn(arn = "") { return arn.match(/:table\/([^/]+)\/stream\//)?.[1] ?? arn; }
