import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseCloudFormationYaml } from "../src/cloudformation/yaml.js";
import { ServerlessTransformError, expandServerlessTransform } from "../src/cloudformation/sam/index.js";

// Golden inputs and outputs are aws/serverless-application-model v1.115.0
// tests/translator fixtures (Apache-2.0; see test/fixtures/sam/LICENSE and NOTICE).
const fixtures = resolve("test", "fixtures", "sam");
// SAM's translator tests resolve AWS::Region as ap-southeast-1 (layers_with_intrinsics shows it).
const context = { region: "ap-southeast-1", partition: "aws", accountId: "123456789012" };

function input(name: string): Record<string, unknown> {
  return parseCloudFormationYaml(readFileSync(join(fixtures, "input", `${name}.yaml`), "utf8")) as Record<string, unknown>;
}

function output(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtures, "output", `${name}.json`), "utf8"));
}

/**
 * Normalize only what sam-transform-design.md allows to differ: REST
 * deployment hash suffixes (AWS hashes a Python repr) and their descriptions
 * (§3.4), and YAML 1.1 floats such as `2.0` that StackSim's reader keeps as
 * text where Python's YAML loader yields a number (§1.1).
 */
function normalize(value: unknown): unknown {
  const text = JSON.stringify(value)
    .replace(/([A-Za-z0-9]+Deployment)[0-9a-f]{10}\b/g, "$1HASH")
    .replace(/RestApi deployment id: [0-9a-f]{40}/g, "RestApi deployment id: HASH")
    .replace(/"(-?\d+\.\d+)"/g, (_match, decimal: string) => String(Number(decimal)));
  return sortKeys(JSON.parse(text));
}

