# Mailpoppy provisioning policy

This is the least-privilege IAM policy the Step 0 readiness gate refers to — attach it to the
IAM user/role you run Mailpoppy as, **instead of full `AdministratorAccess`**.

- [`mailpoppy-provisioning-policy.json`](./mailpoppy-provisioning-policy.json) — the raw policy
  document (attach as a customer-managed policy).
- [`mailpoppy-provisioning-role.yaml`](./mailpoppy-provisioning-role.yaml) — CloudFormation that
  creates the managed policy (and optionally attaches it to a user) in one click.

## What it grants (current scope)

Covers everything the desktop sidecar does directly in the customer's account — domain setup,
backend stack lifecycle, mailbox admin, IMAP migration, per-domain settings, and the
Sending-health reads. The table below is kept **exactly** in step with the AWS SDK commands in
`apps/desktop/node-sidecar/src/{provisioning,migration}.ts` — no gaps, no excess.

| Service | Actions | Why |
|---|---|---|
| STS | `GetCallerIdentity` | Readiness: confirm credentials resolve |
| IAM (`Resource: *`) | `SimulatePrincipalPolicy` | **Read-only** capability check — powers the app's "AWS permissions" lights (which tiers this identity actually has). Evaluates policy; changes nothing |
| Route53 (`Resource: *`) | `ListHostedZonesByName`, `ListResourceRecordSets`, `ChangeResourceRecordSets` | Publish (and on teardown remove) MX / SPF / DKIM / DMARC records |
| SES (`Resource: *`) | `CreateEmailIdentity`, `GetEmailIdentity`, `ListEmailIdentities`, `DeleteEmailIdentity`, `GetAccount`, `GetSendStatistics`, `PutAccountDetails`, `PutEmailIdentityMailFromAttributes`, `SendEmail`, `CreateReceiptRuleSet`, `CreateReceiptRule`, `DescribeActiveReceiptRuleSet`, `SetActiveReceiptRuleSet` | Verify the domain, route inbound → S3, send test mail, sandbox-exit (`PutAccountDetails`), custom MAIL FROM (`PutEmailIdentityMailFromAttributes`), and read account sending/bounce stats for the Sending-health view |
| S3 readiness (`Resource: *`) | `ListAllMyBuckets` | Readiness probe |
| S3 on `mailpoppy-*` + `mailpoppymailstack-*` | bucket: `CreateBucket`, `DeleteBucket`, `PutBucketPolicy`, `ListBucket`; object: `PutObject`, `DeleteObject` | Create the deploy bucket + upload the stack template/Lambda zip; write **migrated** mail into the mail bucket; empty + delete both buckets on teardown |
| CloudFormation on `stack/MailpoppyMailStack/*` | `DescribeStacks`, `DescribeStackResources`, `CreateStack`, `UpdateStack`, `DeleteStack` | Deploy / update / tear down the backend stack, and read its inventory for the resource-transparency view (DESIGN §14.1) |
| DynamoDB on `table/MailpoppyMailStack-*` | `PutItem`, `BatchWriteItem`, `GetItem`, `Query`, `Scan`, `DeleteItem`, `DeleteTable` | Write migrated messages + per-mailbox quota / per-domain settings; **`Scan`** powers the Sending-health suppression-list (`SUPPRESS#`) and per-domain bounce/complaint + DMARC counter reads; `DeleteTable` on teardown |
| Cognito on `userpool/*` | `AdminCreateUser`, `AdminSetUserPassword`, `AdminDeleteUser`, `ListUsers`, `DeleteUserPool` | Create / list / delete mailboxes (Cognito users); delete the pool on teardown |

