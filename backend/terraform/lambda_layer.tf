locals {
  layer_build_dir = "${local.build_dir}/layer"
  layer_zip_path  = "${local.build_dir}/langext-shared-layer.zip"

  # Track changes to shared source files so the layer rebuilds when they change
  shared_src_hash = sha256(join("", [
    filesha256("${local.lambda_src}/shared/models.py"),
    filesha256("${local.lambda_src}/shared/dynamodb_client.py"),
    filesha256("${local.lambda_src}/shared/cors.py"),
    filesha256("${local.lambda_src}/shared/__init__.py"),
  ]))
}

resource "null_resource" "build_layer" {
  triggers = {
    shared_hash  = local.shared_src_hash
    requirements = filesha256("${local.lambda_src}/requirements.txt")
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-SH
      set -e
      PYDIR="${local.layer_build_dir}/python"
      rm -rf "${local.layer_build_dir}"
      mkdir -p "$PYDIR"

      # Install packages needed by all Lambdas
      pip3 install \
        "pydantic==2.5.0" \
        "aws-lambda-powertools==2.20.0" \
        "PyJWT==2.9.0" \
        "cryptography==42.0.8" \
        --target "$PYDIR" \
        --platform manylinux2014_x86_64 \
        --python-version 3.11 \
        --only-binary=:all: \
        --quiet

      # Copy shared module
      cp -r "${local.lambda_src}/shared" "$PYDIR/shared"
    SH
  }
}

data "archive_file" "layer_zip" {
  type        = "zip"
  source_dir  = local.layer_build_dir
  output_path = local.layer_zip_path

  depends_on = [null_resource.build_layer]
}

resource "aws_lambda_layer_version" "shared" {
  layer_name          = "${local.name}-shared"
  filename            = data.archive_file.layer_zip.output_path
  source_code_hash    = data.archive_file.layer_zip.output_base64sha256
  compatible_runtimes = ["python3.11"]
  description         = "langext shared models, DynamoDB client, CORS helpers + pydantic"
}
