output "load_balancer_dns" {
  description = "Point domain_name here (a CNAME or alias)."
  value       = aws_lb.main.dns_name
}

output "ecr_repository" {
  value = aws_ecr_repository.app.repository_url
}

output "cluster" {
  value = aws_ecs_cluster.main.name
}

output "private_subnets" {
  value = aws_subnet.private[*].id
}

output "services_security_group" {
  value = aws_security_group.services.id
}

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}

output "db_instance" {
  value = aws_db_instance.main.identifier
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}
