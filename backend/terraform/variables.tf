variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "eu-central-1"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "prod"
}

variable "allowed_origins" {
  description = "Comma-separated CORS allowed origins. Tighten after CloudFront URL is known."
  type        = string
  default     = "*"
}

variable "cognito_hosted_ui_subdomain" {
  description = "Subdomain for Cognito Hosted UI (must be globally unique)"
  type        = string
  default     = "langext-prod"
}

variable "chrome_extension_id" {
  description = "Chrome extension ID shown in chrome://extensions (used as Cognito callback URL)"
  type        = string
  # Find yours: load the unpacked extension → chrome://extensions → copy the ID
}

variable "openai_api_key" {
  description = "OpenAI API key stored as a Lambda environment variable for the analyze proxy"
  type        = string
  sensitive   = true
}

variable "openai_project_id" {
  description = "OpenAI Project ID (optional, sent as OpenAI-Project header)"
  type        = string
  default     = ""
}

variable "openai_secret_name" {
  description = "AWS Secrets Manager secret name containing OpenAI credentials"
  type        = string
  default     = "getfluentfast/secrets"
}

variable "openai_secret_key_name" {
  description = "Key name inside the secret JSON that stores the OpenAI API key"
  type        = string
  default     = "openai_api_key"
}

variable "openai_project_key_name" {
  description = "Optional key name inside the secret JSON for OpenAI project id"
  type        = string
  default     = "openai_project_id"
}

# ── Apple Sign-In (for iOS app) ───────────────────────────────────────────────

variable "apple_client_id" {
  description = "Apple Services ID (client_id) for Sign in with Apple. Required for iOS app Cognito federated sign-in."
  type        = string
  default     = ""
}

variable "apple_team_id" {
  description = "Apple Team ID (10-character string from Apple Developer portal)"
  type        = string
  default     = ""
}

variable "apple_key_id" {
  description = "Apple private key ID (from Apple Developer portal → Keys)"
  type        = string
  default     = ""
}

variable "apple_private_key" {
  description = "Apple private key content (.p8 file) for Sign in with Apple JWT signing"
  type        = string
  sensitive   = true
  default     = ""
}

variable "ios_app_callback_url" {
  description = "Callback URL for the iOS Cognito app client (e.g. myapp://callback)"
  type        = string
  default     = "getfluentfast://callback"
}
