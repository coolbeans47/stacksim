terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }

    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # StackSim exposes every implemented AWS control plane through one local
  # endpoint. AWS_ENDPOINT_URL supplies that endpoint to the AWS provider.
  skip_metadata_api_check = true
  s3_use_path_style       = true
  max_retries             = 2

  # Fail safely if this configuration is accidentally pointed at real AWS.
  allowed_account_ids = [var.stacksim_account_id]
}
