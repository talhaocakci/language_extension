terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = local.common_tags
  }
}

# Cognito custom-domain certificates must be issued in us-east-1 because the
# hosted sign-in pages are served through CloudFront.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = local.common_tags
  }
}

locals {
  prefix = "langext"
  env    = var.environment
  name   = "${local.prefix}-${local.env}"

  common_tags = {
    Application = "language-extension"
    Environment = var.environment
    ManagedBy   = "terraform"
    Project     = "langext"
  }

  # Absolute path to repository root (two levels above backend/terraform/)
  repo_root = abspath("${path.module}/../..")

  lambda_src = "${local.repo_root}/backend/lambda"
  vocab_src  = "${local.repo_root}/vocabulary-app"
  build_dir  = "${path.module}/build"
}
