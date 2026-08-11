# Signal Relay showcase guide

This is a concise ten-minute walkthrough for presenting the SNS Routing Lab.

## 1. Establish the idea

Open the landing view and use the headline:

> The application publishes once. SNS makes four independent decisions.

Point out that the publisher knows one topic ARN. It does not know the Lambda function names or queue URL.

## 2. Show the CDK infrastructure

Open `app.ts` beside the application:

- one `sns.Topic`;
- three `LambdaSubscription` instances;
- one `SqsSubscription`;
- two attribute filter policies;
- one nested message-body filter;
- raw SQS delivery; and
- a redrive policy on every subscription.

Emphasize that these are normal CDK constructs.

## 3. Compare two seeded incidents

Select **Checkout authorization failures**. Its critical, payments and production values match every filtered subscription, and the audit subscription has no filter. All four routes are delivered.

Then select **Development preview unavailable**. It is low severity, storefront and development. All three filters reject it; only Audit archive receives it.

This is the most direct demonstration of SNS's role.

## 4. Publish an incident

Choose:

- Severity: `critical`
- Service: `identity`
- Environment: `staging`

Publish it once. Ask the audience to predict the result:

- Critical response: delivered
- Payments triage: filtered out
- Production watch: filtered out
- Audit archive: delivered

The route cards should settle to that exact state.

## 5. Explain delivery shapes

Open the route cards:

- Lambda subscribers receive `Records[].Sns`.
- The SQS audit subscription has `rawMessageDelivery: true`, so the queue body is the application's JSON rather than a wrapped SNS notification.

SQS is a subscriber here. SNS remains the router.

## 6. Inspect in the stacksim console

Open:

```text
http://127.0.0.1:4566/_stacksim/console
```

Visit SNS and inspect:

- topic attributes;
- four subscriptions;
- the two filter scopes;
- raw delivery;
- redrive policy; and
- the topic policy.

Then visit CloudFormation to show that the resources were deployed from the three ordinary CDK stacks.

## 7. Close with failure isolation

Every subscription owns independent delivery and redrive state. A filtered or failing subscriber does not roll back another subscriber's delivery and does not require the publisher to change.

That decoupling is the main reason SNS exists in this architecture.
