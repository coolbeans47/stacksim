# StackSim CloudWatch console guide

This guide explains every panel in the StackSim CloudWatch console: what each setting does, why you would use it in real AWS workloads, and how it maps to production Amazon CloudWatch behavior.

StackSim models metrics, alarms (metric, composite, log, anomaly), dashboards, log groups, Logs Insights, Contributor Insights, metric streams, anomaly detectors, and alarm mute rules locally. SNS alarm delivery, Firehose/S3 export, KMS encryption, and cross-account observability remain unavailable or dependency-blocked.

---

## How to read this guide

Each section follows the same pattern:

1. **What it is** — the console panel and its main fields.
2. **Why use it** — the problem it solves in AWS.
3. **How it works in StackSim** — what is fully simulated versus reference-only.
4. **Common AWS use cases** — typical production scenarios.
5. **Example** — a concrete configuration when one helps.

---

## Console navigation

| Nav item | Route |
|----------|-------|
| **Overview** | `#/cloudwatch` |
| **Dashboards** | `#/cloudwatch/dashboards` |
| **All alarms** | `#/cloudwatch/alarms` |
| **Alarm mute rules** | `#/cloudwatch/alarm-mute-rules` |
| **Anomaly detection** | `#/cloudwatch/anomaly-detection` |
| **All metrics** | `#/cloudwatch/metrics` |
| **Metrics Insights** | `#/cloudwatch/metrics-insights` |
| **Metric streams** | `#/cloudwatch/metric-streams` |
| **Contributor Insights** | `#/cloudwatch/contributor-insights` |
| **Log groups** | `#/cloudwatch/log-groups` |
| **Logs Insights** | `#/cloudwatch/logs-insights` |

---

## Overview

Summary cards: alarm count (in ALARM), metric count (namespaces), log group count — each with deep links.

---

## Dashboards

### List

Create, bulk delete, filter. Table: name, last modified, size.

### Detail

Time range, auto-refresh, dashboard variables, widget grid (metric, log, alarm, explorer, text). Edit mode: add widget, JSON source, save. Widget views: time series, single value, gauge, bar, pie, table.

#### Local boundaries

`GetMetricWidgetImage` unavailable; unsupported widget types flagged.

---

## Alarms

### All alarms

State summary filters (ALARM / OK / INSUFFICIENT_DATA). Table with type (Metric, Composite, Log). **Create alarm**, **Create log alarm**, **Create composite alarm**, **Create anomaly alarm**. Link to mute rules.

### Metric alarm detail

Metric preview, history, EventBridge sidebar, threshold or expected band (anomaly), tags. **Set state**, enable/disable actions, edit, delete.

### Composite alarm detail

Alarm rule JSON, suppressor configuration, child/parent alarm links.

### Log alarm detail

Scheduled Logs Insights query, contributors in ALARM, mute rule targets.

#### Alarm actions

Lambda actions execute locally. SNS, Auto Scaling, SSM, EC2 ARNs stored with dependency warnings. EventBridge publishes alarm state change events.

---

## Alarm mute rules

List with Active / Scheduled / Expired counts. Create/edit: cron or `at(...)` schedule, duration, timezone, target alarm names. Deleting an active rule replays ALARM actions for targeted alarms.

---

## Anomaly detection

Detector list with deterministic MAD model disclosure (not production ML). Detail: expected-value preview, excluded ranges, **Create alarm** (single metric). Create detector modal: metric or metric math, timezone, excluded ranges JSON.

---

## Metrics

### All metrics

Namespace filter, search, multi-select table. **Selected metrics graph** — period, statistic, time range, graph vs GetMetricData source. **Add to dashboard**.

---

## Metrics Insights

SQL query editor (bounded subset), default dataset banner, optional KMS key descriptor (files not encrypted). Results limited to last three hours. Chart/table/source views. **Dataset settings** modal.

Supported: `SELECT` aggregates, `FROM` namespace, `GROUP BY`, `ORDER BY`, `LIMIT`, dimension filters.

---

## Metric streams

List/detail with Firehose/S3 blocked banner. Local extension: `STACKSIM_ALLOW_LOCAL_FILES=true` and `file://` JSON destination. Filters, additional statistics, start/stop.

---

## Contributor Insights

Custom rules (CloudWatchLogRule JSON) and managed DynamoDB templates. Rule report with top contributors chart. PrivateLink templates unavailable.

---

## Logs Insights

Workbench: select log groups (≤50), time range, CWLI editor, sample queries. Results statistics, visualization, CSV export, @ptr **View record**. Query history and saved queries (PPL/SQL storable but not executable).

---

## Log groups

### List

Create group (name, retention). Table: name, retention, bytes.

### Overview tab

Details, related Lambda/API Gateway resources, tags, log streams table, create stream.

### Log stream detail

Events (newest 100), message filter, time range.

### Additional tabs

| Tab | Content |
|-----|---------|
| **Resource policy** | JSON policy; EventBridge template |
| **Metric filters** | Pattern → metric; test pattern |
| **Subscription filters** | Up to two Lambda destinations |
| **Data protection** | Unavailable (explicit) |
| **Transform** | Unavailable (explicit) |
| **Export data** | Local `file://` gzip when env flag set; S3 blocked |

---

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| Lambda alarm/subscription actions | Active |
| SNS / ASG / SSM / EC2 actions | Dependency-blocked |
| Metrics Insights window | Max 3 hours |
| Metric stream delivery | Local file extension only |
| Logs Insights | CWLI subset executed |
| Log export S3 | Blocked |
| Anomaly ML | Deterministic MAD |
| Cross-account | Unavailable |

---

## Related StackSim docs

- [Lambda console guide](./lambda-console-guide.md) — function logs and alarm targets
- [EventBridge console guide](./eventbridge-console-guide.md) — alarm events on default bus
- [SNS console guide](./sns-console-guide.md) — alarm action boundary
- [S3 console guide](./s3-console-guide.md) — export destination boundary
- [DynamoDB console guide](./dynamodb-console-guide.md) — Contributor Insights managed rules
- [API Gateway console guide](./apigateway-console-guide.md) — related log groups
- [Reference](./reference.md) — CloudWatch API summary
- [S3 console guide](./s3-console-guide.md) — log export destination boundary
- [SES console guide](./ses-console-guide.md) — SNS alarm action boundary
- [Step Functions console guide](./step-functions-console-guide.md) — workflow metrics
- [CloudFormation console guide](./cloudformation-console-guide.md) — observability stacks