/** Like SAM's deep_sort_lists, its translator tests treat lists as unordered. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortKeys(item)]));
  return value;
}

/** Fixtures whose every feature is implemented (SAM-02 through SAM-04): processed output equals SAM's. */
const EQUAL = [
  "implicit_api",
  "implicit_http_api",
  "explicit_api",
  "simpletable",
  "simpletable_with_sse",
  "simple_table_with_table_name",
  "simple_table_with_extra_tags",
  "globals_for_simpletable",
  "function_with_policy_templates",
  "function_managed_inline_policy",
  "function_with_tracing",
  "function_with_permissions_boundary",
  "function_with_role_path",
  "function_with_role_and_role_path",
  "api_with_method_settings",
  "api_with_xray_tracing",
  "api_with_stage_tags",
  "api_with_binary_media_types",
  "http_api_explicit_stage",
  // SAM-03: event sources, function URLs, and event invoke configs.
  "sqs",
  "sqs_with_scaling_config",
  "intrinsic_functions",
  "sns",
  "sns_sqs",
  "sns_existing_sqs",
  "sns_existing_other_subscription",
  "sns_intrinsics",
  "sns_outside_sqs",
  "sns_topic_outside_template",
  "function_with_sns_event_source_all_parameters",
  "function_with_fifo_topic_event",
  "s3",
  "s3_filter",
  "s3_create_remove",
  "s3_existing_lambda_notification_configuration",
  "s3_existing_other_notification_configuration",
  "s3_intrinsics",
  "s3_multiple_events_same_bucket",
  "s3_multiple_functions",
  "s3_with_condition",
  "s3_with_dependsOn",
  "eventbridgerule",
  "eventbridgerule_schedule_properties",
  "eventbridgerule_with_input_transformer",
  "eventbridgerule_with_retry_policy",
  "cloudwatchevent",
  "cloudwatchevent_intrinsics",
  "function_with_cw_event",
  "function_with_dlq",
  "function_with_event_bridge_rule_state",
  "cloudwatchlog",
  "cloudwatch_logs_with_ref",
  "no_implicit_api_with_serverless_rest_api_resource",
  "function_with_function_url_config",
  "function_with_function_url_config_conditions",
  "function_with_function_url_config_with_iam_authorization_type",
  "function_with_function_url_config_with_intrinsics",
  "function_with_function_url_config_without_cors_config",
  "function_with_event_dest",
  "function_with_event_dest_conditional",
  // SAM-04: versions and aliases, layers, state machines, API Auth, Cors, Models, and usage plans.
  "api_http_paths_with_if_condition", "api_http_paths_with_if_condition_no_value_else_case", "api_http_paths_with_if_condition_no_value_then_case",
  "api_http_with_default_iam_authorizer", "api_model_without_properties", "api_request_model", "api_request_model_openapi_3",
  "api_request_model_with_validator", "api_request_model_with_validator_openapi_3", "api_rest_auth_disable_default_function_permissions",
  "api_rest_paths_with_if_condition_openapi", "api_rest_paths_with_if_condition_openapi_no_value_else_case",
  "api_rest_paths_with_if_condition_openapi_no_value_then_case", "api_rest_paths_with_if_condition_swagger",
  "api_rest_paths_with_if_condition_swagger_no_value_else_case", "api_rest_paths_with_if_condition_swagger_no_value_then_case",
  "api_swagger_integration_with_ref_intrinsic_api_id", "api_swagger_integration_with_string_api_id", "api_with_any_method_in_swagger",
  "api_with_apikey_default_override", "api_with_apikey_required", "api_with_apikey_required_openapi_3", "api_with_apikey_source", "api_with_auth_all_maximum",
  "api_with_auth_all_maximum_openapi_3", "api_with_auth_all_minimum", "api_with_auth_all_minimum_openapi", "api_with_auth_no_default",
  "api_with_auth_with_default_scopes", "api_with_auth_with_default_scopes_openapi", "api_with_aws_account_blacklist", "api_with_aws_account_whitelist",
  "api_with_aws_iam_auth_overrides", "api_with_cors", "api_with_cors_and_apikey", "api_with_cors_and_apikey_defined_at_api_level",
  "api_with_cors_and_auth_no_preflight_auth", "api_with_cors_and_auth_preflight_auth", "api_with_cors_and_only_credentials_false",
  "api_with_cors_and_only_headers", "api_with_cors_and_only_maxage", "api_with_cors_and_only_methods", "api_with_cors_and_only_origins",
  "api_with_cors_no_definitionbody", "api_with_cors_openapi_3", "api_with_default_aws_iam_auth", "api_with_default_aws_iam_auth_and_no_auth_route",
  "api_with_identity_intrinsic", "api_with_if_conditional_with_resource_policy", "api_with_incompatible_stage_name", "api_with_ip_range_blacklist",
  "api_with_ip_range_whitelist", "api_with_method_aws_iam_auth", "api_with_open_api_version_2", "api_with_openapi_definition_body_no_flag",
  "api_with_request_parameters_openapi", "api_with_resource_policy", "api_with_resource_policy_global", "api_with_resource_policy_global_implicit",
  "api_with_source_vpc_blacklist", "api_with_source_vpc_whitelist", "api_with_swagger_and_openapi_with_auth", "api_with_swagger_authorizer_none",
  "api_with_swagger_authorizer_none_override_api_auth", "api_with_usageplans", "api_with_usageplans_intrinsics", "api_with_usageplans_shared_attributes_three",
  "api_with_usageplans_shared_attributes_two", "api_with_usageplans_shared_no_side_effect_1", "api_with_usageplans_shared_no_side_effect_2", "basic_layer",
  "basic_state_machine_with_tags", "event_bridge_rule_super_long_id", "function_with_alias", "function_with_alias_all_properties_and_code_sha256",
  "function_with_alias_and_code_sha256", "function_with_alias_intrinsics", "function_with_alias_valid_names", "function_with_alias_version_deletion_policy",
  "function_with_aliasallproperties_and_lambda_layer_publishversion_false", "function_with_aliasallproperties_and_lambda_layer_publishversion_true",
  "function_with_global_layers", "function_with_globals_tags_and_propagate_tags", "function_with_layers", "function_with_many_layers",
  "function_with_request_parameters", "function_with_resource_refs", "global_handle_path_level_parameter", "http_api_custom_iam_auth", "http_api_def_uri",
  "http_api_global_iam_auth_enabled", "http_api_global_iam_auth_enabled_with_existing_conflicting_authorizer", "http_api_lambda_auth",
  "http_api_lambda_auth_full", "http_api_lambda_auth_with_permissions_resource", "http_api_local_iam_auth_enabled",
  "http_api_local_iam_auth_enabled_with_existing_conflicting_authorizer", "http_api_multiple_authorizers", "implicit_http_api_auth_and_simple_case",
  "layer_deletion_policy_precedence", "layer_version_depends_on", "layers_all_properties", "layers_with_intrinsics", "schema_validation_1",
  "schema_validation_4", "serverless_statemachine_eventbridgerule_with_input_transformer", "state_machine_with_api",
  "state_machine_with_api_and_propagate_tags", "state_machine_with_api_auth_default_scopes", "state_machine_with_api_authorizer",
  "state_machine_with_api_authorizer_maximum", "state_machine_with_api_combination", "state_machine_with_api_resource_policy", "state_machine_with_api_single",
  "state_machine_with_condition", "state_machine_with_cwe", "state_machine_with_definition_S3_object", "state_machine_with_definition_S3_string",
  "state_machine_with_definition_substitutions", "state_machine_with_eb_dlq", "state_machine_with_eb_dlq_generated", "state_machine_with_eb_dlq_target_id",
  "state_machine_with_eb_retry_policy", "state_machine_with_event_schedule_state", "state_machine_with_explicit_api", "state_machine_with_implicit_api",
  "state_machine_with_implicit_api_globals", "state_machine_with_inline_definition", "state_machine_with_inline_definition_intrinsics",
  "state_machine_with_inline_policies", "state_machine_with_managed_policy", "state_machine_with_null_events", "state_machine_with_permissions_boundary",
  "state_machine_with_role", "state_machine_with_role_path", "state_machine_with_sam_policy_templates", "state_machine_with_schedule_cloudwatch_event",
  "state_machine_with_schedule_cloudwatch_event_target_id", "state_machine_with_schedule_role", "state_machine_with_schedule_target_id",
  "state_machine_with_standard_logging", "state_machine_with_tags", "state_machine_with_xray_policies", "state_machine_with_xray_role",
  "version_deletion_policy_precedence",
];

