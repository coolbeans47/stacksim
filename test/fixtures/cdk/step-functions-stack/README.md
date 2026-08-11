# Step Functions CDK fixture

This ordinary pinned TypeScript CDK application deploys an inline Lambda
function, its roles and policy, and an `aws-stepfunctions` Standard state
machine containing an `aws-stepfunctions-tasks.LambdaInvoke` task. It contains
no StackSim-specific construct or template rewrite.
