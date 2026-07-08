resource "aws_dynamodb_table" "phrases" {
  name         = "${local.name}-phrases"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "user_id"
  range_key    = "sort_key"

  attribute {
    name = "user_id"
    type = "S"
  }
  attribute {
    name = "sort_key"
    type = "S"
  }
  attribute {
    name = "canonical_form"
    type = "S"
  }
  attribute {
    name = "kind"
    type = "S"
  }

  global_secondary_index {
    name            = "canonical_form_index"
    hash_key        = "canonical_form"
    range_key       = "user_id"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "kind_index"
    hash_key        = "user_id"
    range_key       = "kind"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Name = "${local.name}-phrases"
  }
}
