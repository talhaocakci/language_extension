locals {
  lambda_env = {
    TABLE_NAME      = aws_dynamodb_table.phrases.name
    ALLOWED_ORIGINS = var.allowed_origins
    POWERTOOLS_SERVICE_NAME = "langext"
    LOG_LEVEL       = "INFO"
  }
}

# ── save_phrase ───────────────────────────────────────────────────────────────

data "archive_file" "save_phrase" {
  type        = "zip"
  source_file = "${local.lambda_src}/functions/save_phrase/index.py"
  output_path = "${local.build_dir}/save_phrase.zip"
}

resource "aws_lambda_function" "save_phrase" {
  function_name    = "${local.name}-save-phrase"
  description      = "langext: save idiom/phrasal verb to DynamoDB"
  filename         = data.archive_file.save_phrase.output_path
  source_code_hash = data.archive_file.save_phrase.output_base64sha256
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.lambda_handler"
  runtime          = "python3.11"
  timeout          = 30
  memory_size      = 256
  layers           = [aws_lambda_layer_version.shared.arn]
  environment {
    variables = local.lambda_env
  }
  tags = { Name = "${local.name}-save-phrase" }
}

# ── get_user_phrases ──────────────────────────────────────────────────────────

data "archive_file" "get_phrases" {
  type        = "zip"
  source_file = "${local.lambda_src}/functions/get_user_phrases/index.py"
  output_path = "${local.build_dir}/get_phrases.zip"
}

resource "aws_lambda_function" "get_phrases" {
  function_name    = "${local.name}-get-phrases"
  description      = "langext: list/paginate saved phrases"
  filename         = data.archive_file.get_phrases.output_path
  source_code_hash = data.archive_file.get_phrases.output_base64sha256
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.lambda_handler"
  runtime          = "python3.11"
  timeout          = 30
  memory_size      = 256
  layers           = [aws_lambda_layer_version.shared.arn]
  environment {
    variables = local.lambda_env
  }
  tags = { Name = "${local.name}-get-phrases" }
}

# ── delete_phrase ─────────────────────────────────────────────────────────────

data "archive_file" "delete_phrase" {
  type        = "zip"
  source_file = "${local.lambda_src}/functions/delete_phrase/index.py"
  output_path = "${local.build_dir}/delete_phrase.zip"
}

resource "aws_lambda_function" "delete_phrase" {
  function_name    = "${local.name}-delete-phrase"
  description      = "langext: delete a saved phrase by ID"
  filename         = data.archive_file.delete_phrase.output_path
  source_code_hash = data.archive_file.delete_phrase.output_base64sha256
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.lambda_handler"
  runtime          = "python3.11"
  timeout          = 30
  memory_size      = 256
  layers           = [aws_lambda_layer_version.shared.arn]
  environment {
    variables = local.lambda_env
  }
  tags = { Name = "${local.name}-delete-phrase" }
}

# ── analyze (LLM proxy — Lambda Function URL, no API Gateway) ─────────────────

data "archive_file" "analyze" {
  type        = "zip"
  source_file = "${local.lambda_src}/functions/analyze/index.py"
  output_path = "${local.build_dir}/analyze.zip"
}

resource "aws_lambda_function" "analyze" {
  function_name    = "${local.name}-analyze"
  description      = "langext: LLM proxy — validates Cognito JWT, calls OpenAI"
  filename         = data.archive_file.analyze.output_path
  source_code_hash = data.archive_file.analyze.output_base64sha256
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.lambda_handler"
  runtime          = "python3.11"
  # OpenAI calls can take up to ~30 s; Lambda Function URL timeout must be ≤ 15 min.
  timeout     = 60
  memory_size = 256
  layers      = [aws_lambda_layer_version.shared.arn]

  environment {
    variables = merge(local.lambda_env, {
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.main.id
      COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.extension.id
      OPENAI_API_KEY       = var.openai_api_key
      OPENAI_PROJECT_ID    = var.openai_project_id
      OPENAI_SECRET_NAME      = var.openai_secret_name
      OPENAI_SECRET_KEY_NAME  = var.openai_secret_key_name
      OPENAI_PROJECT_KEY_NAME = var.openai_project_key_name
    })
  }

  tags = { Name = "${local.name}-analyze" }
}

