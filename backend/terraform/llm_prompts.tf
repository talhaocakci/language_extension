locals {
  explain_prompt_id = "language_backend:tier3:explain_sentence"

  explain_system_prompt = <<-EOT
  You are a German linguistics expert for language learners.
  Analyze the full sentence and return ONLY valid JSON with exactly these top-level keys:
  - "phrasalVerbs": array
  - "fixedPhrases": array
  - "note": string

  Rules:
  1) phrasalVerbs:
     Identify true separable verbs (trennbare Verben) only.
     Each item must include:
     - foundInText
     - baseForm
     - meaning
     - prefix
     - stem
     - example

  2) fixedPhrases:
     Include idioms, collocations, connectors, and multi-word constructions learners should memorize as units.
     Each item must include:
     - foundInText
     - kind
     - canonicalForm
     - meaning
     - example (optional)

  3) Important distinction:
     - Do not confuse "aufgehen" (separable verb) with "gehen auf + noun" where "auf" is a preposition.
     - If the sentence contains "es geht um" or similar variants ("geht's um", "geht es um", "geht immer um", etc.),
       include this as a fixed phrase with meaning "to be about / concern".

  4) Output constraints:
     - Return JSON only, no markdown.
     - If nothing is found, return empty arrays and explain briefly in "note".
  EOT

  explain_user_prompt_template = <<-EOT
  Analyze this German sentence for separable verbs and fixed phrases:
  "{{sentence}}"
  EOT
}

resource "aws_dynamodb_table" "llm_prompts" {
  name         = "${local.name}-llm-prompts"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "prompt_id"

  attribute {
    name = "prompt_id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Name = "${local.name}-llm-prompts"
  }
}

resource "aws_dynamodb_table_item" "explain_prompt_tier3" {
  table_name = aws_dynamodb_table.llm_prompts.name
  hash_key   = aws_dynamodb_table.llm_prompts.hash_key

  item = jsonencode({
    prompt_id = { S = local.explain_prompt_id }

    system_prompt        = { S = local.explain_system_prompt }
    user_prompt_template = { S = local.explain_user_prompt_template }

    model           = { S = "gpt-4o-mini" }
    temperature     = { N = "0" }
    response_format = { S = "json_object" }
    is_active       = { BOOL = true }

    created_at = { S = "2026-04-19T00:00:00Z" }
    updated_at = { S = "2026-04-19T00:00:00Z" }
  })
}
