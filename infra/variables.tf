variable "environment" {
  description = "staging or production"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "domain_name" {
  description = "The host name of this environment, e.g. crm.example.com (its ACM certificate must exist)."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate for domain_name."
  type        = string
}

variable "allowed_cidrs" {
  description = "Office and VPN ranges allowed to reach the app and /api (DECISIONS.md item G). /p, /u, /webhooks and /healthz stay public."
  type        = list(string)
  validation {
    condition     = length(var.allowed_cidrs) > 0
    error_message = "Set the office and VPN ranges; without them only the public surface would be reachable."
  }
}

variable "alarm_email" {
  description = "Where alarms are sent (an email list)."
  type        = string
}

variable "image_tag" {
  description = "The container image tag to run (set by the deploy workflow)."
  type        = string
  default     = "latest"
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "app_environment" {
  description = "Plain (non-secret) environment variables for the api and worker, e.g. COMPANY_NAME, AI_MODEL_WRITER, MAIL_ALLOWLIST (staging)."
  type        = map(string)
  default     = {}
}
