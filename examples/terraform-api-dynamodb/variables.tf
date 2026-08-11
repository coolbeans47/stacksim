variable "aws_region" {
  description = "AWS Region simulated by StackSim."
  type        = string
  default     = "eu-west-1"

  validation {
    condition     = can(regex("^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]+$", var.aws_region))
    error_message = "aws_region must be a valid AWS Region name."
  }
}

variable "stacksim_account_id" {
  description = "StackSim account ID used as a guard against deploying to real AWS."
  type        = string
  default     = "000000000000"

  validation {
    condition     = can(regex("^[0-9]{12}$", var.stacksim_account_id))
    error_message = "stacksim_account_id must contain exactly 12 digits."
  }
}

variable "name_prefix" {
  description = "Prefix applied to the example's resource names."
  type        = string
  default     = "stacksim-terraform-api"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,39}$", var.name_prefix))
    error_message = "name_prefix must be 3-40 lowercase letters, digits, or hyphens and start with a letter or digit."
  }
}

variable "tags" {
  description = "Additional tags applied to taggable resources."
  type        = map(string)
  default     = {}
}
