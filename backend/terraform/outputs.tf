output "api_gateway_url" {
  description = "Base URL for the langext REST API — paste into extension Settings > API Endpoint and vocabulary-app/.env.local as VITE_API_BASE_URL"
  value       = "${aws_api_gateway_stage.prod.invoke_url}"
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID"
  value       = aws_cognito_user_pool.main.id
}

output "cognito_admin_group_name" {
  description = "Cognito group required for ADMIN-only endpoints"
  value       = aws_cognito_user_group.admin.name
}

output "cognito_hosted_ui_domain" {
  description = "Cognito Hosted UI base URL — use as VITE_COGNITO_DOMAIN"
  value       = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "cognito_extension_client_id" {
  description = "App Client ID for the Chrome Extension"
  value       = aws_cognito_user_pool_client.extension.id
}

output "cognito_vocabapp_client_id" {
  description = "App Client ID for the Vocabulary Web App — use as VITE_COGNITO_CLIENT_ID"
  value       = aws_cognito_user_pool_client.vocabapp.id
}

output "cloudfront_domain" {
  description = "CloudFront domain for the vocab app — set VITE_REDIRECT_URI=https://<domain>/callback"
  value       = "https://${aws_cloudfront_distribution.vocab_app.domain_name}"
}

output "s3_bucket_name" {
  description = "S3 bucket hosting the vocabulary web app"
  value       = aws_s3_bucket.vocab_app.bucket
}

output "dynamodb_table_name" {
  description = "DynamoDB table name"
  value       = aws_dynamodb_table.phrases.name
}

output "llm_prompts_table_name" {
  description = "DynamoDB table containing server-managed LLM prompts"
  value       = aws_dynamodb_table.llm_prompts.name
}

output "explain_endpoint_url" {
  description = "ADMIN-only explain endpoint URL"
  value       = "${aws_api_gateway_stage.prod.invoke_url}/explain"
}

output "next_steps" {
  description = "Post-deploy configuration summary"
  value       = <<-EOT

  ╔══════════════════════════════════════════════════════════════╗
  ║              langext deployment complete                     ║
  ╠══════════════════════════════════════════════════════════════╣
  ║  Extension login (PKCE via chrome.identity)                  ║
  ║  1. Load the unpacked extension in Chrome                    ║
  ║  2. Copy its ID from chrome://extensions                     ║
  ║  3. Add to terraform.tfvars:                                  ║
  ║       chrome_extension_id = "<the-id>"                       ║
  ║  4. terraform apply  (updates Cognito callback URL)          ║
  ║  5. Update COGNITO_CLIENT_ID in service-worker.ts            ║
  ║     to: cognito_extension_client_id output                   ║
  ║                                                              ║
  ║  vocabulary-app/.env.local                                   ║
  ║     VITE_API_BASE_URL       → api_gateway_url output         ║
  ║     VITE_COGNITO_DOMAIN     → cognito_hosted_ui_domain       ║
  ║     VITE_COGNITO_CLIENT_ID  → cognito_vocabapp_client_id     ║
  ║     VITE_REDIRECT_URI       → cloudfront_domain + /callback  ║
  ╚══════════════════════════════════════════════════════════════╝
  EOT
}
