locals {
  bucket_name = "${local.name}-vocab-app-${local.account_id}"
}

# ── S3 bucket (private) ───────────────────────────────────────────────────────

resource "aws_s3_bucket" "vocab_app" {
  bucket = local.bucket_name
  tags   = { Name = local.bucket_name }
}

resource "aws_s3_bucket_versioning" "vocab_app" {
  bucket = aws_s3_bucket.vocab_app.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "vocab_app" {
  bucket                  = aws_s3_bucket.vocab_app.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ── CloudFront Origin Access Control ─────────────────────────────────────────

resource "aws_cloudfront_origin_access_control" "vocab_app" {
  name                              = "${local.name}-vocab-app-oac"
  description                       = "OAC for langext vocab app"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ── CloudFront distribution ───────────────────────────────────────────────────

resource "aws_cloudfront_distribution" "vocab_app" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  comment             = "${local.name}-vocab-app"
  price_class         = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.vocab_app.bucket_regional_domain_name
    origin_id                = "s3-vocab-app"
    origin_access_control_id = aws_cloudfront_origin_access_control.vocab_app.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-vocab-app"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
    origin_request_policy_id   = "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf" # Managed-CORS-S3Origin
  }

  # SPA fallback: 403/404 → index.html
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }
  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = { Name = "${local.name}-vocab-app" }
}

# ── Bucket policy: allow only CloudFront OAC ─────────────────────────────────

data "aws_iam_policy_document" "vocab_app_s3" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.vocab_app.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.vocab_app.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "vocab_app" {
  bucket = aws_s3_bucket.vocab_app.id
  policy = data.aws_iam_policy_document.vocab_app_s3.json

  depends_on = [aws_s3_bucket_public_access_block.vocab_app]
}

# ── Build vocab app and sync to S3 ───────────────────────────────────────────

resource "null_resource" "build_and_deploy_vocab_app" {
  triggers = {
    # Rebuild on any source file change (uses directory hash via timestamp trick)
    src_hash = timestamp()
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-SH
      set -e
      cd "${local.vocab_src}"
      npm install --silent
      npm run build
      aws s3 sync dist/ "s3://${local.bucket_name}/" \
        --delete \
        --cache-control "public, max-age=31536000, immutable" \
        --exclude "*.html"
      aws s3 sync dist/ "s3://${local.bucket_name}/" \
        --delete \
        --exclude "*" \
        --include "*.html" \
        --cache-control "no-cache, no-store, must-revalidate"
      aws cloudfront create-invalidation \
        --distribution-id "${aws_cloudfront_distribution.vocab_app.id}" \
        --paths "/*" \
        --no-cli-pager
    SH
  }

  depends_on = [
    aws_s3_bucket_policy.vocab_app,
    aws_cloudfront_distribution.vocab_app,
  ]
}
