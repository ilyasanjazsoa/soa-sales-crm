# ECS Fargate: api (2 tasks, 0.5 vCPU / 1 GB) and worker (1 task, 1 vCPU / 2 GB), plus the migration task that the
# deploy workflow runs before a new version starts (§16). One image; the command picks the role.
resource "aws_ecr_repository" "app" {
  name                 = local.name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_security_group" "services" {
  name   = "${local.name}-services"
  vpc_id = aws_vpc.main.id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group_rule" "alb_to_api" {
  type                     = "ingress"
  from_port                = 3000
  to_port                  = 3000
  protocol                 = "tcp"
  security_group_id        = aws_security_group.services.id
  source_security_group_id = aws_security_group.alb.id
}

# ───────── roles ─────────
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_secretsmanager_secret.app.arn]
    }]
  })
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "task" {
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Files"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.files.arn}/*"
      },
      {
        Sid      = "Bedrock"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:Converse"]
        Resource = "*"
      },
      {
        Sid      = "BackupCheck"
        Effect   = "Allow"
        Action   = ["rds:DescribeDBInstances"]
        Resource = aws_db_instance.main.arn
      },
    ]
  })
}

# ───────── task definitions ─────────
resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["api", "worker", "migrate"])
  name              = "/${local.name}/${each.key}"
  retention_in_days = 90
}

locals {
  image = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
  base_environment = merge(
    {
      NODE_ENV        = "production"
      DEPLOY_ENV      = var.environment
      PORT            = "3000"
      PUBLIC_URL      = "https://${var.domain_name}"
      APP_URL         = "https://${var.domain_name}"
      AWS_REGION      = var.region
      S3_BUCKET       = aws_s3_bucket.files.bucket
      FAKE_PROVIDERS  = "false"
      RDS_INSTANCE_ID = aws_db_instance.main.identifier
    },
    var.app_environment,
  )
  environment = [for key, value in local.base_environment : { name = key, value = value }]
  secrets     = [for key in local.secret_keys : { name = key, valueFrom = "${aws_secretsmanager_secret.app.arn}:${key}::" }]
  container = {
    for role in ["api", "worker", "migrate"] : role => {
      name                   = role
      image                  = local.image
      command                = [role]
      essential              = true
      environment            = local.environment
      secrets                = local.secrets
      portMappings           = role == "api" ? [{ containerPort = 3000, protocol = "tcp" }] : []
      readonlyRootFilesystem = false
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.app[role].name
          awslogs-region        = var.region
          awslogs-stream-prefix = role
        }
      }
    }
  }
  sizes = {
    api     = { cpu = 512, memory = 1024 }
    worker  = { cpu = 1024, memory = 2048 }
    migrate = { cpu = 256, memory = 512 }
  }
}

resource "aws_ecs_task_definition" "app" {
  for_each                 = local.container
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.sizes[each.key].cpu
  memory                   = local.sizes[each.key].memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = jsonencode([each.value])
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
}

resource "aws_ecs_service" "api" {
  name                               = "api"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.app["api"].arn
  desired_count                      = var.api_desired_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 30
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.services.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }
  lifecycle {
    ignore_changes = [task_definition] # the deploy workflow moves it forward
  }
}

resource "aws_ecs_service" "worker" {
  name                               = "worker"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.app["worker"].arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100 # one worker at a time
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.services.id]
  }
  lifecycle {
    ignore_changes = [task_definition]
  }
}
