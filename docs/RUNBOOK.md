# Runbook

How to run the Sales CRM in staging and production (ARCHITECTURE.md §16). Commands assume the AWS CLI is signed in
to the right account and region, and `ENV` is `staging` or `production`.

```
ENV=staging
CLUSTER=soa-crm-$ENV
SECRET=soa-crm-$ENV/app
```

## Contents
1. First deploy
2. Deploy
3. Rollback
4. Restore from backup
5. Rotate secrets
6. Reconnect a mailbox
7. Add a user
8. Alarms and what they mean
9. Routine checks

---

## 1. First deploy

Once per environment.

1. **State storage.** Create an S3 bucket (versioned, encrypted) and a DynamoDB table with partition key `LockID`
   for the Terraform state.
2. **Certificate.** Request an ACM certificate for the domain (DNS validation) in the same region.
3. **Settings.** Fill in the `REPLACE` values in `infra/envs/$ENV.tfvars`: domain, certificate, office and VPN
   ranges (DECISIONS.md G), the alarm email list, the Entra app, Bedrock model ids. Staging must set
   `MAIL_ALLOWLIST`.
4. **Infrastructure.**
   ```
   cd infra
   terraform init -backend-config="bucket=<state bucket>" -backend-config="key=soa-crm/$ENV.tfstate" \
     -backend-config="region=us-east-1" -backend-config="dynamodb_table=<lock table>"
   terraform plan -var-file=envs/$ENV.tfvars    # read it; nothing should be destroyed
   terraform apply -var-file=envs/$ENV.tfvars
   ```
   Confirm the alarm email subscription (AWS sends a confirmation link).
5. **DNS.** Point the domain at the `load_balancer_dns` output.
6. **Database roles.** The RDS master user (`crm_owner`, password in Secrets Manager under the RDS-managed
   secret) owns the schema and runs migrations. Create the app's login, which may only act as `crm_app`:
   ```sql
   -- connect as crm_owner (e.g. from a one-off task or a bastion)
   CREATE ROLE crm_app_login LOGIN PASSWORD '<new random password>' IN ROLE crm_app;
   ```
   `crm_app` itself is created by the first migration. The api refuses to start if its login is a superuser, owns
   the schema, or can change `audit_log`.
7. **Secrets.** Fill the secret (see section 5 for each value), then deploy (section 2). The first deploy's
   migration task creates the schema. The database URLs must verify the server's certificate (the image includes
   the RDS certificate authorities):
   `postgres://crm_app_login:<password>@<db_endpoint>:5432/crm?sslmode=verify-full`. `MIGRATION_DATABASE_URL` is
   the same with the `crm_owner` login, and only the migration task receives it.
8. **GitHub.** In the repository settings, create the environments `staging` and `production`. Restrict both to the
   protected `main` branch ("Deployment branches": selected branches → `main`), and give production required
   reviewers. The AWS deploy role also trusts only `deploy.yml` on `main`. For each environment, set these
   variables:
   - `AWS_REGION`
   - `DEPLOY_ROLE_ARN` (the `deploy_role_arn` output)
   - `ECR_REPOSITORY` (the `ecr_repository` output)
   - `DOMAIN_NAME`

## 2. Deploy

- **Staging:** every merge to `main` deploys automatically (workflow "Deploy").
- **Production:** Actions → Deploy → Run workflow → `production`. A reviewer approves the environment.

Each run does these steps, and stops at the first failure:
1. Builds the image.
2. Pushes it, tagged with the commit SHA.
3. Registers new task definitions.
4. Runs the **migration task** and waits for exit code 0.
5. Rolls `api` then `worker`.
6. Waits until both are stable.
7. Checks `/healthz`.

**Migrations must work with the version still running:** add columns and tables first, and remove them in a later
release. ECS's deployment circuit breaker rolls a service back by itself if new tasks fail their health checks.

## 3. Rollback

The service didn't start: the circuit breaker already rolled back. Check the service events:
```
aws ecs describe-services --cluster $CLUSTER --services api worker --query 'services[].events[:5]'
```

The new version runs but is wrong: point the services at the previous task definition revision.
```
aws ecs list-task-definitions --family-prefix $CLUSTER-api --sort DESC --max-items 3
aws ecs update-service --cluster $CLUSTER --service api    --task-definition $CLUSTER-api:<previous revision>
aws ecs update-service --cluster $CLUSTER --service worker --task-definition $CLUSTER-worker:<previous revision>
aws ecs wait services-stable --cluster $CLUSTER --services api worker
```
Migrations are not rolled back automatically. Because they are backward compatible, the previous version runs on
the new schema. If a migration itself is the problem, write a new migration that fixes it. Never edit an applied
one.

## 4. Restore from backup

RDS keeps automated backups with **14-day point-in-time recovery**. Every night the worker checks that the latest
restore point is under 26 hours old (alarm "backup-check").

**Restore into a scratch database:** weekly test, or to recover data.
```
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier soa-crm-$ENV \
  --target-db-instance-identifier soa-crm-$ENV-restore-$(date +%Y%m%d) \
  --restore-time 2026-11-20T15:00:00Z \
  --db-subnet-group-name soa-crm-$ENV --vpc-security-group-ids <db security group> \
  --db-instance-class db.t4g.small --no-multi-az --no-publicly-accessible
aws rds wait db-instance-available --db-instance-identifier soa-crm-$ENV-restore-$(date +%Y%m%d)
```
(Use `--use-latest-restorable-time` instead of `--restore-time` for the most recent point.)
Then check it, from a task in the VPC, compare the row counts with production for `users`, `accounts`, `deals`,
`activities` and `audit_log`, and **delete the scratch instance** afterwards.

