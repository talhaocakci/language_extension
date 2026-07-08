data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  # Lambda invoke URI helper
  lambda_uri = {
    save          = "arn:aws:apigateway:${var.aws_region}:lambda:path/2015-03-31/functions/${aws_lambda_function.save_phrase.arn}/invocations"
    get           = "arn:aws:apigateway:${var.aws_region}:lambda:path/2015-03-31/functions/${aws_lambda_function.get_phrases.arn}/invocations"
    delete        = "arn:aws:apigateway:${var.aws_region}:lambda:path/2015-03-31/functions/${aws_lambda_function.delete_phrase.arn}/invocations"
    analyze       = "arn:aws:apigateway:${var.aws_region}:lambda:path/2015-03-31/functions/${aws_lambda_function.analyze.arn}/invocations"
    explain       = "arn:aws:apigateway:${var.aws_region}:lambda:path/2015-03-31/functions/${aws_lambda_function.explain.arn}/invocations"
    get_phrase    = "arn:aws:apigateway:${var.aws_region}:lambda:path/2015-03-31/functions/${aws_lambda_function.get_phrase.arn}/invocations"
    update_phrase = "arn:aws:apigateway:${var.aws_region}:lambda:path/2015-03-31/functions/${aws_lambda_function.update_phrase.arn}/invocations"
    get_stats     = "arn:aws:apigateway:${var.aws_region}:lambda:path/2015-03-31/functions/${aws_lambda_function.get_stats.arn}/invocations"
  }

  cors_response_params = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'GET,POST,DELETE,OPTIONS'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
}

# ── REST API ──────────────────────────────────────────────────────────────────

resource "aws_api_gateway_rest_api" "main" {
  name        = "${local.name}-api"
  description = "Language Extension phrases API"
  endpoint_configuration {
    types = ["REGIONAL"]
  }
  tags = { Name = "${local.name}-api" }
}

# ── Cognito Authorizer ────────────────────────────────────────────────────────

resource "aws_api_gateway_authorizer" "cognito" {
  name            = "${local.name}-cognito-auth"
  rest_api_id     = aws_api_gateway_rest_api.main.id
  type            = "COGNITO_USER_POOLS"
  provider_arns   = [aws_cognito_user_pool.main.arn]
  identity_source = "method.request.header.Authorization"
}

# ── /phrases resource ─────────────────────────────────────────────────────────

resource "aws_api_gateway_resource" "phrases" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "phrases"
}

# POST /phrases
module "post_phrases" {
  source        = "./modules/apigw_lambda_method"
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.phrases.id
  http_method   = "POST"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  lambda_uri    = local.lambda_uri.save
}

# GET /phrases
module "get_phrases" {
  source        = "./modules/apigw_lambda_method"
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.phrases.id
  http_method   = "GET"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  lambda_uri    = local.lambda_uri.get
}

# OPTIONS /phrases  (CORS preflight)
module "options_phrases" {
  source      = "./modules/apigw_cors_options"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.phrases.id
}

# ── /phrases/{phraseId} resource ──────────────────────────────────────────────

resource "aws_api_gateway_resource" "phrase_id" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.phrases.id
  path_part   = "{phraseId}"
}

# DELETE /phrases/{phraseId}
module "delete_phrase" {
  source        = "./modules/apigw_lambda_method"
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.phrase_id.id
  http_method   = "DELETE"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  lambda_uri    = local.lambda_uri.delete
}

# GET /phrases/{phraseId}
module "get_phrase" {
  source        = "./modules/apigw_lambda_method"
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.phrase_id.id
  http_method   = "GET"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  lambda_uri    = local.lambda_uri.get_phrase
}

# PATCH /phrases/{phraseId}
module "patch_phrase" {
  source        = "./modules/apigw_lambda_method"
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.phrase_id.id
  http_method   = "PATCH"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  lambda_uri    = local.lambda_uri.update_phrase
}

# OPTIONS /phrases/{phraseId}  (CORS preflight)
module "options_phrase_id" {
  source      = "./modules/apigw_cors_options"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.phrase_id.id
}

# ── /analyze resource ─────────────────────────────────────────────────────────

resource "aws_api_gateway_resource" "analyze" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "analyze"
}

# POST /analyze
module "post_analyze" {
  source        = "./modules/apigw_lambda_method"
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.analyze.id
  http_method   = "POST"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  lambda_uri    = local.lambda_uri.analyze
}

# OPTIONS /analyze  (CORS preflight)
module "options_analyze" {
  source      = "./modules/apigw_cors_options"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.analyze.id
}

# ── /explain resource ─────────────────────────────────────────────────────────

resource "aws_api_gateway_resource" "explain" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "explain"
}

# POST /explain
module "post_explain" {
  source        = "./modules/apigw_lambda_method"
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.explain.id
  http_method   = "POST"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  lambda_uri    = local.lambda_uri.explain
}

# OPTIONS /explain  (CORS preflight)
module "options_explain" {
  source      = "./modules/apigw_cors_options"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.explain.id
}

# ── /stats resource ───────────────────────────────────────────────────────────

resource "aws_api_gateway_resource" "stats" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "stats"
}

# GET /stats
module "get_stats" {
  source        = "./modules/apigw_lambda_method"
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.stats.id
  http_method   = "GET"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  lambda_uri    = local.lambda_uri.get_stats
}

# OPTIONS /stats  (CORS preflight)
module "options_stats" {
  source      = "./modules/apigw_cors_options"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.stats.id
}

# ── Lambda permissions ────────────────────────────────────────────────────────

resource "aws_lambda_permission" "apigw_save" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.save_phrase.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_get" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_phrases.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_delete" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.delete_phrase.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_analyze" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.analyze.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_explain" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.explain.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_get_phrase" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_phrase.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_update_phrase" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.update_phrase.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_get_stats" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_stats.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# ── Deployment ────────────────────────────────────────────────────────────────

resource "aws_api_gateway_deployment" "main" {
  rest_api_id = aws_api_gateway_rest_api.main.id

  triggers = {
    redeployment = sha1(jsonencode([
      module.post_phrases,
      module.get_phrases,
      module.options_phrases,
      module.delete_phrase,
      module.get_phrase,
      module.patch_phrase,
      module.options_phrase_id,
      module.post_analyze,
      module.options_analyze,
      module.post_explain,
      module.options_explain,
      module.get_stats,
      module.options_stats,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    module.post_phrases,
    module.get_phrases,
    module.options_phrases,
    module.delete_phrase,
    module.get_phrase,
    module.patch_phrase,
    module.options_phrase_id,
    module.post_analyze,
    module.options_analyze,
    module.post_explain,
    module.options_explain,
    module.get_stats,
    module.options_stats,
  ]
}

resource "aws_api_gateway_stage" "prod" {
  deployment_id = aws_api_gateway_deployment.main.id
  rest_api_id   = aws_api_gateway_rest_api.main.id
  stage_name    = "prod"
  tags          = { Name = "${local.name}-api-prod" }
}
