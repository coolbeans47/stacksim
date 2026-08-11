"use strict";

const {
  DescribeExecutionCommand,
  DescribeStateMachineCommand,
  GetExecutionHistoryCommand,
  ListExecutionsCommand,
  SFNClient,
  StartExecutionCommand,
  StopExecutionCommand,
} = require("@aws-sdk/client-sfn");

const sfn = new SFNClient({});
const stateMachineArn = process.env.STATE_MACHINE_ARN;
const stateMachineName = process.env.STATE_MACHINE_NAME;

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "Content-Type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "cache-control": "no-store",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 });
  }
}

function executionArn(event) {
  const raw = event.pathParameters?.executionArn;
  if (!raw) throw Object.assign(new Error("executionArn is required."), { statusCode: 400 });
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizeExecution(value) {
  return {
    executionArn: value.executionArn,
    stateMachineArn: value.stateMachineArn,
    name: value.name,
    status: value.status,
    startDate: value.startDate,
    stopDate: value.stopDate,
    input: value.input ? JSON.parse(value.input) : undefined,
    output: value.output ? JSON.parse(value.output) : undefined,
    error: value.error,
    cause: value.cause,
  };
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod || event.requestContext?.http?.method || "GET";
    const path = event.path || event.rawPath || "/";

    if (method === "OPTIONS") return response(204, {});

    if (method === "GET" && path.endsWith("/system")) {
      const machine = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn }));
      return response(200, {
        release: process.env.RELEASE,
        mode: "STANDARD",
        stateMachine: {
          arn: machine.stateMachineArn,
          name: machine.name || stateMachineName,
          roleArn: machine.roleArn,
          revisionId: machine.revisionId,
          definition: JSON.parse(machine.definition),
        },
      });
    }

    if (method === "GET" && path.endsWith("/executions")) {
      const result = await sfn.send(new ListExecutionsCommand({
        stateMachineArn,
        maxResults: 25,
      }));
      return response(200, {
        executions: (result.executions || []).map(normalizeExecution),
      });
    }

    if (method === "POST" && path.endsWith("/executions")) {
      const input = parseBody(event);
      const name = `order-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const started = await sfn.send(new StartExecutionCommand({
        stateMachineArn,
        name,
        input: JSON.stringify(input),
      }));
      return response(202, {
        executionArn: started.executionArn,
        startDate: started.startDate,
        name,
      });
    }

    if (method === "GET" && path.endsWith("/history")) {
      const result = await sfn.send(new GetExecutionHistoryCommand({
        executionArn: executionArn(event),
        includeExecutionData: true,
        maxResults: 1000,
      }));
      return response(200, { events: result.events || [] });
    }

    if (method === "POST" && path.endsWith("/stop")) {
      const arn = executionArn(event);
      const stopped = await sfn.send(new StopExecutionCommand({
        executionArn: arn,
        error: "OperatorStopped",
        cause: "Stopped from OrderFlow Observatory.",
      }));
      return response(200, { executionArn: arn, stopDate: stopped.stopDate });
    }

    if (method === "GET" && event.pathParameters?.executionArn) {
      const result = await sfn.send(new DescribeExecutionCommand({
        executionArn: executionArn(event),
      }));
      return response(200, normalizeExecution(result));
    }

    return response(404, { error: "Route not found." });
  } catch (error) {
    console.error(error);
    return response(error.statusCode || 500, {
      error: error.name || "InternalError",
      message: error.message || "Unexpected error.",
    });
  }
};
