# Alarms (§16): 5xx rate, p95 latency over 2 s, job failures, queue age over 10 minutes, any needs_reconnect,
# RDS storage and CPU, plus the nightly backup check. All go to one email list. What each means is in
# docs/RUNBOOK.md "Alarms". Job and mailbox numbers come from the worker's structured logs.
resource "aws_sns_topic" "alarms" {
  name = "${local.name}-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  namespace = "SOA-CRM/${var.environment}"
  alarm_defaults = {
    alarm_actions = [aws_sns_topic.alarms.arn]
    ok_actions    = [aws_sns_topic.alarms.arn]
  }
}

# ───────── metrics from logs ─────────
resource "aws_cloudwatch_log_metric_filter" "job_failures" {
  name           = "${local.name}-job-failures"
  log_group_name = aws_cloudwatch_log_group.app["worker"].name
  pattern        = "{ $.msg = \"job failed\" }"
  metric_transformation {
    name          = "JobFailures"
    namespace     = local.namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "queue_age" {
  name           = "${local.name}-queue-age"
  log_group_name = aws_cloudwatch_log_group.app["worker"].name
  pattern        = "{ $.metric = \"health\" }"
  metric_transformation {
    name      = "OldestQueuedSeconds"
    namespace = local.namespace
    value     = "$.oldestQueuedSeconds"
  }
}

resource "aws_cloudwatch_log_metric_filter" "needs_reconnect" {
  name           = "${local.name}-needs-reconnect"
  log_group_name = aws_cloudwatch_log_group.app["worker"].name
  pattern        = "{ $.metric = \"health\" }"
  metric_transformation {
    name      = "MailboxesNeedingReconnect"
    namespace = local.namespace
    value     = "$.needsReconnect"
  }
}

resource "aws_cloudwatch_log_metric_filter" "backup" {
  name           = "${local.name}-backup-failed"
  log_group_name = aws_cloudwatch_log_group.app["worker"].name
  pattern        = "{ $.msg = \"maintenance done\" && $.backupOk IS FALSE }"
  metric_transformation {
    name          = "BackupCheckFailed"
    namespace     = local.namespace
    value         = "1"
    default_value = "0"
  }
}

# ───────── alarms ─────────
resource "aws_cloudwatch_metric_alarm" "http_5xx" {
  alarm_name          = "${local.name}-5xx-rate"
  alarm_description   = "More than 2% of requests failed with a server error for 10 minutes."
  comparison_operator = "GreaterThanThreshold"
  threshold           = 2
  evaluation_periods  = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_defaults.alarm_actions
  ok_actions          = local.alarm_defaults.ok_actions
  metric_query {
    id          = "rate"
    expression  = "IF(requests > 20, 100 * errors / requests, 0)"
    label       = "5xx %"
    return_data = true
  }
  metric_query {
    id = "errors"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix }
    }
  }
  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "latency" {
  alarm_name          = "${local.name}-p95-latency"
  alarm_description   = "p95 response time over 2 s for 15 minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix }
  period              = 300
  evaluation_periods  = 3
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_defaults.alarm_actions
  ok_actions          = local.alarm_defaults.ok_actions
}

resource "aws_cloudwatch_metric_alarm" "unhealthy" {
  alarm_name          = "${local.name}-no-healthy-api"
  alarm_description   = "No healthy api task behind the load balancer."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  alarm_actions       = local.alarm_defaults.alarm_actions
  ok_actions          = local.alarm_defaults.ok_actions
}

resource "aws_cloudwatch_metric_alarm" "job_failures" {
  alarm_name          = "${local.name}-job-failures"
  alarm_description   = "Background jobs failed (3 or more in 15 minutes)."
  namespace           = local.namespace
  metric_name         = "JobFailures"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_defaults.alarm_actions
  ok_actions          = local.alarm_defaults.ok_actions
}

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${local.name}-queue-age"
  alarm_description   = "A job has waited more than 10 minutes: the worker may be down or stuck."
  namespace           = local.namespace
  metric_name         = "OldestQueuedSeconds"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching" # no numbers at all means the worker isn't running
  alarm_actions       = local.alarm_defaults.alarm_actions
  ok_actions          = local.alarm_defaults.ok_actions
}

resource "aws_cloudwatch_metric_alarm" "needs_reconnect" {
  alarm_name          = "${local.name}-mailbox-reconnect"
  alarm_description   = "A rep's mailbox connection expired; they must sign in again."
  namespace           = local.namespace
  metric_name         = "MailboxesNeedingReconnect"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_defaults.alarm_actions
  ok_actions          = local.alarm_defaults.ok_actions
}

resource "aws_cloudwatch_metric_alarm" "backup" {
  alarm_name          = "${local.name}-backup-check"
  alarm_description   = "The nightly check found no restore point in the last 26 hours."
  namespace           = local.namespace
  metric_name         = "BackupCheckFailed"
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_defaults.alarm_actions
  ok_actions          = local.alarm_defaults.ok_actions
}

resource "aws_cloudwatch_metric_alarm" "db_storage" {
  alarm_name          = "${local.name}-db-storage"
  alarm_description   = "Less than 10 GB free on the database."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 10 * 1024 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  alarm_actions       = local.alarm_defaults.alarm_actions
  ok_actions          = local.alarm_defaults.ok_actions
}

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${local.name}-db-cpu"
  alarm_description   = "Database CPU over 80% for 15 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_defaults.alarm_actions
  ok_actions          = local.alarm_defaults.ok_actions
}
