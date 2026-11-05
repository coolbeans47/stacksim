# StackSim Step Functions console guide

This guide explains every page in the StackSim Step Functions console: what each setting does, why you would use it in real AWS workloads, and how it maps to production AWS Step Functions behavior.

StackSim models Standard JSONPath state machines, Workflow Studio with Design, Code and Config modes, Parallel and Inline Map, retries and catches, common optimized service integrations, callbacks, Activities, nested workflows, durable typed history, and CloudWatch metrics. Express workflows, JSONata, versions, aliases, redrive, Distributed Map, Test state, AWS SDK integrations, HTTP tasks, and unlisted optimized integrations are unavailable. Where the AWS console has a control for one of these, the local console shows the same control disabled with a "Not available in StackSim" note, so the page layout matches AWS without accepting a setting that does nothing.

The pages follow the AWS console: the same navigation, tab names, button labels, and dialogs. StackSim adds some panels that AWS does not have; they are listed under [Local additions](#local-additions).

---

## How to read this guide

Each section follows the same pattern:

1. **What it is** — the console page and its main fields.
2. **Why use it** — the problem it solves in AWS.
3. **How it works in StackSim** — what is fully simulated versus reference-only.
4. **Common AWS use cases** — typical production scenarios.
5. **Example** — a concrete configuration when one helps.

---

## Console navigation

| Nav item | Route | Purpose |
|----------|-------|---------|
| **State machines** | `#/step-functions/state-machines` | State machine list and detail |
| **Executions** | `#/step-functions/executions` | Executions across all state machines (local addition) |
| **Activities** | `#/step-functions/activities` | Activity list, create, tags, and worker guidance |
| **Create state machine** | `#/step-functions/state-machines/create` | Shortcut to the create flow (local addition) |

| Page | Route |
|------|-------|
| State machine tabs | `#/step-functions/state-machines/{arn}/{executions\|monitoring\|logging\|definition\|aliases\|versions\|tags\|overview}` |
| Edit in Workflow Studio | `#/step-functions/state-machines/{arn}/edit` |
| Copy to new | `#/step-functions/state-machines/create/{arn}` |
| Execution details | `#/step-functions/state-machines/{arn}/executions/{executionArn}` |
| Execution details (short form) | `#/step-functions/executions/{executionArn}` |
| Activity details | `#/step-functions/activities/{arn}` |

Encode ARNs when constructing routes. A state machine opens on its **Executions** tab, as in AWS. Execution pages show the breadcrumb **Step Functions › State machines › {state machine} › {execution}**.

### CloudFormation and CDK deployments

CloudFormation stack **Resources** links state machines and Activities to their service details. A deployed resource's **CloudFormation deployment** panel links back to the exact originating stack ARN and shows its logical ID. This uses service-returned ownership tags; the browser does not read provider checkpoints or maintain a second resource catalog. Retained resources keep their origin tags even after stack deletion. A new same-name stack does not acquire them automatically, and general resource import/drift operations remain outside the platform's active support.

The state machine **Details** panel and the execution **Details** tab link the execution role to IAM. Definition and execution views link literal supported task targets to DynamoDB tables, SQS queues, SNS topics, EventBridge buses, nested workflows and Activity details. Dynamic targets remain labeled rather than inventing a resource link. Lambda cards link the function and its **Monitor** page, which resolves its configured CloudWatch log destination.

Use CDK or CloudFormation to update stack-owned definitions, roles and tags so the template remains consistent with service state. The tag editor excludes reserved `aws:` ownership tags. Updating a definition applies to subsequent executions; current executions keep their captured revision and role. Stack retention leaves the service resource; deletion prevents new starts without deleting existing execution snapshots and histories.

See the [provider contract](step-functions-cloudformation-contract.md) and [CDK lifecycle learning fixture](../examples/cdk-step-functions-lifecycle/README.md) for definition assets, substitutions, deployment authority, failed update/rollback and cleanup.

---

## State machines

### State machines list

A table with **Name**, **Type**, **Creation date**, **Status**, and **ARN**. Search by name or ARN, filter with the **Any type** dropdown, and select a row to enable **View details**, **Edit**, **Copy to new**, and **Delete**. **Create state machine** starts the create flow. When a search matches nothing the table says so and the heading shows "n of m".

#### How it works in StackSim

Standard JSONPath lifecycle, IAM authorization, tags, revisions, durable executions, `AWS/States` metrics, and the CloudFormation/CDK path are active. **Copy to new** opens the create flow with the selected state machine's definition, role, and tags. The ARN column is a local addition.

---

### Create state machine

1. **Choose a template** — **Create from blank** (a single Pass state) or **Create from template: Hello World** (Pass, Choice, Wait, Parallel, Success and Fail states; runs without any other resource). Enter the **State machine name** and choose **Continue**.
2. **Workflow Studio** opens in **Design** mode. Build the workflow, then check **Config**.
3. Choose **Create**. With **Create new role** selected, a **Confirm role creation** dialog shows the role name and its permissions; choose **Confirm**.
4. The state machine opens and the **Start execution** dialog is offered straight away.

#### Workflow Studio modes

| Mode | What it holds |
|------|---------------|
| **Design** | The **States browser** (tabs **Actions** and **Flow**, with a search box), the canvas, and the inspector |
| **Code** | The States Language JSON beside a **Graph visualization** that redraws as you type |
| **Config** | **Details**, **Permissions**, **Logging**, **Additional configuration**, **Tags** |

Design and Code edit the same document; switching modes round-trips it, and fields that Design does not edit are preserved. The mode bar carries **Actions** (**Export definition**, **Import definition**), **Validate**, **Cancel**, and **Create** (or **Save** when editing).

**States browser.** **Actions** lists the Task integrations StackSim runs: AWS Lambda Invoke, DynamoDB GetItem/PutItem/UpdateItem/DeleteItem, SQS SendMessage, SNS Publish, EventBridge PutEvents, Step Functions StartExecution, Run Activity, and a generic Task. **Flow** lists Choice, Parallel, Map, Pass, Wait, Success, and Fail. Click a state to add it after the selected state; a state added after a Choice becomes a new branch of that Choice. The **Patterns** tab and drag and drop are not available.

**Canvas.** A top-to-bottom graph with Start and End markers, labelled Choice branches, dashed Catch edges, loop edges, and Parallel branches and Map item processors drawn inside their state. States that nothing leads to are listed under **Unreachable states**. The toolbar has zoom in, zoom out, **Center**, **Full screen**, **Undo**, and **Redo**.

**Inspector.** Select a state to edit it. Tabs:

| Tab | Fields |
|-----|--------|
| **Configuration** | State name, Comment, the type's own settings (Resource and API Parameters for a Task, Choices and Default, Seconds, Result, Branches, ItemsPath and ItemProcessor, Error and Cause), Next state, **Set as StartAt**, **Delete state** |
| **Input** | InputPath; Parameters (Pass, Parallel); ItemSelector (Map) |
| **Output** | ResultSelector, ResultPath, OutputPath |
| **Error handling** | Retry and Catch (Task, Parallel, Map); TimeoutSeconds and HeartbeatSeconds (Task) |

The **Definition** toggle shows the selected state's JSON. State names can be any text up to 80 characters, including spaces and punctuation. **Test state** is shown disabled.

**Config.**

| Section | Setting |
|---------|---------|
| **Details** | State machine name; Type (Standard; Express disabled); query language (JSONPath; JSONata disabled) |
| **Permissions** | **Create new role** (recommended) or **Choose an existing role** with a role picker |
| **Logging** | Log level (disabled, OFF) |
| **Additional configuration** | Enable X-Ray tracing, Publish version on creation, customer managed key (all disabled) |
| **Tags** | Key and value rows, or **Edit as JSON** |

#### How it works in StackSim

**Create new role** creates an IAM role that trusts `states.amazonaws.com`, with an inline policy listing only the actions and resources the definition calls: `lambda:InvokeFunction` on named functions, the DynamoDB item action on named tables, `sqs:SendMessage`, `sns:Publish`, `events:PutEvents`, and `states:StartExecution` (plus `DescribeExecution` and `StopExecution` for `.sync`). A target read from state input at run time is granted on `*`. The role is created only after you confirm it.

**Validate** runs `ValidateStateMachineDefinition` and lists diagnostics with their location; Create and Save validate first. Names follow the AWS rule: up to 80 characters, no white space, brackets, wildcards, or the characters `" # % \ ^ | ~ ` $ & , ; : /`.

---

### State machine detail

Header: **Edit**, **Start execution**, **Actions** (**Copy to new**, **Export definition**, **Delete**; **Publish version** and **Create alias** disabled), and a direct **Delete** button.

The **Details** panel is shown above the tabs on every tab: ARN (with Copy), IAM role ARN (link to IAM), Type, Status, Creation date, Revision, Query language, Logging, X-Ray tracing. After an update in this browser session it also shows **Latest update**.

| Tab | Content |
|-----|---------|
| **Executions** | The executions table (below), then related Lambda functions and service integrations |
| **Monitoring** | Execution counts and execution-time figures computed from retained executions, with a link to CloudWatch |
| **Logging** | Log level OFF, with links to the Lambda functions' own logs |
| **Definition** | The saved code beside a read-only graph; **Export** and **Edit definition** |
| **Aliases** / **Versions** | Empty tabs with disabled **Create new alias** / **Publish new version** |
| **Tags** | Tag table and **Manage tags** |
| **Overview** | Execution count, workflow graph, related resources (local addition) |

#### Executions tab

Columns **Name**, **Status**, **Started**, **End time**, **Duration**. Search by name, filter by status, and select a row to enable **View details** and **Stop execution**. **Redrive** is shown disabled. The table pages at 20 rows. **Start execution** is also in the table header.

#### Start execution

**Name - optional** is prefilled with a generated ID; replace it to choose your own. **Input - optional** takes JSON and reports a JSON error under the field as you type. The execution captures the input together with the current definition revision and role.

#### Delete

Deleting asks you to type the state machine name. Existing executions keep their definition snapshots and histories and remain reachable by execution ARN.

---

## Executions

### Executions page

Lists executions across all state machines, newest first, with a **State machine** column, the same search, status filter, selection, **View details**, and **Stop execution**. AWS has no account-wide list; this page is a local addition.

### Execution details

Header: **Edit state machine**, **Start new execution** (prefilled with this execution's input), **Stop execution** while running, and **Actions** (**Export**; **Redrive** disabled). A running execution refreshes itself, quickly at first and then at a slower interval, for as long as it runs.

A failed or timed-out execution shows an error banner with the error, the **Cause**, and **View step details**, which selects the failing state.

**Execution summary** has three tabs:

| Tab | Content |
|-----|---------|
| **Details** | Execution status, type, ARN, state machine, IAM role ARN, start time, end time, duration, **State transitions**, definition revision, and error and cause when present |
| **Execution input and output** | Input and output side by side |
| **Definition** | The definition snapshot this execution started with |

**Execution inspection** has four views and a **Step details** panel:

| View | Content |
|------|---------|
| **Graph view** | The workflow graph coloured by result with a legend: Succeeded, Failed, Caught error, In progress, Cancelled, Not started. Zoom, **Center**, **Full screen** |
| **Table view** | Name, Type, Status, Resource, Started after, Duration, Events |
| **Event view** | 25 events per page: ID, Type, Step, Resource, Started after, Timestamp (to the millisecond), Previous. Choose an event type to expand its details in place. Category filter, text search, and forward or reverse order |
| **State view** | The states that ran, in the order they were entered |

Select a state in any view to see its **Step details**: **Input**, **Output**, **Details** (status, resource, started after, duration, error, cause, retry and catch policy), **Definition**, **Retry** (the policy and the attempts that failed), and **Events**. A state entered more than once has a **Visit** selector.

#### Stop execution

**Stop execution** opens a dialog with optional **Error** and **Cause**. Only what you enter is sent, so an execution stopped without them shows no error.

#### Why use it

Debug workflow logic, data flow, retries, and parallel branches without production logging.

#### How it works in StackSim

Complete paginated history, per-state input and output from the state entered and exited events, immutable definition snapshots per execution, 90-day default retention, restart recovery. Task tokens and credentials are redacted wherever history is shown.

#### Example input

```json
{"orderId": "123", "amount": 49.99}
```

---

## Activities

The Activities page lists name, ARN, and creation date and provides create and delete through the same public Step Functions actions as the SDK. **Create activity** takes a name and optional tags. Workers use `GetActivityTask`, `SendTaskHeartbeat`, `SendTaskSuccess`, and `SendTaskFailure`; task assignment, heartbeat deadlines, and completion survive restart. For responsive local shutdown and deterministic tests, an empty `GetActivityTask` poll returns after one second rather than AWS's longer bounded poll. The console shows only lease-safe guidance: worker names and raw task tokens are never rendered.

Select an Activity name for its ARN, creation date, encryption note, originating stack link, and tags with **Manage tags**. **Inspect execution histories** opens the Executions page. Already issued task tokens remain bound to their executions after Activity deletion; the console never displays them.

Nested `.sync` uses local durable execution polling, so its execution role needs `states:StartExecution` on the child state machine and `states:DescribeExecution`/`states:StopExecution` on child execution ARNs; it does not create AWS's managed EventBridge polling rule locally.

---

## Local additions

These are not in the AWS console and are kept alongside the AWS layout:

- The account-wide **Executions** page and the **Create state machine** navigation shortcut.
- The **ARN** column on the state machines list and the **Overview** tab.
- **Validate** in Workflow Studio, with located diagnostics; **Import definition**; the role picker that shows which local roles trust Step Functions.
- The **CloudFormation deployment** panel on stack-owned state machines and Activities.
- **Related Lambda functions** and **Related service integrations** cards, with callback and run-a-job markers.
- On execution details: **Failure summary**, **Retry-attempt timeline**, **Child executions**, **Branches and iterations**, the "Waiting for callback" marker, the event category filter and search, the **Previous** event column, "All typed details", and labels that distinguish an absent payload from one omitted by the request.
- Panel help ("?") with a support note on each main panel, and the **Unavailable settings** panel.

---

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| Workflow type | Standard JSONPath only |
| Task integrations | Lambda; DynamoDB item CRUD; SQS send/callback; SNS publish/callback; EventBridge put-events; nested workflows; Activities |
| Starting executions | Console, SDK and CLI; EventBridge rules; EventBridge Scheduler; API Gateway REST and HTTP API integrations |
| Callback recovery | Opaque single-use token digests, heartbeat/timeout deadlines, restart-safe resume |
| Express / JSONata | Unavailable; shown disabled |
| Versions / aliases / redrive / Test state | Unavailable; shown disabled |
| AWS SDK / HTTP / cross-account tasks | Unavailable and rejected by validation |
| Logging / X-Ray | Unavailable; shown disabled |
| Payload limit | 256 KiB per field |

---

## Related StackSim docs

- [Lambda console guide](./lambda-console-guide.md) — Task state targets
- [IAM console guide](./iam-console-guide.md) — execution roles and `iam:PassRole`
- [EventBridge console guide](./eventbridge-console-guide.md) — Scheduler Step Functions targets
- [CloudWatch console guide](./cloudwatch-console-guide.md) — `AWS/States` metrics
- [CloudFormation console guide](./cloudformation-console-guide.md) — state machine stacks
- [SQS console guide](./sqs-console-guide.md) — workflow handoff to queues
- [DynamoDB console guide](./dynamodb-console-guide.md) — orchestrate table workflows
- [Developer guide](./developer-guide.md) — workflow patterns
