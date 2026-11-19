terraform {
  required_version = ">= 1.6, < 2.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.58.0"
    }
  }
}

variable "stacksim_endpoint" {
  type    = string
  default = "http://127.0.0.1:4566"
}

variable "writer_port" {
  type    = number
  default = 3306
}

variable "enable_http_endpoint" {
  type    = bool
  default = true
}

variable "deletion_protection" {
  type    = bool
  default = false
}

variable "stage" {
  type    = string
  default = "development"
}

provider "aws" {
  region                  = "us-east-1"
  allowed_account_ids     = ["000000000000"]
  skip_metadata_api_check = true

  endpoints {
    sts = var.stacksim_endpoint
    rds = var.stacksim_endpoint
  }
}

resource "aws_rds_cluster" "app" {
  cluster_identifier          = "app-cluster"
  engine                      = "aurora-mysql"
  engine_mode                 = "provisioned"
  engine_version              = "8.0.mysql_aurora.3.08.0"
  database_name               = "app"
  master_username             = "developer"
  manage_master_user_password = true
  port                        = var.writer_port
  deletion_protection         = var.deletion_protection
  skip_final_snapshot         = true
  enable_http_endpoint        = var.enable_http_endpoint
  apply_immediately           = true

  serverlessv2_scaling_configuration {
    min_capacity = 0.5
    max_capacity = 2
  }

  tags = { Stage = var.stage }
}

output "cluster_arn" {
  value = aws_rds_cluster.app.arn
}

resource "aws_rds_cluster_instance" "writer" {
  identifier         = "app-writer"
  cluster_identifier = aws_rds_cluster.app.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.app.engine
  engine_version     = aws_rds_cluster.app.engine_version
  apply_immediately  = true
}

output "writer" {
  value = aws_rds_cluster_instance.writer.writer
}

output "secret_arn" {
  value = aws_rds_cluster.app.master_user_secret[0].secret_arn
}

output "database" {
  value = aws_rds_cluster.app.database_name
}

output "sdk_endpoint" {
  value = var.stacksim_endpoint
}
