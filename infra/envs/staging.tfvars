# Staging: real AWS, real sign-in, real mail only to MAIL_ALLOWLIST (§16). Values marked REPLACE need the company.
environment       = "staging"
region            = "us-east-1"
domain_name       = "crm-staging.REPLACE.example"
certificate_arn   = "arn:aws:acm:us-east-1:000000000000:certificate/REPLACE"
allowed_cidrs     = ["203.0.113.0/24"] # REPLACE: office and VPN ranges (DECISIONS.md item G)
alarm_email       = "crm-alarms@REPLACE.example"
github_repository = "ilyasanjazsoa/soa-sales-crm"
api_desired_count = 1
db_multi_az       = false
app_environment = {
  IDP                   = "microsoft"
  OIDC_CLIENT_ID        = "REPLACE"
  OIDC_TENANT_ID        = "00000000-0000-0000-0000-000000000000"
  ALLOWED_EMAIL_DOMAIN  = "REPLACE.example"
  BOOTSTRAP_ADMIN_EMAIL = "admin@REPLACE.example"
  AI_MODEL_WRITER       = "REPLACE"
  AI_MODEL_FAST         = "REPLACE"
  MAPS_PROVIDER         = "google"
  ESIGN_PROVIDER        = "dropbox_sign"
  COMPANY_NAME          = "Security Of America"
  MAIL_ALLOWLIST        = "tester@REPLACE.example"
}
