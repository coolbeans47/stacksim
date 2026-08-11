output "api_url" {
  description = "Local URL for the notes endpoint."
  value       = "${aws_apigatewayv2_api.notes.api_endpoint}/notes"
}

output "dynamodb_table_name" {
  description = "Name of the DynamoDB table used by the Lambda function."
  value       = aws_dynamodb_table.notes.name
}

output "lambda_function_name" {
  description = "Name of the Lambda function behind the HTTP API."
  value       = aws_lambda_function.api.function_name
}