**Recover the whole database** (the last resort): restore as above, run the migration task against the restored
instance, put its address in `DATABASE_URL` and `MIGRATION_DATABASE_URL` in the secret, then redeploy (section 2)
so the tasks pick it up. Rename instances only during a maintenance window.

**Recover single rows** (for example, an account purged by mistake): restore to a scratch instance from just
before the change, then `pg_dump --data-only -t <table> --where` the rows into production. Do this with a second
person and record it.

**Drill log.**

| Date | Where | What | Time | Result |
|---|---|---|---|---|
| 2026-11-24 | Local (Docker, the seeded database, 13 MB) | `pg_dump -Fc` and `pg_restore -j 4` into a scratch database; row counts compared for 7 tables | 0.3 s | All counts matched |
| (pending) | Staging RDS | Point-in-time restore to a scratch instance, as above | Typically 10–20 min for this size | Needs the company's AWS account |

## 5. Rotate secrets

All app secrets are in the Secrets Manager secret `soa-crm-$ENV/app` (JSON). To rotate one, edit the value, then
force a new deployment so the tasks read it:
```
aws ecs update-service --cluster $CLUSTER --service api    --force-new-deployment
aws ecs update-service --cluster $CLUSTER --service worker --force-new-deployment
```

| Key | Make a new one with | What happens when it changes |
|---|---|---|
| `SESSION_SECRET` | `openssl rand -hex 32` | Everyone is signed out (CSRF tokens change) |
| `TOKEN_ENC_KEY` | `openssl rand -hex 32` | Stored mailbox tokens can't be read: every rep must sign in again. Rotate only if it may have leaked |
| `UNSUBSCRIBE_SECRET` | `openssl rand -hex 32` | Unsubscribe links in emails already sent stop working. Rotate only if it may have leaked |
| `IP_HASH_SALT` | `openssl rand -hex 32` | Proposal view counts start a new series |
| Database password (`crm_app_login`) | `ALTER ROLE crm_app_login PASSWORD '…'`, then update `DATABASE_URL` | No downtime if you deploy right after |
| `OIDC_CLIENT_SECRET` | Entra admin centre → app → Certificates & secrets | Add the new secret, deploy, then delete the old one |
| `ESIGN_API_KEY` / `ESIGN_WEBHOOK_SECRET` | Dropbox Sign → API settings | Update both places, then deploy |
| `MAPS_API_KEY` | Google Cloud console | Restrict the key to the Geocoding and Distance Matrix APIs |

The four app secrets must each be 64 hex characters and must differ. The app refuses to start otherwise.

## 6. Reconnect a mailbox

When a rep's Microsoft 365 permission expires or is revoked:
- the app shows them a banner;
- sending and calendar booking return "Reconnect";
- the alarm "mailbox-reconnect" fires.

**Fix:** the rep clicks **Reconnect** on the banner, or signs out and back in, and accepts the consent. That stores
new tokens and clears `needs_reconnect`. Emails that failed meanwhile show "Not sent" with a **Retry** button.

To find who is affected:
```sql
SELECT u.email FROM oauth_accounts o JOIN users u ON u.id = o.user_id WHERE o.needs_reconnect;
```
If it happens to everyone at once, check that the Entra app's client secret hasn't expired (section 5).

## 7. Add a user

An admin opens **Admin → Users → Add user**, enters the work email (it must be in `ALLOWED_EMAIL_DOMAIN`), name and
role. The person then signs in with Microsoft. There are no passwords.

To **deactivate** someone, use Admin → Users. Their sessions end, their accounts must be reassigned first, and
their mailbox sync stops.

The first admin comes from `BOOTSTRAP_ADMIN_EMAIL`.

## 8. Alarms and what they mean

All alarms email the list in `alarm_email`. Each one also sends an OK message when it clears.

| Alarm | Means | First steps |
|---|---|---|
| `5xx-rate` | Over 2% of requests failed for 10 minutes | Check `/soa-crm-$ENV/api` logs for `"level":50`. Was there a deploy? Roll back (section 3) |
| `p95-latency` | Slow responses (p95 over 2 s for 15 minutes) | Check RDS CPU and Performance Insights for slow queries, and api CPU and memory in Container Insights |
| `no-healthy-api` | No api task passes `/readyz` | Usually the database is unreachable or the secret is wrong. Check the service events and task logs |
| `job-failures` | 3 or more background jobs failed in 15 minutes | Check `/soa-crm-$ENV/worker` logs for `"job failed"` and its `job` name. Mail: Graph outage or permission; research: Bedrock |
| `queue-age` | A job waited over 10 minutes, or the worker sends no numbers | Is the worker service running? Restart it (`--force-new-deployment`) |
| `mailbox-reconnect` | A rep's mailbox needs reconnecting | Section 6 |
| `backup-check` | No restore point in the last 26 hours | Check RDS automated backups and events. Take a manual snapshot now |
| `db-storage` | Under 10 GB free | Storage autoscaling goes to 200 GB; raise `max_allocated_storage` if it's near that |
| `db-cpu` | Database CPU over 80% for 15 minutes | Performance Insights; consider the next instance size |

## 9. Routine checks

- **Weekly:** a restore test into a scratch instance (section 4). Record it in the drill log.
- **Monthly:** the `pnpm audit` result in CI, and the ECR scan findings for the latest image.
- **Every 6 months, or when someone leaves:** check Admin → Users, and rotate `SESSION_SECRET`.
- **Every year:** renew the Entra client secret before it expires. The ACM certificate renews itself.
