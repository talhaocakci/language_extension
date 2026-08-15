# These resources were created during the initial auth.getfluentfast.app
# rollout. Import them so the Terraform configuration takes ownership without
# attempting to create replacements on the next apply.
import {
  to = aws_acm_certificate.cognito_custom_domain
  id = "arn:aws:acm:us-east-1:348467063208:certificate/49e8693c-edc6-4568-a5ba-7e0ab48c724a"
}

import {
  to = aws_cognito_user_pool_domain.custom
  id = "auth.getfluentfast.app"
}
