# Sprint Planner

Sprint Planner is a collaborative Jira-style showcase deployed entirely through ordinary AWS CDK v2 to stacksim. It provisions DynamoDB, Lambda, API Gateway HTTP and WebSocket APIs, EventBridge, Standard SQS queues and DLQs, SES, CloudWatch, IAM, a Cognito email user pool and public app client, and a versioned S3 website.

The application opens with one deterministic Northstar Product workspace, one active sprint, planning and completed sprint history, fifteen tickets, comments, activity, a pending bootstrap administrator, accessible drag-and-drop, conflict-safe moves, live updates, invitations, and asynchronous notifications.

## stacksim compatibility note

stacksim's bounded `AWS::S3::Bucket` CloudFormation provider accepts only
`BlockPublicAcls` and `IgnorePublicAcls` inside
`PublicAccessBlockConfiguration`. CDK also synthesizes
`BlockPublicPolicy` and `RestrictPublicBuckets` when they are explicitly false.
The website stack therefore narrows that generated property to the supported
pair while retaining a bounded, anonymous, read-only `s3:GetObject` policy.
No application behavior is lost.

## Prerequisites

- Node.js 22.13 or newer
- a built, running stacksim (IAM enforcement is the default)
- the fresh-install IAM access key ID `admin` and secret `password`, associated with `user/admin` (or your saved rotated client credentials); the reduced bootstrap is automatic

Do not create the bootstrap administrator in Cognito at this stage. After
deployment, use the Sprint Planner sign-up screen with the exact
`bootstrapAdmin.email` from `config/local.json`, retrieve its confirmation code
from the local SES Inbox, confirm the account, and claim administrator access.
An administrator-created Cognito user with a temporary password is not required.

## Configure

```bash
cd examples/cdk-sprint-planner
npm install
cp config/local.example.json config/local.json
```

Edit `config/local.json` with the exact local account, Region, endpoints,
bootstrap administrator email/display name, and application sender email. The
application stack creates the Cognito pool and client, so no identity-resource
IDs belong in configuration. This file is ignored. It rejects credentials,
passwords, tokens, codes, client secrets, non-loopback endpoints, and unknown
fields.

## Deploy

```bash
npm run deploy
```

The first run deploys the data and placeholder website stacks, then the application stack. The SES sender initially remains pending. Open the verification message in the local SES Inbox, verify it, and rerun `npm run deploy`. The resumable run seeds the workspace, publishes final public runtime configuration, redeploys only the website, and exercises the complete outbox → EventBridge → relay → SQS → worker smoke path.

The command writes `.runtime/deployment.json`, including the stack outputs for
the generated pool and public client. It contains only public identifiers and
resource names—never credentials, passwords, codes, invitation/WebSocket
tickets, or user tokens. After deployment, `npm run check:cognito` verifies the
owned pool, client, and local JWKS.

## Work with the showcase

1. Open the printed website URL and create the configured bootstrap administrator Cognito account.
2. Read its six-digit confirmation code in the local SES Inbox and confirm.
3. Sign in and claim administrator access. Exact verified-email matching is required.
4. Open **Team**, invite a second email, and follow its hash-route link.
5. Sign up and confirm the invited user, accept membership, then open both sessions to see live assignment and board moves.
6. As the administrator, open a ticket and choose any active teammate from the **Assignee** list. The current assignee can use the same list to reassign or unassign the ticket.

Administrators can create, edit, assign, plan, archive, and manage sprints/team invitations. Members see the whole shared board, comment, move only their assigned active-sprint tickets, and reassign tickets they currently own. Other members see the assignee without an editable control. Lambda and current DynamoDB membership enforce every rule.

## Verify

```bash
npm run build
npm test
npm run smoke
```

`npm run seed` is idempotent and never overwrites changed or user-created records. `npm run seed -- --reset-demo` is the explicit bounded reset for known seed-owned data. It refuses unsafe references and never changes Cognito or unrelated application records.

If an outbox record exhausts stream retries:

```bash
npm run replay:outbox -- --event-id <exact-event-id>
```

The replay command reads the exact pending record, invokes the publisher with a key-only operator envelope, retains the original event identity/body, waits for publication, and removes only its matching failure receipt.

## Destroy

```bash
npm run destroy
```

Destroy removes the App and Data resources according to their policies,
including the Cognito pool, app client, and users owned by
`SprintPlannerAppStack`. The populated versioned website bucket and SES Inbox
history are retained. Inspect and empty/delete the retained website bucket
separately when you no longer need it.