# ── explain (ADMIN-only, prompt loaded from llm_prompts table) ───────────────

data "archive_file" "explain" {
  type        = "zip"
  source_file = "${local.lambda_src}/functions/explain/index.py"
  output_path = "${local.build_dir}/explain.zip"
}

resource "aws_lambda_function" "explain" {
  function_name    = "${local.name}-explain"
  description      = "langext: ADMIN-only sentence explain endpoint using llm_prompts table"
  filename         = data.archive_file.explain.output_path
  source_code_hash = data.archive_file.explain.output_base64sha256
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.lambda_handler"
  runtime          = "python3.11"
  timeout          = 60
  memory_size      = 256
  layers           = [aws_lambda_layer_version.shared.arn]

  environment {
    variables = merge(local.lambda_env, {
      OPENAI_API_KEY    = var.openai_api_key
      OPENAI_PROJECT_ID = var.openai_project_id
      LLM_PROMPTS_TABLE = aws_dynamodb_table.llm_prompts.name
      EXPLAIN_PROMPT_ID = local.explain_prompt_id
      OPENAI_SECRET_NAME      = var.openai_secret_name
      OPENAI_SECRET_KEY_NAME  = var.openai_secret_key_name
      OPENAI_PROJECT_KEY_NAME = var.openai_project_key_name
    })
  }

  tags = { Name = "${local.name}-explain" }
}

# ── get_phrase ─────────────────────────────────────────────────────────────────

data "archive_file" "get_phrase" {
  type        = "zip"
  source_file = "${local.lambda_src}/functions/get_phrase/index.py"
  output_path = "${local.build_dir}/get_phrase.zip"
}

resource "aws_lambda_function" "get_phrase" {
  function_name    = "${local.name}-get-phrase"
  description      = "langext: fetch a single phrase by ID"
  filename         = data.archive_file.get_phrase.output_path
  source_code_hash = data.archive_file.get_phrase.output_base64sha256
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.lambda_handler"
  runtime          = "python3.11"
  timeout          = 30
  memory_size      = 256
  layers           = [aws_lambda_layer_version.shared.arn]
  environment {
    variables = local.lambda_env
  }
  tags = { Name = "${local.name}-get-phrase" }
}

# ── update_phrase ──────────────────────────────────────────────────────────────

data "archive_file" "update_phrase" {
  type        = "zip"
  source_file = "${local.lambda_src}/functions/update_phrase/index.py"
  output_path = "${local.build_dir}/update_phrase.zip"
}

resource "aws_lambda_function" "update_phrase" {
  function_name    = "${local.name}-update-phrase"
  description      = "langext: update meaning/tags/user_notes/audio on a phrase"
  filename         = data.archive_file.update_phrase.output_path
  source_code_hash = data.archive_file.update_phrase.output_base64sha256
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.lambda_handler"
  runtime          = "python3.11"
  timeout          = 30
  memory_size      = 256
  layers           = [aws_lambda_layer_version.shared.arn]
  environment {
    variables = local.lambda_env
  }
  tags = { Name = "${local.name}-update-phrase" }
}

# ── get_stats ──────────────────────────────────────────────────────────────────

data "archive_file" "get_stats" {
  type        = "zip"
  source_file = "${local.lambda_src}/functions/get_stats/index.py"
  output_path = "${local.build_dir}/get_stats.zip"
}

resource "aws_lambda_function" "get_stats" {
  function_name    = "${local.name}-get-stats"
  description      = "langext: return per-user phrase stats (total + by_kind)"
  filename         = data.archive_file.get_stats.output_path
  source_code_hash = data.archive_file.get_stats.output_base64sha256
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.lambda_handler"
  runtime          = "python3.11"
  timeout          = 30
  memory_size      = 256
  layers           = [aws_lambda_layer_version.shared.arn]
  environment {
    variables = local.lambda_env
  }
  tags = { Name = "${local.name}-get-stats" }
}