for (const name of EQUAL) {
  test(`SAM golden fixture ${name} expands exactly as the SAM translator does`, () => {
    assert.deepEqual(normalize(expandServerlessTransform(input(name), context)), normalize(output(name)));
  });
}

/** Fixtures that use features owned by a later phase or a non-goal fail explicitly. */
const BOUNDARY: Array<[string, RegExp]> = [
  ["globals_for_function", /'Globals' section is invalid\. 'VpcConfig' in 'Function' is not supported by StackSim\./],
  ["basic_function", /Resource with id \[CompleteFunction\] is invalid\. Property 'VpcConfig' is not supported by StackSim\./],
  ["function_with_events_and_propagate_tags", /Property 'DeploymentPreference' is not supported by StackSim\./],
  ["all_policy_templates", /Policy template '[A-Za-z0-9]+' is not supported by StackSim because it targets a service StackSim does not implement\./],
  ["streams", /Event with id \[MyKinesisStream\] is invalid\. Event type 'Kinesis' is not supported by StackSim\..*Event type 'MSK' is not supported by StackSim\./],
  ["eventbridgerule_with_dlq", /Event with id \[ScheduleV2\] is invalid\. Event type 'ScheduleV2' is not supported by StackSim\./],
  ["function_with_metrics_config", /Event with id \[DynamoDBStreamEvent\] is invalid\. Property 'MetricsConfig' is not supported by StackSim\./],
  ["error_consumer_group_id", /Event with id \[DDBEvent\] is invalid\. Property 'ConsumerGroupId' is not supported by StackSim\./],
  // SAM-04 boundaries: features StackSim does not model fail explicitly.
  ["state_machine_with_schedule", /Event with id \[ScheduleV2\] is invalid\. Event type 'ScheduleV2' is not supported by StackSim\./],
  ["state_machine_with_express_logging", /Resource with id \[StateMachine\] is invalid\. Type 'EXPRESS' is not supported by StackSim: Step Functions in StackSim supports STANDARD state machines only\./],
  ["state_machine_with_auto_publish_alias", /Resource with id \[MyStateMachine\] is invalid\. Property 'AutoPublishAlias' is not supported by StackSim\./],
  ["state_machine_with_condition_and_events", /A Condition on an AWS::Serverless::StateMachine with Api or HttpApi events is not supported by StackSim\./],
  ["function_with_alias_and_event_sources", /Event with id \[IoTRule\] is invalid\. Event type 'IoTRule' is not supported by StackSim\..*Event type 'Kinesis' is not supported by StackSim\./],
  ["api_with_basic_custom_domain", /'Globals' section is invalid\. 'Domain' in 'Api' is not supported by StackSim\./],
  ["api_with_merge_definitions_null_paths", /Resource with id \[WebhooksApi\] is invalid\. Property 'MergeDefinitions' is not supported by StackSim\./],
  ["function_with_event_dest_s3_bucket", /EventInvokeConfig destinations of Type 'S3Bucket' are not supported by StackSim\./],
  ["layer_with_s3_object_storage_mode", /'StorageMode' in 'ContentUri' is not supported by StackSim\./],
  ["function_with_s3_object_storage_mode", /'StorageMode' in 'CodeUri' is not supported by StackSim\./],
  ["embedded_connectors_sns_to", /Resource with id \[MySNSTopic\] is invalid\. Attribute 'Connectors' is not supported by StackSim \(owning phase: SAM-06\)\./],
  ["error_version_deletion_policy_without_auto_publish_alias", /Property 'DeploymentPreference' is not supported by StackSim\./],
  ["error_function_with_no_alias_provisioned_concurrency", /Property 'DeploymentPreference' is not supported by StackSim\./],
];