**Scoping notes:** S3 is locked to **`mailpoppy-*`** (deploy bucket) and **`mailpoppymailstack-*`**
(the stack's mail bucket); DynamoDB to **`MailpoppyMailStack-*`** tables; CloudFormation to the
**`MailpoppyMailStack`** stack. Route53, SES and Cognito use `Resource: "*"` because AWS offers
only coarse resource-level control for those actions (the Cognito user-pool id is created at
deploy time and isn't known in advance) — the tightening there is via the explicit *action*
allow-list. Both policy files (`.json` and `.yaml`) grant an identical action set.

## Apply it

**Option A — CloudFormation (recommended):**

```bash
aws cloudformation deploy \
  --template-file mailpoppy-provisioning-role.yaml \
  --stack-name mailpoppy-provisioning \
  --parameter-overrides AttachToUser=<your-iam-user> \
  --capabilities CAPABILITY_NAMED_IAM
# omit AttachToUser to just create the policy and attach it yourself
```

**Option B — attach the JSON** as a customer-managed policy in the IAM console (Policies →
Create → JSON → paste `mailpoppy-provisioning-policy.json`), then attach to your user/role.

## Deploy-time policy (the backend stack)

Deploying the backend (DESIGN §15) — `cloudformation:CreateStack` with the shipped template —
needs a **broader** set than provisioning, because the stack itself creates IAM roles (the
Lambda execution roles, the Cognito SMS role, the custom-resource role). That set is a
**separate, clearly-labelled policy** so the narrow provisioning policy above stays narrow:

- [`mailpoppy-deploy-policy.json`](./mailpoppy-deploy-policy.json) — the raw deploy permissions.
- [`mailpoppy-deploy-role.yaml`](./mailpoppy-deploy-role.yaml) — CloudFormation that creates a
  **deployment service role** holding those permissions, plus an optional narrow `MailpoppyDeployer`
  policy for the admin.

It covers exactly what `MailpoppyMailStack` creates (verified against a real deploy): **CloudFormation**,
**IAM** role lifecycle + `PassRole`, **Lambda**, **DynamoDB**, **Cognito**, **API Gateway (v2)**
(incl. `TagResource` for the auto-tagged stage), **SNS**, **EventBridge**, **SES** (receipt rules +
identity), **S3** (incl. `PutBucketCORS` for the presigned-upload bucket), **GuardDuty** (the optional
Malware Protection plan, on by default), **CloudWatch Logs**.
Everything is scoped to **`MailpoppyMailStack-*`** / **`mailpoppy*`** resources where AWS supports
resource-level permissions. `PassRole` is constrained by **resource** to this stack's own roles
(`role/MailpoppyMailStack-*` — the Lambda exec roles, the Cognito SMS role, the GuardDuty scan role);
it deliberately carries **no** `iam:PassedToService` condition, because some services (notably Cognito
`CreateUserPool`) don't populate that condition key, so a condition there silently denies the pass and
the whole stack rolls back.
Validated: `cloudformation validate-template` (CAPABILITY_NAMED_IAM) + `accessanalyzer
validate-policy` → **no findings**.

### Recommended shape (keeps the human least-privileged)

Don't put the broad set on a person. Instead:

1. Deploy `mailpoppy-deploy-role.yaml` → it creates **`MailpoppyDeploymentRole`** (assumable by
   CloudFormation) that holds the broad perms.
2. The desktop passes that role's ARN as the **`RoleARN`** on `CreateStack`/`UpdateStack`, so
   *CloudFormation* — not the admin — exercises the create permissions.
3. The admin's own identity only needs `cloudformation:*` on Mailpoppy stacks + `iam:PassRole`
   for the role — the optional **`MailpoppyDeployer`** policy (pass `AttachDeployerToUser`).

```bash
aws cloudformation deploy \
  --template-file mailpoppy-deploy-role.yaml \
  --stack-name mailpoppy-deploy-role \
  --parameter-overrides AttachDeployerToUser=<your-iam-user> \
  --capabilities CAPABILITY_NAMED_IAM
# omit AttachDeployerToUser to just create the deployment role
```

> **Dev/CDK note:** if you instead deploy with `cdk deploy` into a **bootstrapped** account (as
> in the live Phase 2 test), CDK assumes the `cdk-hnb659fds-*` bootstrap roles, so the caller only
> needs `sts:AssumeRole` on those — the broad policy above is for the **product path**
> (`cloudformation:CreateStack` with no CDK/bootstrap in the customer's account).
