# PostgreSQL 16 (Multi-AZ, 14-day point-in-time recovery), the file bucket, and the app secrets (§16).
resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_security_group" "db" {
  name   = "${local.name}-db"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.services.id]
  }
}

resource "aws_db_parameter_group" "main" {
  name   = local.name
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
}

resource "aws_db_instance" "main" {
  identifier                   = local.name
  engine                       = "postgres"
  engine_version               = "16"
  instance_class               = var.db_instance_class
  allocated_storage            = 50
  max_allocated_storage        = 200
  storage_encrypted            = true
  db_name                      = "crm"
  username                     = "crm_owner"
  manage_master_user_password  = true # the owner's password lives in Secrets Manager; used only by migrations
  multi_az                     = var.db_multi_az
  db_subnet_group_name         = aws_db_subnet_group.main.name
  vpc_security_group_ids       = [aws_security_group.db.id]
  parameter_group_name         = aws_db_parameter_group.main.name
  backup_retention_period      = 14
  backup_window                = "08:00-08:30" # 2–2:30 am Central
  maintenance_window           = "sun:09:00-sun:10:00"
  deletion_protection          = var.environment == "production"
  skip_final_snapshot          = var.environment != "production"
  final_snapshot_identifier    = var.environment == "production" ? "${local.name}-final" : null
  performance_insights_enabled = true
  copy_tags_to_snapshot        = true
  auto_minor_version_upgrade   = true
}

resource "aws_s3_bucket" "files" {
  bucket = "${local.name}-files"
}

resource "aws_s3_bucket_versioning" "files" {
  bucket = aws_s3_bucket.files.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "files" {
  bucket                  = aws_s3_bucket.files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "files_tls" {
  bucket = aws_s3_bucket.files.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TlsOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.files.arn, "${aws_s3_bucket.files.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# One JSON secret with the app's secret values (filled in by hand, see docs/RUNBOOK.md "Secrets"):
# DATABASE_URL, MIGRATION_DATABASE_URL, SESSION_SECRET, TOKEN_ENC_KEY, UNSUBSCRIBE_SECRET, IP_HASH_SALT,
# OIDC_CLIENT_SECRET, ESIGN_API_KEY, ESIGN_WEBHOOK_SECRET, MAPS_API_KEY.
resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name}/app"
  recovery_window_in_days = 7
}

locals {
  secret_keys = [
    "DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "SESSION_SECRET",
    "TOKEN_ENC_KEY",
    "UNSUBSCRIBE_SECRET",
    "IP_HASH_SALT",
    "OIDC_CLIENT_SECRET",
    "ESIGN_API_KEY",
    "ESIGN_WEBHOOK_SECRET",
    "MAPS_API_KEY",
  ]
}