for (const [name, pattern] of BOUNDARY) {
  test(`SAM golden fixture ${name} fails with its owning-phase boundary`, () => {
    assert.throws(() => expandServerlessTransform(input(name), context), (error: unknown) => {
      assert.ok(error instanceof ServerlessTransformError);
      assert.match(error.message, /^Transform AWS::Serverless-2016-10-31 failed with: Invalid Serverless Application Specification document\. Number of errors found: \d+\. /);
      assert.match(error.message, pattern);
      return true;
    });
  });
}

/** SAM's translator tests sort causes by the logical ID they name before comparing; StackSim keeps template order. */
function sortedCauses(causes: readonly string[]): string[] {
  const key = (cause: string) => /^(?:Resource|Event) with id \[([^\]]*)\]/.exec(cause)?.[1] ?? "";
  return [...causes].sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0);
}

/** SAM's own error fixtures: the message matches the translator's errorMessage. */
for (const name of [
  "error_function_with_unknown_policy_template",
  "error_function_policy_template_with_missing_parameter",
  // SAM-03
  "error_s3_not_in_template",
  "error_function_invalid_s3_event",
  "error_s3_bucket_invalid_properties",
  "error_s3_lambda_configuration_invalid_type",
  "error_depends_on_invalid_types",
  "error_multiple_resource_errors",
  "error_sns_intrinsics",
  "error_missing_queue",
  "error_missing_stream",
  "error_event_filtering",
  "error_function_with_invalid_event_bridge_rule",
  "error_function_with_invalid_schedule_event",
  "error_function_with_cwe_both_dlq_property_provided",
  "error_function_with_cwe_invalid_dlq_type",
  "error_function_with_cwe_missing_dlq_property",
  "error_function_with_event_bridge_rule_dlq_intrinsic_function",
  "error_function_with_schedule_both_dlq_property_provided",
  "error_function_with_schedule_invalid_dlq_type",
  "error_function_with_schedule_missing_dlq_property",
  "error_function_with_schedue_dlq_intrinsic_function",
  "error_function_with_function_url_config_with_invalid_cors_parameter",
  "error_function_with_function_url_config_with_invalid_cors_parameter_data_type",
  "error_function_with_function_url_config_with_no_authorization_type",
  "error_function_event_destination_fn_if_malformed",
  // SAM-04
  "error_api_auth_invalid_path_item", "error_api_auth_null_path_item", "error_api_authorizer_property_indentity_header_with_invalid_type",
  "error_api_authorizer_property_indentity_with_invalid_type", "error_api_invalid_auth", "error_api_invalid_auth_identity_cognito",
  "error_api_invalid_auth_identity_lambda_request", "error_api_invalid_definitionbody", "error_api_invalid_definitionuri",
  "error_api_invalid_event_authorizer_type", "error_api_invalid_openapi_path", "error_api_invalid_openapi_path_with_invalid_responses",
  "error_api_invalid_openapi_path_with_string_responses", "error_api_invalid_path", "error_api_invalid_request_model", "error_api_invalid_security",
  "error_api_invalid_source_vpc_blacklist", "error_api_invalid_source_vpc_whitelist", "error_api_invalid_usage_plan",
  "error_api_override_api_auth_without_authorizer", "error_api_request_model_with_intrinsics_validator", "error_api_request_model_with_strings_validator",
  "error_api_securitydefinitions_not_dict", "error_api_with_cors_and_empty_allow_origin", "error_api_with_invalid_auth_scopes_openapi",
  "error_api_with_invalid_if_condition_swagger", "error_api_with_invalid_open_api_version_type", "error_api_with_models_of_invalid_type",
  "error_api_with_usage_plan_invalid_parameter", "error_cors_credentials_true_with_wildcard_origin", "error_cors_credentials_true_without_explicit_origin",
  "error_cors_on_external_swagger", "error_default_authorizer_should_be_string_in_api", "error_function_fnsub_in_auto_publish_hash",
  "error_function_invalid_autopublishalias", "error_function_invalid_autopublishalias_allproperties", "error_function_invalid_autopublishalias_name",
  "error_function_invalid_layer", "error_function_invalid_request_parameters", "error_function_with_api_key_false", "error_function_with_event_dest_invalid",
  "error_function_with_method_auth_and_no_api_auth", "error_http_api_event_invalid_api", "error_http_api_invalid_auth",
  "error_http_api_invalid_event_authorizer_type", "error_http_api_invalid_lambda_auth", "error_http_api_list_route_settings", "error_http_api_null_method",
  "error_http_api_with_invalid_auth_while_method_auth_is_none", "error_http_api_with_invalid_jwt_configuration", "error_implicit_http_api_auth_any_method",
  "error_invalid_cors_dict", "error_invalid_method_definition", "error_layer_invalid_properties", "error_null_method_definition",
  "error_resource_policy_not_dict", "error_resource_policy_not_dict_empty_api", "error_state_machine_definition_string",
  "error_state_machine_invalid_s3_object", "error_state_machine_invalid_s3_string", "error_state_machine_with_api_auth_none",
  "error_state_machine_with_api_intrinsics", "error_state_machine_with_cwe_both_dlq_property_provided", "error_state_machine_with_cwe_invalid_dlq_type",
  "error_state_machine_with_cwe_missing_dlq_property", "error_state_machine_with_eb_dlq_generated_intrinsic_function",
  "error_state_machine_with_invalid_default_authorizer", "error_state_machine_with_invalid_schedule_event", "error_state_machine_with_no_api_authorizers",
  "error_state_machine_with_schedule_both_dlq_property_provided", "error_state_machine_with_schedule_dlq_generated_intrinsic_function",
  "error_state_machine_with_schedule_invalid_dlq_type", "error_state_machine_with_schedule_missing_dlq_property",
  "error_state_machine_with_undefined_api_authorizer", "error_swagger_security_definitions_not_dict", "error_swagger_security_not_dict",
  "error_swagger_security_not_dict_with_api_key_required",
]) {
  test(`SAM error fixture ${name} reports the translator's message`, () => {
    const expected = (output(name) as { errorMessage: string }).errorMessage;
    assert.throws(() => expandServerlessTransform(input(name), context), (error: unknown) => {
      assert.ok(error instanceof ServerlessTransformError);
      assert.equal(new ServerlessTransformError(sortedCauses(error.causes)).message, `Transform AWS::Serverless-2016-10-31 failed with: ${expected}`);
      return true;
    });
  });
}
