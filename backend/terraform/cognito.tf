resource "aws_cognito_user_pool" "main" {
  name = "${local.name}-userpool"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = false
    require_uppercase                = true
    temporary_password_validity_days = 7
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your Language Extension verification code"
    email_message        = "Your verification code is {####}"
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  tags = {
    Name = "${local.name}-userpool"
  }
}

resource "aws_cognito_user_group" "admin" {
  user_pool_id = aws_cognito_user_pool.main.id
  name         = "ADMIN"
  description  = "Users in this group can access ADMIN-only LLM endpoints"
  precedence   = 1
}

# Hosted UI domain
resource "aws_cognito_user_pool_domain" "main" {
  domain       = var.cognito_hosted_ui_subdomain
  user_pool_id = aws_cognito_user_pool.main.id
}

# ── App client for Chrome Extension (PKCE / OAuth2 code flow) ────────────────
resource "aws_cognito_user_pool_client" "extension" {
  name         = "${local.name}-extension-client"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  # The chromiumapp.org redirect is used by chrome.identity.launchWebAuthFlow.
  # Replace <YOUR_EXTENSION_ID> with the value shown in chrome://extensions.
  callback_urls = compact([
    "https://${var.chrome_extension_id}.chromiumapp.org/",
  ])
  logout_urls = compact([
    "https://${var.chrome_extension_id}.chromiumapp.org/",
  ])

  explicit_auth_flows = [
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
  ]

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  prevent_user_existence_errors = "ENABLED"
}

# ── App client for Vocabulary Web App (PKCE / OAuth2) ────────────────────────
resource "aws_cognito_user_pool_client" "vocabapp" {
  name         = "${local.name}-vocabapp-client"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  # CloudFront URL added after apply via ALLOWED_ORIGINS update
  callback_urls = [
    "https://d257tw036rwhrl.cloudfront.net/callback",
    "http://localhost:5173/callback",
  ]
  logout_urls = [
    "https://d257tw036rwhrl.cloudfront.net/",
    "http://localhost:5173/",
  ]

  explicit_auth_flows = [
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
  ]

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  prevent_user_existence_errors = "ENABLED"
}

# ── Apple Sign-In (Sign in with Apple — federated OIDC) ──────────────────────
# Only created when apple_client_id is set.

resource "aws_cognito_identity_provider" "apple" {
  count         = var.apple_client_id != "" ? 1 : 0
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "SignInWithApple"
  provider_type = "OIDC"

  provider_details = {
    client_id                 = var.apple_client_id
    team_id                   = var.apple_team_id
    key_id                    = var.apple_key_id
    private_key               = var.apple_private_key
    authorize_scopes          = "email name"
    oidc_issuer               = "https://appleid.apple.com"
    attributes_request_method = "GET"
  }

  attribute_mapping = {
    email    = "email"
    username = "sub"
  }
}

# ── iOS App Client (PKCE + Apple Sign-In + Cognito) ──────────────────────────

resource "aws_cognito_user_pool_client" "ios_app" {
  name         = "${local.name}-ios-client"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers = compact([
    "COGNITO",
    var.apple_client_id != "" ? "SignInWithApple" : "",
  ])

  callback_urls = [var.ios_app_callback_url]
  logout_urls   = [var.ios_app_callback_url]

  explicit_auth_flows = [
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
  ]

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  prevent_user_existence_errors = "ENABLED"

  depends_on = [aws_cognito_identity_provider.apple]
}
