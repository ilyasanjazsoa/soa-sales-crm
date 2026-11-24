# Environments

`staging.tfvars` and `production.tfvars` hold the non-secret settings. Values marked `REPLACE` must come from the
company (domain, certificate, office/VPN ranges, alarm list, Entra app, Bedrock model ids). Secrets are never in
these files: they go in the Secrets Manager secret `soa-crm-<env>/app` (see docs/RUNBOOK.md).

```
terraform init -backend-config="bucket=<state bucket>" -backend-config="key=soa-crm/staging.tfstate" \
  -backend-config="region=us-east-1" -backend-config="dynamodb_table=<lock table>"
terraform plan -var-file=envs/staging.tfvars
```
