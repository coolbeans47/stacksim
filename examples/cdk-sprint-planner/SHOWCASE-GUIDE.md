# Sprint Planner showcase guide

This walkthrough demonstrates an ordinary CDK application using stacksim's complete supported local surface, including a CDK-owned Cognito user pool and browser app client.

## What to show

Start on the desktop Board at 1440×900. Point out the warm planning surface, active Sprint 08 goal and dates, story-point progress, four fixed lanes, live indicator, member avatars, priorities, points, assignees, and explicit **Move to…** controls. Open `SP-103` to show descriptions, acceptance criteria, comments, and immutable activity without hiding the board.

Resize to 390×844. The sidebar becomes bottom navigation, one lane appears at a time through accessible tabs, ticket details become a full-screen sheet, and the page has no document-level horizontal overflow. Reduced-motion preferences remove nonessential animation.

On **Backlog**, show that planning is a vertical work list instead of a squeezed fifth lane. On **Team**, show active members and administrator-only invitation delivery state. Members get a redacted roster and cannot see pending invitation emails.

## End-to-end story

1. The configured administrator signs up through the official browser Cognito client.
2. Cognito sends the confirmation code through the shared local SES Inbox.
3. A verified ID token claims the exact seeded bootstrap marker. The first registered user is never promoted automatically.
4. The administrator invites a teammate. Sprint Planner stores only the SHA-256 token digest; the raw token lives only in the SES message and hash route.
5. React removes the invitation fragment immediately, inspects it through the only unauthenticated application route, and locks the signup email.
6. The teammate confirms in Cognito and accepts membership with the verified matching ID-token email.
7. Both clients mint one-use 45-second WebSocket tickets. Cognito JWTs never enter a WebSocket URL.
8. Assign `SP-105` to the member, then move it. Both browsers converge live.
9. Race two moves from the same ticket/lane versions. Exactly one transaction succeeds; the other returns `409 BOARD_CONFLICT` and refetches.

## Architecture to call out

- The HTTP API uses a generic API Gateway v2 JWT authorizer with the canonical AWS-shaped Cognito issuer and public app-client audience. stacksim resolves the live pool keys in-process—there is no remote JWKS fallback.
- The application stack creates and owns the email-sign-in user pool and public client; CDK intrinsic references connect those resources to the authorizer, Lambdas, outputs, and browser runtime.
- DynamoDB strongly consistent subject binding plus membership is the authorization source, so member revocation is immediate even while a signed JWT remains cryptographically valid.
- Every meaningful mutation commits activity, idempotency, and outbox records with the domain write.
- Inserted outbox rows flow through a filtered DynamoDB stream mapping, publisher, one custom EventBridge bus/rule, broadcast Lambda, notification relay, Standard SQS queue, single-concurrency worker, SES templates, and separate failure queues.
- Dashboard, alarms, structured-log metric filters, and saved Logs Insights queries expose authorization denials, conflicts, invitation outcomes, queue/DLQ state, broadcast failures, and publication delay without logging bodies or secrets.

## Seed and lifecycle evidence

The deterministic seed has three sprints and exactly fifteen tickets: three completed, eight active, and four backlog. It adds three comments and fifteen activity records, but no outbox record, Cognito user, password, or fake bearer credential.

Run the deploy twice and the seed twice. Modify a seeded ticket between runs: the change survives. Add a user ticket: it survives. The explicit reset touches only known seed-owned records and preserves activated memberships and identity bindings.

Finally run `npm run destroy`. Describe the former pool to prove the
stack-owned pool/client/users were removed. The populated versioned website
bucket is retained intentionally because stacksim's bounded S3 CloudFormation
path has no general auto-delete helper; clean it separately after inspection.

## Evidence files

After an authenticated capture, the `screenshots/` directory contains desktop board, desktop ticket drawer, mobile board, and mobile team evidence. The capture uses ephemeral credentials from environment variables and writes no Playwright storage state or token artifact under the project.
