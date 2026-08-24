/**
 * Mailpoppy provisioning engine — the TypeScript translation of the validated
 * Phase 0 sequence (see ../../../../phase0-derisk.md, which PASSED live on
 * ollydigital.com / eu-west-1). Runs in the desktop Node sidecar using the
 * admin's AWS credential chain (named profile / SSO). DESKTOP-ADMIN-ONLY —
 * mobile never runs this (DESIGN §6).
 *
 * The eventual production path deploys the *full* backend via a CloudFormation
 * template (cdk synth → cloudformation:CreateStack). These direct calls cover
 * the core mail wiring and the health/verification UX of the Phase 1 wizard.
 */
import { spawnSync } from "node:child_process";
import { fromIni } from "@aws-sdk/credential-providers";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  Route53Client,
  ListHostedZonesByNameCommand,
  ListResourceRecordSetsCommand,
  ChangeResourceRecordSetsCommand,
  type Change,
  type ResourceRecord,
  type RRType,
} from "@aws-sdk/client-route-53";
import {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  ListEmailIdentitiesCommand,
  DeleteEmailIdentityCommand,
  SendEmailCommand,
  GetAccountCommand,
  PutAccountDetailsCommand,
  PutEmailIdentityMailFromAttributesCommand,
  DeleteSuppressedDestinationCommand,
} from "@aws-sdk/client-sesv2";
import {
  SESClient,
  CreateReceiptRuleSetCommand,
  CreateReceiptRuleCommand,
  SetActiveReceiptRuleSetCommand,
  DescribeActiveReceiptRuleSetCommand,
  GetSendStatisticsCommand,
  SetIdentityNotificationTopicCommand,
  SetIdentityHeadersInNotificationsEnabledCommand,
} from "@aws-sdk/client-ses";
import {
  S3Client,
  CreateBucketCommand,
  PutBucketPolicyCommand,
  ListBucketsCommand,
  PutObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  DeleteTableCommand,
  QueryCommand,
  ScanCommand,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  BatchWriteItemCommand,
  type AttributeValue,
  type WriteRequest,
  type BatchWriteItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import {
  mailboxPk,
  addressDomain,
  liveDomainIdentities,
  suppressionKey,
  liveRecipientIdentities,
  quotaSettingsKey,
  agentOwnedSettingsKey,
  validateProductionAccessRequest,
  defaultMailFromDomain,
  mailFromDnsRecords,
  policySettingsKey,
  normalizeSpamPolicy,
  retentionSettingsKey,
  normalizeRetention,
  sendSettingsKey,
  normalizeSendSettings,
  type SendSettings,
  rate,
  type MailboxStorage,
  type SesAccountStatus,
  type SesReviewStatus,
  type ProductionAccessRequest,
  recipientVerificationState,
  type RecipientVerification,
  type MailFromState,
  type MailFromStatus,
  type DnsRecord,
  type SpamPolicy,
  type RetentionSettings,
  type DeliverabilityStatus,
  type DeliverabilityOverview,
  type DomainDeliverability,
  type DomainDmarc,
  type SendingTotals,
  type SuppressedAddress,
  SES_INBOUND_REGIONS,
} from "@mailpoppy/core";
import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  CreateStackCommand,
  UpdateStackCommand,
  DeleteStackCommand,
  waitUntilStackDeleteComplete,
  type Capability,
} from "@aws-sdk/client-cloudformation";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { templateJson, lambdaZipBase64, lambdaCodeKey, updateManifest } from "./generated/backend-bundle";
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDeleteUserCommand,
  ListUsersCommand,
  DeleteUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { record, readLedger, type LedgerEntry } from "./ledger";
import { brokerCredentials, brokerStackTags, isBrokerEnabled, brokerConnected, brokerAccountId } from "./agentspoppyBroker";

export interface AwsContext {
  region: string;
  profile?: string;
}

function clients(ctx: AwsContext) {
  // Credential source. When AgentsPoppy broker mode is on AND a connection is
  // approved, AWS calls go through short-lived broker-vended credentials (so
  // AgentsPoppy governs + can tear down what we deploy). Otherwise we resolve the
  // local ~/.aws `mailpoppy` profile exactly as before.
  //
  // The sidecar is long-lived and the credentials file legitimately changes
  // underneath it during onboarding: the in-app "paste keys" path writes a
  // [mailpoppy] profile, and so does `aws configure --profile mailpoppy`. The SDK
  // memoises ~/.aws/credentials per path for the whole process, so a profile
  // written *after* the first read would resolve against a stale parse — surfacing
  // as "Could not resolve credentials using profile: [mailpoppy]" right after the
  // user pastes valid keys. `ignoreCache` forces a fresh read on every call.
  const credentials =
    brokerCredentials() ?? (ctx.profile ? fromIni({ profile: ctx.profile, ignoreCache: true }) : undefined);
  const base = { region: ctx.region, credentials };
  return {
    sts: new STSClient(base),
    // Route53 is a global service; pin to us-east-1.
    route53: new Route53Client({ ...base, region: "us-east-1" }),
    sesv2: new SESv2Client(base),
    ses: new SESClient(base),
    s3: new S3Client(base),
    cloudformation: new CloudFormationClient(base),
    cognito: new CognitoIdentityProviderClient(base),
    lambda: new LambdaClient(base),
    dynamodb: new DynamoDBClient(base),
  };
}

/** Read-only: who am I? (phase0 §1) */
export async function getAccountId(ctx: AwsContext): Promise<string> {
  const { sts } = clients(ctx);
  const out = await sts.send(new GetCallerIdentityCommand({}));
  if (!out.Account) throw new Error("Could not resolve AWS account id");
  return out.Account;
}

/** Read-only: find the hosted zone for an apex domain. (phase0 §1) */
export async function findHostedZoneId(ctx: AwsContext, domain: string): Promise<string> {
  const { route53 } = clients(ctx);
  const out = await route53.send(new ListHostedZonesByNameCommand({ DNSName: domain }));
  const zone = out.HostedZones?.find((z) => z.Name === `${domain}.`);
  if (!zone?.Id) throw new Error(`No Route53 hosted zone found for ${domain}`);
  return zone.Id.replace("/hostedzone/", "");
}

/** Step 2: create the SES domain identity; return its 3 DKIM CNAME tokens. */
export async function createIdentityGetDkimTokens(ctx: AwsContext, domain: string): Promise<string[]> {
  const { sesv2 } = clients(ctx);
  try {
    const out = await sesv2.send(new CreateEmailIdentityCommand({ EmailIdentity: domain }));
    await record([
      { action: "created", service: "SES", resourceType: "EmailIdentity", name: domain, region: ctx.region },
    ]);
    return out.DkimAttributes?.Tokens ?? [];
  } catch (e) {
    if ((e as { name?: string }).name === "AlreadyExistsException") {
      // The identity already exists — the usual case when ADOPTING a pre-existing
      // domain the user created outside MailPoppy.
      const out = await sesv2.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
      const status = out.DkimAttributes?.Status;
      const origin = out.DkimAttributes?.SigningAttributesOrigin;

      // SES-managed Easy DKIM stuck in the *sticky* FAILED state — the usual reason
      // an adopted domain sits at "verifying" forever. A domain whose DKIM CNAMEs
      // were never published inside SES's verification window is marked FAILED, and
      // SES will NOT re-check it just because the records reappear: FAILED is
      // terminal. Reset it to a clean slate by DELETING and RECREATING the identity,
      // which starts Easy DKIM afresh with new tokens (status PENDING); the caller
      // then publishes those tokens' CNAMEs. We do this with grants MailPoppy already
      // holds (Delete/CreateEmailIdentity) rather than PutEmailIdentityDkimSigning-
      // Attributes, so it needs no new permission and no re-consent. Safe because a
      // FAILED identity is unverified and not sending — there's no verified config to
      // lose. Only FAILED triggers this: PENDING/NOT_STARTED are already progressing
      // (recreating would needlessly restart the clock on every retry/app-reopen), and
      // a customer-managed EXTERNAL (BYODKIM) identity is left untouched.
      if (status === "FAILED" && origin !== "EXTERNAL") {
        await sesv2.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain }));
        const recreated = await sesv2.send(new CreateEmailIdentityCommand({ EmailIdentity: domain }));
        // Record it as a managed EmailIdentity so this adopted domain is henceforth
        // recognised by discoverProvisionedDomains — teardown cleans it up, and a
        // later app-reopen resumes it to a now-winnable "verifying" rather than
        // routing back through the provision step.
        await record([
          {
            action: "created",
            service: "SES",
            resourceType: "EmailIdentity",
            name: domain,
            region: ctx.region,
            detail: "adopted pre-existing domain; reset Easy DKIM (was FAILED) via delete+recreate",
          },
        ]);
        return recreated.DkimAttributes?.Tokens ?? [];
      }

      // Otherwise reuse the identity's existing tokens: already SUCCESS (verified),
      // PENDING / NOT_STARTED (SES is already checking — don't disturb), or a
      // customer-managed EXTERNAL (BYODKIM) identity we must not reconfigure.
      return out.DkimAttributes?.Tokens ?? [];
    }
    throw e;
  }
}

/**
 * Read existing apex TXT values so we MERGE rather than clobber when adding SPF.
 * (Phase 0 gotcha: Route53 UPSERT replaces the whole record set for a name+type.)
 */
async function existingApexTxt(ctx: AwsContext, zoneId: string, domain: string): Promise<string[]> {
  const { route53 } = clients(ctx);
  const out = await route53.send(new ListResourceRecordSetsCommand({ HostedZoneId: zoneId }));
  const set = out.ResourceRecordSets?.find((r) => r.Name === `${domain}.` && r.Type === "TXT");
  return (set?.ResourceRecords ?? []).map((r) => r.Value).filter((v): v is string => !!v);
}

/** Steps 2–6 (DNS): DKIM CNAMEs + MX + SPF (merged) + DMARC. Returns the change id. */
export async function applyDnsRecords(
  ctx: AwsContext,
  opts: { zoneId: string; domain: string; dkimTokens: string[]; dmarcRua: string },
): Promise<string> {
  const { route53 } = clients(ctx);
  const { zoneId, domain, dkimTokens, dmarcRua } = opts;

  const dkim: Change[] = dkimTokens.map((t) => ({
    Action: "UPSERT",
    ResourceRecordSet: {
      Name: `${t}._domainkey.${domain}`,
      Type: "CNAME",
      TTL: 300,
      ResourceRecords: [{ Value: `${t}.dkim.amazonses.com` }],
    },
  }));

  const existing = await existingApexTxt(ctx, zoneId, domain);
  const txtRecords: ResourceRecord[] = [
    ...existing.filter((v) => !v.includes("v=spf1")).map((Value) => ({ Value })),
    { Value: `"v=spf1 include:amazonses.com ~all"` },
  ];

  const changes: Change[] = [
    ...dkim,
    {
      Action: "UPSERT",
      ResourceRecordSet: {
        Name: domain,
        Type: "MX",
        TTL: 300,
        ResourceRecords: [{ Value: `10 inbound-smtp.${ctx.region}.amazonaws.com` }],
      },
    },
    {
      Action: "UPSERT",
      ResourceRecordSet: { Name: domain, Type: "TXT", TTL: 300, ResourceRecords: txtRecords },
    },
    {
      Action: "UPSERT",
      ResourceRecordSet: {
        Name: `_dmarc.${domain}`,
        Type: "TXT",
        TTL: 300,
        ResourceRecords: [{ Value: `"v=DMARC1; p=none; rua=mailto:${dmarcRua}"` }],
      },
    },
  ];

  const out = await route53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      ChangeBatch: { Comment: "Mailpoppy provisioning", Changes: changes },
    }),
  );

  // Record each DNS record we wrote (these live outside the CloudFormation stack).
  await record(
    changes.map((ch) => ({
      action: "created" as const,
      service: "Route53",
      resourceType: `${ch.ResourceRecordSet?.Type} record`,
      name: ch.ResourceRecordSet?.Name ?? domain,
      region: ctx.region,
      detail: `zone ${zoneId}`,
    })),
  );
  return out.ChangeInfo?.Id ?? "";
}

/** Step 3: S3 bucket + policy that lets SES write received mail. */
export async function createMailBucket(
  ctx: AwsContext,
  opts: { bucket: string; accountId: string },
): Promise<void> {
  const { s3 } = clients(ctx);
  const { bucket, accountId } = opts;
  await s3.send(
    new CreateBucketCommand({
      Bucket: bucket,
      ...(ctx.region === "us-east-1"
        ? {}
        : { CreateBucketConfiguration: { LocationConstraint: ctx.region as never } }),
    }),
  );
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowSESPuts",
        Effect: "Allow",
        Principal: { Service: "ses.amazonaws.com" },
        Action: "s3:PutObject",
        Resource: `arn:aws:s3:::${bucket}/*`,
        Condition: {
          StringEquals: { "aws:SourceAccount": accountId },
          StringLike: { "aws:SourceArn": `arn:aws:ses:${ctx.region}:${accountId}:receipt-rule-set/*` },
        },
      },
    ],
  };
  await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }));
  await record([
    { action: "created", service: "S3", resourceType: "Bucket", name: bucket, region: ctx.region },
  ]);
}

/** Step 4: receipt rule set + rule (store to S3) + activate. */
export async function createReceiptPipeline(
  ctx: AwsContext,
  opts: { ruleSet: string; domain: string; bucket: string; prefix?: string },
): Promise<void> {
  const { ses } = clients(ctx);
  const { ruleSet, domain, bucket, prefix = "inbound/" } = opts;
  await ses.send(new CreateReceiptRuleSetCommand({ RuleSetName: ruleSet }));
  await ses.send(
    new CreateReceiptRuleCommand({
      RuleSetName: ruleSet,
      Rule: {
        Name: "store-to-s3",
        Enabled: true,
        Recipients: [domain],
        ScanEnabled: true,
        Actions: [{ S3Action: { BucketName: bucket, ObjectKeyPrefix: prefix } }],
      },
    }),
  );
  await ses.send(new SetActiveReceiptRuleSetCommand({ RuleSetName: ruleSet }));
  await record([
    { action: "created", service: "SES", resourceType: "ReceiptRuleSet", name: ruleSet, region: ctx.region },
    { action: "created", service: "SES", resourceType: "ActiveReceiptRuleSet", name: ruleSet, region: ctx.region, detail: "set active" },
  ]);
}

// ---- Resource inventory (DESIGN §14.1 — transparency) ----

export interface StackResource {
  logicalId: string;
  physicalId: string;
  type: string; // CloudFormation type, e.g. "AWS::Lambda::Function"
  status: string;
}

/**
 * The authoritative inventory of everything in the deployed backend stack, read
 * straight from CloudFormation (no drift — the app cannot hide a stack resource).
 * Returns stackExists=false (not an error) when the stack hasn't been deployed.
 */
export async function listStackResources(
  ctx: AwsContext,
  stackName: string,
): Promise<{ stackExists: boolean; resources: StackResource[] }> {
  const { cloudformation } = clients(ctx);
  try {
    const out = await cloudformation.send(new DescribeStackResourcesCommand({ StackName: stackName }));
    const resources = (out.StackResources ?? []).map((r) => ({
      logicalId: r.LogicalResourceId ?? "",
      physicalId: r.PhysicalResourceId ?? "",
      type: r.ResourceType ?? "",
      status: r.ResourceStatus ?? "",
    }));
    return { stackExists: true, resources };
  } catch (e) {
    if (/does not exist|ValidationError/i.test((e as Error).message ?? "")) {
      return { stackExists: false, resources: [] };
    }
    throw e;
  }
}

/**
 * Read the deployed stack's CloudFormation Outputs as a key→value map (e.g.
 * `MailBucketName`, `IndexTableName`, `ApiBaseUrl`). Used to resolve the data
 * resources a migration needs to write into, without the desktop having to
 * persist them separately.
 */
export async function getStackOutputs(
  ctx: AwsContext,
  stackName: string,
): Promise<Record<string, string>> {
  const { cloudformation } = clients(ctx);
  const out = await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = out.Stacks?.[0]?.Outputs ?? [];
  const map: Record<string, string> = {};
  for (const o of outputs) {
    if (o.OutputKey) map[o.OutputKey] = o.OutputValue ?? "";
  }
  return map;
}

// ---- One-click backend deploy (CloudFormation, no cdk/bootstrap at runtime) ----

/** Current stack status, or null if the stack doesn't exist. */
async function stackStatus(ctx: AwsContext, stackName: string): Promise<string | null> {
  const { cloudformation } = clients(ctx);
  try {
    const out = await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }));
    return out.Stacks?.[0]?.StackStatus ?? null;
  } catch (e) {
    if (/does not exist|ValidationError/i.test((e as Error).message ?? "")) return null;
    throw e;
  }
}

// The one backend stack name every install uses (see desktop deploymentConfig.ts).
// Hard-coded across the routes; named here for the cross-region discovery probe.
const MAILPOPPY_STACK_NAME = "MailpoppyMailStack";

export interface SesDomainIdentity {
  name: string;
  /** SES says this domain is verified for sending (DKIM/identity confirmed). */
  verified: boolean;
  /** SES sending is enabled for the identity (not paused). */
  sendingEnabled: boolean;
}

/**
 * Read-only: every SES *domain* identity in the active region — INCLUDING domains
 * created outside MailPoppy (verified directly in the SES console, by another tool,
 * or before this app existed). The dashboard uses this so the admin sees what is
 * already in their cloud and can adopt a domain instead of wondering why a domain
 * they know they verified isn't listed. Email-ADDRESS identities are filtered out:
 * those are single verified senders, not domains MailPoppy manages mail for.
 */
export async function listSesDomains(ctx: AwsContext): Promise<SesDomainIdentity[]> {
  const { sesv2 } = clients(ctx);
  const domains: SesDomainIdentity[] = [];
  let token: string | undefined;
  do {
    const page = await sesv2.send(new ListEmailIdentitiesCommand({ PageSize: 100, NextToken: token }));
    for (const id of page.EmailIdentities ?? []) {
      if (id.IdentityType !== "DOMAIN" || !id.IdentityName) continue;
      domains.push({
        name: id.IdentityName.toLowerCase(),
        verified: id.VerificationStatus === "SUCCESS",
        sendingEnabled: id.SendingEnabled !== false,
      });
    }
    token = page.NextToken;
  } while (token);
  domains.sort((a, b) => a.name.localeCompare(b.name));
  return domains;
}

export interface RegionScan {
  region: string;
  /** Does the MailPoppy backend stack live in this region? */
  stackExists: boolean;
  stackStatus: string | null;
  /** SES domain identities present in this region (managed or not). */
  domains: SesDomainIdentity[];
}

/**
 * Cross-region discovery over the SES inbound regions (the only places MailPoppy
 * can receive mail). For each region, in parallel: does the backend stack exist,
 * and which SES domains live there. This is the answer to "I reinstalled / cleared
 * my local state — where did my stuff go?": the stack and ALL data live in the
 * user's OWN AWS account, untouched by reinstalling, so we just have to find which
 * region holds them. Also surfaces pre-existing domains so the admin can adopt them.
 * Read-only; a region that errors (no perms, throttled) comes back empty rather than
 * failing the whole scan.
 */
export async function discoverRegions(ctx: AwsContext): Promise<RegionScan[]> {
  return Promise.all(
    SES_INBOUND_REGIONS.map(async (region): Promise<RegionScan> => {
      const rctx: AwsContext = { ...ctx, region };
      const [statusR, domainsR] = await Promise.allSettled([
        stackStatus(rctx, MAILPOPPY_STACK_NAME),
        listSesDomains(rctx),
      ]);
      const status = statusR.status === "fulfilled" ? statusR.value : null;
      return {
        region,
        stackExists: status !== null,
        stackStatus: status,
        domains: domainsR.status === "fulfilled" ? domainsR.value : [],
      };
    }),
  );
}

export interface DeployResult {
  ok: true;
  stackName: string;
  operation: "CREATE" | "UPDATE" | "NO_CHANGE" | "RECREATE";
  bucket: string;
  region: string;
}

/** Stack tags = AgentsPoppy attribution (when broker-connected) + `mailpoppy:sourceCommit`
 *  — the open-repo commit THIS build came from. Recording it on the stack lets the
 *  Update panel show from→to and lets a user/agent audit the deployed code against the
 *  public source. See docs/VERIFIABLE_UPDATES.md. */
function stackTags(
  brokerTags: { Key: string; Value: string }[] | null | undefined,
): { Key: string; Value: string }[] | undefined {
  const tags = brokerTags ? [...brokerTags, { Key: "agentspoppy:managed", Value: "mailpoppy" }] : [];
  if (updateManifest.commit) tags.push({ Key: "mailpoppy:sourceCommit", Value: updateManifest.commit });
  return tags.length ? tags : undefined;
}

/**
 * Deploy (or update) the backend stack into the admin's account WITHOUT cdk: we
 * upload the embedded asset-free template + prebuilt Lambda zip to a per-account
 * deploy bucket, then CloudFormation Create/UpdateStack referencing them. The
 * receipt rule set is activated separately (see getDeployStatus) once the stack
 * is up. Returns immediately; poll getDeployStatus for completion.
 */
export async function deployBackend(
  ctx: AwsContext,
  args: { domain: string; stackName?: string; enableMalwareProtection?: boolean; enableEncryption?: boolean },
): Promise<DeployResult> {
  // In broker mode the stack MUST carry the attribution tags, or AgentsPoppy can't
  // attribute or tear it down — so refuse to deploy until the connection is
  // approved (rather than silently falling back to the local profile).
  const brokerTags = brokerStackTags();
  if (isBrokerEnabled() && !brokerTags) {
    throw new Error(
      "AgentsPoppy broker mode is on but no approved connection — connect MailPoppy in AgentsPoppy and approve it before deploying.",
    );
  }
  // Stack-level tags CloudFormation records on the stack and propagates to every
  // taggable resource. AgentsPoppy attributes + tears down by the stable app tag
  // (`agentspoppy:app`), so this survives a connection supersede; the connection id
  // rides along only as an audit tag.
  const Tags = stackTags(brokerTags);

  const { s3, cloudformation } = clients(ctx);
  const region = ctx.region;
  const stackName = args.stackName ?? "MailpoppyMailStack";
  const domain = args.domain.trim().toLowerCase();
  const accountId = await getAccountId(ctx);
  const bucket = `mailpoppy-deploy-${accountId}-${region}`;

  // Ensure the deploy bucket exists (holds the template + Lambda code).
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        ...(region !== "us-east-1"
          ? { CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint } }
          : {}),
      }),
    );
  }

  // Upload artifacts (code key is content-addressed → idempotent).
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: lambdaCodeKey, Body: Buffer.from(lambdaZipBase64, "base64") }));
  const templateKey = `templates/${stackName}.template.json`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: templateKey, Body: templateJson, ContentType: "application/json" }));
  const templateUrl = `https://${bucket}.s3.${region}.amazonaws.com/${templateKey}`;

  const Parameters = [
    { ParameterKey: "MailDomain", ParameterValue: domain },
    { ParameterKey: "LambdaCodeBucket", ParameterValue: bucket },
    { ParameterKey: "LambdaCodeKey", ParameterValue: lambdaCodeKey },
    { ParameterKey: "EnableMalwareProtection", ParameterValue: args.enableMalwareProtection ? "true" : "false" },
    { ParameterKey: "EncryptionEnabled", ParameterValue: args.enableEncryption ? "true" : "false" },
  ];
  const Capabilities: Capability[] = ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"];

  let status = await stackStatus(ctx, stackName);
  let operation: DeployResult["operation"];

  // A previous failed create leaves ROLLBACK_COMPLETE — it can't be updated, so
  // delete it first, then create fresh.
  if (status === "ROLLBACK_COMPLETE" || status === "REVIEW_IN_PROGRESS") {
    await cloudformation.send(new DeleteStackCommand({ StackName: stackName }));
    // Deletion is async: CreateStack with the same name fails ("...already exists,
    // but previously had failed...") until the old stack is fully gone. Wait for
    // the delete to complete before recreating. Retained resources (RemovalPolicy
    // RETAIN) are DELETE_SKIPPED, so the stack still reaches DELETE_COMPLETE; the
    // waiter also treats a "does not exist" as done.
    await waitUntilStackDeleteComplete({ client: cloudformation, maxWaitTime: 300 }, { StackName: stackName });
    status = null;
    operation = "RECREATE";
    await cloudformation.send(
      new CreateStackCommand({ StackName: stackName, TemplateURL: templateUrl, Parameters, Capabilities, Tags }),
    );
  } else if (status) {
    try {
      await cloudformation.send(
        new UpdateStackCommand({ StackName: stackName, TemplateURL: templateUrl, Parameters, Capabilities, Tags }),
      );
      operation = "UPDATE";
    } catch (e) {
      if (/No updates are to be performed/i.test((e as Error).message ?? "")) operation = "NO_CHANGE";
      else throw e;
    }
  } else {
    await cloudformation.send(
      new CreateStackCommand({ StackName: stackName, TemplateURL: templateUrl, Parameters, Capabilities, Tags }),
    );
    operation = "CREATE";
  }

  await record([
    {
      action: "created",
      service: "CloudFormation",
      resourceType: "Stack",
      name: stackName,
      region,
      detail: `backend ${operation} for ${domain}`,
    },
  ]);

  return { ok: true, stackName, operation, bucket, region };
}

export interface BackendVersion {
  stackExists: boolean;
  /** The LambdaCodeKey parameter currently deployed on the stack. */
  deployedKey?: string;
  /** The content-addressed code key bundled in THIS app build. */
  currentKey: string;
  updateAvailable: boolean;
  /** CloudFormation StackStatus — lets the UI distinguish "up to date" from a stack
   *  that's mid-operation (the deployed key parameter can already read the new value
   *  while an update is still in flight or rolling back). */
  stackStatus?: string;
  /** The open-repo commit currently deployed (from the mailpoppy:sourceCommit tag), so
   *  the UI can show from→to and build the agent-audit prompt. Absent on backends
   *  deployed before provenance tagging existed. */
  deployedCommit?: string;
  /** The provenance manifest for the code in THIS app build (what an update would ship). */
  manifest: typeof updateManifest;
  stackName: string;
  region: string;
}

/**
 * Compare the app's bundled backend code (lambdaCodeKey — content-addressed, so it
 * changes whenever any Lambda handler changes) against what's actually deployed on the
 * stack (its LambdaCodeKey parameter). This is how the UI tells an existing install
 * "a newer backend shipped with your app update". Read-only.
 */
export async function getBackendVersion(ctx: AwsContext, stackName = MAILPOPPY_STACK_NAME): Promise<BackendVersion> {
  const { cloudformation } = clients(ctx);
  try {
    const out = await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }));
    const st = out.Stacks?.[0];
    const deployedKey = st?.Parameters?.find((p) => p.ParameterKey === "LambdaCodeKey")?.ParameterValue;
    const deployedCommit = st?.Tags?.find((t) => t.Key === "mailpoppy:sourceCommit")?.Value;
    return {
      stackExists: !!st,
      deployedKey,
      currentKey: lambdaCodeKey,
      updateAvailable: !!deployedKey && deployedKey !== lambdaCodeKey,
      stackStatus: st?.StackStatus,
      deployedCommit,
      manifest: updateManifest,
      stackName,
      region: ctx.region,
    };
  } catch (e) {
    if (/does not exist/i.test((e as Error).message ?? "")) {
      return {
        stackExists: false,
        currentKey: lambdaCodeKey,
        updateAvailable: false,
        manifest: updateManifest,
        stackName,
        region: ctx.region,
      };
    }
    throw e;
  }
}

/**
 * Update a DEPLOYED backend to this app build's Lambda code + template, changing ONLY
 * the code: every other stack parameter (the domain, the malware/encryption toggles) is
 * kept at its deployed value via `UsePreviousValue`, so an update can NEVER silently
 * flip a security setting the user chose. This is how a shipped backend improvement
 * reaches an existing install with no teardown and no re-keying. Returns immediately;
 * poll getDeployStatus for completion.
 */
export async function updateBackendCode(ctx: AwsContext, stackName = MAILPOPPY_STACK_NAME): Promise<DeployResult> {
  const brokerTags = brokerStackTags();
  if (isBrokerEnabled() && !brokerTags) {
    throw new Error("AgentsPoppy broker mode is on but no approved connection — connect + approve MailPoppy before updating.");
  }
  const Tags = stackTags(brokerTags);

  const { s3, cloudformation } = clients(ctx);
  const region = ctx.region;
  const status = await stackStatus(ctx, stackName);
  if (!status || status === "ROLLBACK_COMPLETE" || status === "REVIEW_IN_PROGRESS") {
    throw new Error("There's no deployed backend to update yet — deploy it first from a domain's setup.");
  }
  // Refuse to stack an update on top of an in-flight operation (deploy/update/rollback)
  // — CloudFormation would reject it with a raw error; give a clear message instead.
  if (/_IN_PROGRESS$/.test(status)) {
    throw new Error("An operation is already running on your backend — wait for it to finish, then try again.");
  }
  const accountId = await getAccountId(ctx);
  const bucket = `mailpoppy-deploy-${accountId}-${region}`;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        ...(region !== "us-east-1"
          ? { CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint } }
          : {}),
      }),
    );
  }
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: lambdaCodeKey, Body: Buffer.from(lambdaZipBase64, "base64") }));
  const templateKey = `templates/${stackName}.template.json`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: templateKey, Body: templateJson, ContentType: "application/json" }));
  const templateUrl = `https://${bucket}.s3.${region}.amazonaws.com/${templateKey}`;

  // ONLY the code key changes; every other parameter stays at its deployed value.
  const Parameters = [
    { ParameterKey: "MailDomain", UsePreviousValue: true },
    { ParameterKey: "LambdaCodeBucket", UsePreviousValue: true },
    { ParameterKey: "LambdaCodeKey", ParameterValue: lambdaCodeKey },
    { ParameterKey: "EnableMalwareProtection", UsePreviousValue: true },
    { ParameterKey: "EncryptionEnabled", UsePreviousValue: true },
  ];
  const Capabilities: Capability[] = ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"];

  let operation: DeployResult["operation"];
  try {
    await cloudformation.send(
      new UpdateStackCommand({ StackName: stackName, TemplateURL: templateUrl, Parameters, Capabilities, Tags }),
    );
    operation = "UPDATE";
  } catch (e) {
    if (/No updates are to be performed/i.test((e as Error).message ?? "")) operation = "NO_CHANGE";
    else throw e;
  }

  await record([
    {
      action: "created",
      service: "CloudFormation",
      resourceType: "Stack",
      name: stackName,
      region,
      detail: `backend code update → ${lambdaCodeKey}`,
    },
  ]);

  return { ok: true, stackName, operation, bucket, region };
}

export interface DeployStatus {
  status: string; // CloudFormation StackStatus, or "NOT_FOUND"
  complete: boolean;
  failed: boolean;
  reason?: string;
  outputs?: Record<string, string>;
  /** The stack's unique ARN. Lets the client tell a *new* stack from a leftover
   *  one with the same name (a prior failed deploy being deleted + recreated). */
  stackId?: string;
}

/**
 * Poll the deploy. When the stack reaches a *_COMPLETE state we also activate its
 * SES receipt rule set (idempotent) so inbound mail starts flowing — this is the
 * step that replaces the in-stack custom resource.
 */
export async function getDeployStatus(ctx: AwsContext, stackName: string): Promise<DeployStatus> {
  const { cloudformation, ses } = clients(ctx);
  let stack;
  try {
    const out = await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }));
    stack = out.Stacks?.[0];
  } catch (e) {
    if (/does not exist|ValidationError/i.test((e as Error).message ?? "")) {
      return { status: "NOT_FOUND", complete: false, failed: false };
    }
    throw e;
  }

  const status = stack?.StackStatus ?? "UNKNOWN";
  const outputs: Record<string, string> = {};
  for (const o of stack?.Outputs ?? []) if (o.OutputKey) outputs[o.OutputKey] = o.OutputValue ?? "";

  const complete = /_COMPLETE$/.test(status) && !status.startsWith("DELETE") && !status.includes("ROLLBACK");
  // Catch BOTH the create-rollback terminal (ROLLBACK_COMPLETE) and the update-rollback
  // terminal (UPDATE_ROLLBACK_COMPLETE) — the latter is what a failed backend UPDATE
  // settles at, and missing it left the updater hanging on a false "still working".
  const failed = /FAILED/.test(status) || /ROLLBACK_COMPLETE$/.test(status);

  if (complete && outputs.RuleSetName) {
    // Only one receipt rule set can be active per account/region — make ours it.
    try {
      await ses.send(new SetActiveReceiptRuleSetCommand({ RuleSetName: outputs.RuleSetName }));
    } catch {
      // best-effort; the wizard's domain step also confirms inbound works
    }
  }

  // The top-level StackStatusReason on a rollback is usually empty or just "The
  // following resource(s) failed to create: [...]". The actual cause (an AccessDenied,
  // a bad parameter, a service limit) lives in the per-resource events — so on failure
  // dig out the FIRST *_FAILED resource event and surface its reason. Without this the
  // UI only ever sees "error" with no way to tell why.
  let reason = stack?.StackStatusReason;
  if (failed) {
    const detail = await firstFailureReason(cloudformation, stackName);
    if (detail) reason = detail;
  }

  return { status, complete, failed, reason, outputs, stackId: stack?.StackId };
}

/**
 * The first resource-level failure in a stack's event log — what actually broke,
 * before the cascade of "Resource creation cancelled" rollbacks. Events come back
 * newest-first, so we scan to the oldest *_FAILED with a reason that isn't just the
 * generic cancellation. Best-effort: any error here just yields undefined (the caller
 * falls back to the top-level reason).
 */
async function firstFailureReason(
  cloudformation: CloudFormationClient,
  stackName: string,
): Promise<string | undefined> {
  try {
    const out = await cloudformation.send(new DescribeStackEventsCommand({ StackName: stackName }));
    const failures = (out.StackEvents ?? []).filter(
      (e) =>
        /_FAILED$/.test(e.ResourceStatus ?? "") &&
        e.ResourceStatusReason &&
        !/^Resource creation cancelled$/i.test(e.ResourceStatusReason),
    );
    const root = failures[failures.length - 1]; // oldest failure = the trigger
    if (!root) return undefined;
    const where = root.LogicalResourceId ? ` (${root.LogicalResourceId} / ${root.ResourceType ?? "?"})` : "";
    return `${root.ResourceStatusReason}${where}`;
  } catch {
    return undefined;
  }
}

// ---- Mailboxes (Cognito users in the deployed backend's user pool) ----

export interface MailboxInfo {
  email: string;
  status: string;
  createdAt?: string;
}

/**
 * Create a mailbox = a confirmed Cognito user in the backend's user pool, with a
 * permanent password (no forced reset) so the desktop/mobile client can sign in
 * immediately. Idempotent-ish: re-creating an existing user just resets the
 * password. `email` is normalized to lowercase.
 */
export async function createMailbox(
  ctx: AwsContext,
  args: { userPoolId: string; email: string; password: string },
): Promise<MailboxInfo> {
  const { cognito } = clients(ctx);
  const email = args.email.trim().toLowerCase();
  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: args.userPoolId,
        Username: email,
        MessageAction: "SUPPRESS", // no invite email; the admin sets the password here
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
        ],
      }),
    );
  } catch (e) {
    // If the user already exists we still (re)set the password below.
    if (!/UsernameExistsException/i.test((e as Error).name ?? "")) throw e;
  }
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: args.userPoolId,
      Username: email,
      Password: args.password,
      Permanent: true,
    }),
  );
  return { email, status: "CONFIRMED" };
}

/** List the mailboxes (users) in the backend's user pool. */
export async function listMailboxes(ctx: AwsContext, userPoolId: string): Promise<MailboxInfo[]> {
  const { cognito } = clients(ctx);
  const out = await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, Limit: 60 }));
  return (out.Users ?? []).map((u) => ({
    email: u.Attributes?.find((a) => a.Name === "email")?.Value ?? u.Username ?? "",
    status: u.UserStatus ?? "",
    createdAt: u.UserCreateDate?.toISOString(),
  }));
}

/**
 * Admin-set a mailbox's sign-in password to a new permanent value. Use cases:
 * recovering a departed employee's mailbox (the admin can then sign in and read
 * it), or helping a locked-out user. Sets `Permanent: true` so the new password
 * works immediately with the normal login (no forced-change challenge). The
 * password is NEVER logged or returned.
 */
export async function resetMailboxPassword(
  ctx: AwsContext,
  args: { userPoolId: string; email: string; password: string },
): Promise<{ ok: true; email: string }> {
  const { cognito } = clients(ctx);
  const email = args.email.trim().toLowerCase();
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: args.userPoolId,
      Username: email,
      Password: args.password,
      Permanent: true,
    }),
  );
  await record([
    {
      action: "updated",
      service: "Cognito",
      resourceType: "Mailbox password",
      name: email,
      region: ctx.region,
      detail: "admin reset the sign-in password",
    },
  ]);
  return { ok: true, email };
}

/**
 * Take an address off the do-not-send list, so mail to it is allowed again.
 *
 * Needed because the send path now REFUSES suppressed recipients (previously the list was
 * written and displayed but never enforced). Without an undo, one hard bounce would block
 * an address forever — e.g. a colleague whose mailbox was full for a day, or a customer
 * who has since fixed their address. Deliberately an ADMIN action: it is a deliverability
 * control, not something a mailbox user should be able to clear for themselves.
 */
export async function unsuppressAddress(
  ctx: AwsContext,
  stackName: string,
  address: string,
): Promise<{ ok: true; address: string }> {
  const addr = address.trim().toLowerCase();
  if (!addr) throw new Error("an address is required");
  const { dynamodb } = clients(ctx);
  const outputs = await getStackOutputs(ctx, stackName);
  const settingsTable = await resolveSettingsTableName(ctx, stackName, outputs);
  if (!settingsTable) throw new Error("No deployed MailPoppy backend was found — deploy the backend first.");
  await dynamodb.send(
    new DeleteItemCommand({ TableName: settingsTable, Key: { pk: { S: suppressionKey(addr) } } }),
  );
  // AWS keeps its OWN account-level suppression list, enabled by default, and adds every
  // hard bounce and complaint to it. Clearing only MailPoppy's row would let the send pass
  // our check and then be accepted-and-silently-dropped by SES — reproducing the exact
  // failure this feature exists to prevent, while telling the admin it's fixed.
  // NotFoundException just means AWS wasn't holding it; that's a success for us.
  try {
    const { sesv2 } = clients(ctx);
    await sesv2.send(new DeleteSuppressedDestinationCommand({ EmailAddress: addr }));
  } catch (e) {
    if ((e as { name?: string }).name !== "NotFoundException") throw e;
  }
  await record([
    {
      action: "deleted",
      service: "DynamoDB",
      resourceType: "Suppressed address",
      name: addr,
      region: ctx.region,
      detail: "admin cleared the do-not-send entry (MailPoppy + the AWS account-level suppression list)",
    },
  ]);
  return { ok: true, address: addr };
}

/**
 * Point a domain's SES bounce + complaint notifications at the deployed stack's SNS topic,
 * so the suppression Lambda actually receives them.
 *
 * 🪤 WITHOUT THIS THE WHOLE FEEDBACK LOOP IS DEAD, and it was until 2026-08-23. The stack
 * created the topic and subscribed the Lambda, but nobody ever told SES to PUBLISH to it —
 * a subscriber with no publisher. So the do-not-send list stayed permanently empty AND the
 * per-domain bounce/complaint counters behind Sending Health were always zero. (Found by an
 * adversarial review of the change that made the send path honour that list.)
 *
 * Uses the SES v1 identity-notification API deliberately: it emits the `notificationType`
 * shape suppression.ts already parses, and it applies per identity, so no send has to
 * remember to name a configuration set. Headers are enabled too — the Lambda attributes an
 * event to a domain from the From header, falling back to the envelope sender, which for a
 * custom MAIL FROM subdomain would attribute to the wrong domain.
 *
 * Idempotent: re-running simply re-asserts the same topic, so re-opening the wizard repairs
 * a domain that was set up before this existed.
 */
export async function wireFeedbackNotifications(
  ctx: AwsContext,
  domain: string,
  stackName = MAILPOPPY_STACK_NAME,
): Promise<{ ok: boolean; topicArn?: string; reason?: string }> {
  const outputs = await getStackOutputs(ctx, stackName);
  const topicArn = outputs.NotificationsTopicArn;
  // No backend yet (domain set up before the stack): not an error — the wizard deploys the
  // backend first, and re-running provisioning afterwards wires it.
  if (!topicArn) return { ok: false, reason: "no deployed backend yet" };

  const { ses } = clients(ctx);
  for (const type of ["Bounce", "Complaint"] as const) {
    await ses.send(
      new SetIdentityNotificationTopicCommand({ Identity: domain, NotificationType: type, SnsTopic: topicArn }),
    );
    // Headers carry the From address the Lambda attributes the event to.
    await ses.send(
      new SetIdentityHeadersInNotificationsEnabledCommand({
        Identity: domain,
        NotificationType: type,
        Enabled: true,
      }),
    );
  }
  await record([
    {
      action: "updated",
      service: "SES",
      resourceType: "Feedback notifications",
      name: domain,
      region: ctx.region,
      detail: `bounce + complaint notifications → ${topicArn}`,
    },
  ]);
  return { ok: true, topicArn };
}

/** Poll DKIM/identity verification (the gate before sending). */
export async function getIdentityStatus(
  ctx: AwsContext,
  domain: string,
): Promise<{ verifiedForSending: boolean; dkim: string }> {
  const { sesv2 } = clients(ctx);
  const out = await sesv2.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
  return {
    verifiedForSending: !!out.VerifiedForSendingStatus,
    dkim: out.DkimAttributes?.Status ?? "UNKNOWN",
  };
}

/** Step 7: send a deliverability test (used by the wizard's "verify" step). */
export async function sendTest(
  ctx: AwsContext,
  opts: { from: string; to: string; subject: string; html: string; text: string },
): Promise<string> {
  const { sesv2 } = clients(ctx);
  const out = await sesv2.send(
    new SendEmailCommand({
      FromEmailAddress: opts.from,
      Destination: { ToAddresses: [opts.to] },
      Content: { Simple: { Subject: { Data: opts.subject }, Body: { Text: { Data: opts.text }, Html: { Data: opts.html } } } },
    }),
  );
  return out.MessageId ?? "";
}

// ---- SES sandbox / production access (DESIGN §13) ----

/**
 * Read-only: the account's SES sending posture — sandbox vs production, the
 * review status of any in-flight request, and the current send quota. SES starts
 * every account in a sandbox (verified recipients only, ~200/day) until AWS
 * grants production access via a manual review.
 */
export async function getSesAccount(ctx: AwsContext): Promise<SesAccountStatus> {
  const { sesv2 } = clients(ctx);
  const out = await sesv2.send(new GetAccountCommand({}));
  const q = out.SendQuota;
  return {
    productionAccessEnabled: !!out.ProductionAccessEnabled,
    sendingEnabled: !!out.SendingEnabled,
    enforcementStatus: out.EnforcementStatus,
    reviewStatus: out.Details?.ReviewDetails?.Status as SesReviewStatus | undefined,
    mailType: out.Details?.MailType,
    sendQuota: q
      ? {
          max24Hour: q.Max24HourSend ?? 0,
          maxSendRate: q.MaxSendRate ?? 0,
          sentLast24Hours: q.SentLast24Hours ?? 0,
        }
      : undefined,
  };
}

// ---- Sandbox test-recipient verification (DESIGN §13) ----
//
// In the sandbox, SES only delivers to VERIFIED addresses — so the wizard's
// deliverability test fails against the admin's personal inbox unless that
// address is verified first. Verifying = creating an SES EMAIL_ADDRESS identity:
// AWS emails the address a click-link. Uses only Create/Get/DeleteEmailIdentity,
// which MailPoppy already holds (no new permission, no broker re-consent).

/** Read-only: where a recipient address stands in SES's verification flow. */
export async function getRecipientVerification(ctx: AwsContext, email: string): Promise<RecipientVerification> {
  const { sesv2 } = clients(ctx);
  const addr = email.trim().toLowerCase();
  try {
    const out = await sesv2.send(new GetEmailIdentityCommand({ EmailIdentity: addr }));
    return {
      email: addr,
      state: recipientVerificationState({
        verifiedForSending: out.VerifiedForSendingStatus,
        verificationStatus: out.VerificationStatus,
      }),
    };
  } catch (e) {
    if ((e as { name?: string }).name === "NotFoundException") return { email: addr, state: "not-started" };
    throw e;
  }
}

/**
 * Start (or re-send) SES verification for a recipient address — AWS emails it a
 * click-link. Already-verified is a no-op. An existing UNVERIFIED identity is
 * deleted + recreated: that's SESv2's only way to re-send the verification email
 * (lost/expired link), and an unverified email identity carries no config to lose.
 */
export async function verifyRecipient(ctx: AwsContext, email: string): Promise<RecipientVerification> {
  const addr = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) throw new Error(`"${email}" is not a valid email address`);
  const { sesv2 } = clients(ctx);
  try {
    await sesv2.send(new CreateEmailIdentityCommand({ EmailIdentity: addr }));
  } catch (e) {
    if ((e as { name?: string }).name !== "AlreadyExistsException") throw e;
    const current = await getRecipientVerification(ctx, addr);
    if (current.state === "verified") return current;
    await sesv2.send(new DeleteEmailIdentityCommand({ EmailIdentity: addr }));
    await sesv2.send(new CreateEmailIdentityCommand({ EmailIdentity: addr }));
  }
  await record([
    {
      action: "created",
      service: "SES",
      resourceType: "EmailIdentity",
      name: addr,
      region: ctx.region,
      detail: "verified recipient for sandbox test sends (AWS emailed a verification link)",
    },
  ]);
  return { email: addr, state: "pending" };
}

/**
 * "Sending health" for the whole account + region (DESIGN §13). Reads SES's own
 * bounce/complaint statistics and sending quota, plus the do-not-send
 * (suppression) list the bounce/complaint Lambda maintains in the settings
 * table. All read-only. Everything is best-effort: a fresh account with no send
 * history returns zeroes, and a missing/locked-down suppression list just yields
 * an empty list rather than failing the whole call.
 */
export async function getDeliverability(
  ctx: AwsContext,
  args: { stackName?: string } = {},
): Promise<DeliverabilityStatus> {
  const { sesv2, ses, dynamodb } = clients(ctx);
  const stackName = args.stackName ?? "MailpoppyMailStack";

  // Account quota + enforcement (same source the sandbox view uses).
  const account = await sesv2.send(new GetAccountCommand({}));
  const quota = account.SendQuota;

  // Bounce/complaint counts over SES's ~14-day retention window.
  const stats = await ses.send(new GetSendStatisticsCommand({}));
  const points = stats.SendDataPoints ?? [];
  const totals: SendingTotals = points.reduce<SendingTotals>(
    (acc, p) => ({
      deliveryAttempts: acc.deliveryAttempts + (p.DeliveryAttempts ?? 0),
      bounces: acc.bounces + (p.Bounces ?? 0),
      complaints: acc.complaints + (p.Complaints ?? 0),
      rejects: acc.rejects + (p.Rejects ?? 0),
    }),
    { deliveryAttempts: 0, bounces: 0, complaints: 0, rejects: 0 },
  );
  // The actual span the datapoints cover, so the UI label is honest.
  const times = points.map((p) => p.Timestamp?.getTime()).filter((t): t is number => typeof t === "number");
  const windowDays =
    times.length > 1 ? Math.max(1, Math.round((Math.max(...times) - Math.min(...times)) / 86_400_000)) : 14;

  // Do-not-send list (best-effort — needs a deployed stack + Scan permission).
  let suppressed: SuppressedAddress[] = [];
  try {
    const outputs = await getStackOutputs(ctx, stackName);
    const settingsTable = await resolveSettingsTableName(ctx, stackName, outputs);
    if (settingsTable) {
      // Paginate: a FILTERED Scan stops after ~1 MB of SCANNED items, so a single page can
      // miss suppressed rows entirely. Enforcement reads by exact key and is complete, so an
      // address missing from this list would be blocked with no "Allow again" button — the
      // admin's only escape hatch, invisible.
      const items: Record<string, { S?: string }>[] = [];
      let lastKey: Record<string, unknown> | undefined;
      do {
        const page = await dynamodb.send(
          new ScanCommand({
            TableName: settingsTable,
            FilterExpression: "begins_with(pk, :p)",
            ExpressionAttributeValues: { ":p": { S: "SUPPRESS#" } },
            ExclusiveStartKey: lastKey as never,
          }),
        );
        for (const it of page.Items ?? []) items.push(it as never);
        lastKey = page.LastEvaluatedKey as never;
      } while (lastKey);
      suppressed = items.map((it) => ({
        address: it.address?.S ?? (it.pk?.S ?? "").replace(/^SUPPRESS#/, ""),
        reason: it.reason?.S ?? "bounce",
        detail: it.detail?.S,
        suppressedAt: it.suppressedAt?.S,
        domain: it.domain?.S,
      }));
      // Most recently suppressed first.
      suppressed.sort((a, b) =>
        a.suppressedAt && b.suppressedAt ? (a.suppressedAt < b.suppressedAt ? 1 : -1) : 0,
      );
    }
  } catch {
    // No stack, or no read access — leave the list empty.
  }

  return {
    totals,
    bounceRate: rate(totals.bounces, totals.deliveryAttempts),
    complaintRate: rate(totals.complaints, totals.deliveryAttempts),
    windowDays,
    sendingPaused: account.SendingEnabled === false,
    enforcementStatus: account.EnforcementStatus,
    dailyUsed: quota?.SentLast24Hours ?? 0,
    dailyLimit: quota?.Max24HourSend ?? 0,
    suppressed,
  };
}

const DELIVERABILITY_WINDOW_DAYS = 14;

/**
 * Per-domain "sending health" overview. The account-wide header reuses
 * getDeliverability (paused/quota + the authoritative all-domains SES totals +
 * suppression list). Per-domain rows are Mailpoppy's own tally, since SES doesn't
 * break reputation down by domain:
 *   • sends    — counted from each mailbox's stored Sent copies in the window;
 *   • bounces/complaints — from the STAT#<domain>#<day> counters the suppression
 *     Lambda writes (forward-looking: they accrue from when that Lambda deploys);
 *   • suppressed — the do-not-send entries attributed to that sending domain;
 *   • dmarc — DMARC#<domain>#<day> counters the inbound-processor writes from
 *     aggregate reports that land at postmaster@<domain> (also forward-looking).
 * Everything is best-effort; a missing table/permission yields zeroes, not an error.
 */
export async function getDeliverabilityOverview(
  ctx: AwsContext,
  args: { stackName?: string } = {},
): Promise<DeliverabilityOverview> {
  const { dynamodb } = clients(ctx);
  const stackName = args.stackName ?? "MailpoppyMailStack";

  const account = await getDeliverability(ctx, { stackName });

  const outputs = await getStackOutputs(ctx, stackName);
  const indexTable = outputs.IndexTableName;
  const userPoolId = outputs.UserPoolId;
  const settingsTable = await resolveSettingsTableName(ctx, stackName, outputs);

  const since = new Date(Date.now() - DELIVERABILITY_WINDOW_DAYS * 86_400_000);
  const sinceIso = since.toISOString();
  const sinceDay = sinceIso.slice(0, 10); // YYYY-MM-DD

  // Domains that can send = those with at least one mailbox.
  const mailboxes = userPoolId ? await listMailboxes(ctx, userPoolId).catch(() => []) : [];
  const addressesByDomain = new Map<string, string[]>();
  for (const m of mailboxes) {
    const d = addressDomain(m.email);
    if (!d) continue;
    addressesByDomain.set(d, [...(addressesByDomain.get(d) ?? []), m.email]);
  }

  // Per-domain bounce/complaint tallies (one scan of the STAT# counters).
  const stat = new Map<string, { bounces: number; complaints: number }>();
  if (settingsTable) {
    try {
      const scan = await dynamodb.send(
        new ScanCommand({
          TableName: settingsTable,
          FilterExpression: "begins_with(pk, :p)",
          ExpressionAttributeValues: { ":p": { S: "STAT#" } },
        }),
      );
      for (const it of scan.Items ?? []) {
        const day = it.day?.S ?? "";
        if (day && day < sinceDay) continue; // outside the window
        const dom = it.domain?.S ?? (it.pk?.S ?? "").split("#")[1] ?? "";
        if (!dom) continue;
        const cur = stat.get(dom) ?? { bounces: 0, complaints: 0 };
        cur.bounces += Number(it.bounces?.N ?? 0);
        cur.complaints += Number(it.complaints?.N ?? 0);
        stat.set(dom, cur);
      }
    } catch {
      // no perms / no table → no per-domain bounce data
    }
  }

  // Per-domain DMARC aggregate-report tallies (one scan of the DMARC# counters
  // the inbound-processor writes when reports arrive at postmaster@<domain>).
  const dmarcStat = new Map<string, { reports: number; volume: number; pass: number; fail: number }>();
  if (settingsTable) {
    try {
      const scan = await dynamodb.send(
        new ScanCommand({
          TableName: settingsTable,
          FilterExpression: "begins_with(pk, :p)",
          ExpressionAttributeValues: { ":p": { S: "DMARC#" } },
        }),
      );
      for (const it of scan.Items ?? []) {
        const day = it.day?.S ?? "";
        if (day && day < sinceDay) continue; // outside the window
        const dom = it.domain?.S ?? (it.pk?.S ?? "").split("#")[1] ?? "";
        if (!dom) continue;
        const cur = dmarcStat.get(dom) ?? { reports: 0, volume: 0, pass: 0, fail: 0 };
        cur.reports += Number(it.reports?.N ?? 0);
        cur.volume += Number(it.volume?.N ?? 0);
        cur.pass += Number(it.pass?.N ?? 0);
        cur.fail += Number(it.fail?.N ?? 0);
        dmarcStat.set(dom, cur);
      }
    } catch {
      // no perms / no table → no per-domain DMARC data
    }
  }

  // Suppressed addresses attributed to each sending domain.
  const suppressedByDomain = new Map<string, number>();
  for (const s of account.suppressed) {
    if (!s.domain) continue;
    suppressedByDomain.set(s.domain, (suppressedByDomain.get(s.domain) ?? 0) + 1);
  }

  const domains: DomainDeliverability[] = [];
  for (const [domain, addresses] of [...addressesByDomain.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Sends = stored Sent copies in the window (one COUNT query per mailbox).
    let sends = 0;
    if (indexTable) {
      for (const addr of addresses) {
        try {
          const q = await dynamodb.send(
            new QueryCommand({
              TableName: indexTable,
              KeyConditionExpression: "pk = :pk AND sk BETWEEN :lo AND :hi",
              ExpressionAttributeValues: {
                ":pk": { S: mailboxPk(addr) },
                ":lo": { S: `sent#${sinceIso}` },
                ":hi": { S: "sent#￿" },
              },
              Select: "COUNT",
            }),
          );
          sends += q.Count ?? 0;
        } catch {
          // ignore a single mailbox's query failure
        }
      }
    }
    const counts = stat.get(domain) ?? { bounces: 0, complaints: 0 };
    const dm = dmarcStat.get(domain);
    const dmarc: DomainDmarc | undefined = dm
      ? {
          reports: dm.reports,
          volume: dm.volume,
          pass: dm.pass,
          fail: dm.fail,
          failRate: rate(dm.fail, dm.volume),
          windowDays: DELIVERABILITY_WINDOW_DAYS,
        }
      : undefined;
    domains.push({
      domain,
      sends,
      bounces: counts.bounces,
      complaints: counts.complaints,
      bounceRate: rate(counts.bounces, sends),
      complaintRate: rate(counts.complaints, sends),
      suppressedCount: suppressedByDomain.get(domain) ?? 0,
      windowDays: DELIVERABILITY_WINDOW_DAYS,
      dmarc,
    });
  }

  return { account, domains };
}

/**
 * Mutating: submit a production-access (sandbox-exit) request to AWS. This opens
 * an AWS Support case the admin's account owner can track; AWS reviews it
 * (typically within 24h). The UI confirms first. Validated locally so we fail
 * fast with a clear message instead of a generic SES ValidationException.
 * Returns the refreshed account status (review should now be PENDING).
 */
export async function requestProductionAccess(
  ctx: AwsContext,
  req: ProductionAccessRequest,
): Promise<SesAccountStatus> {
  const problems = validateProductionAccessRequest(req);
  if (problems.length) throw new Error(problems.join(" "));

  const { sesv2 } = clients(ctx);
  const extra = (req.additionalContactEmails ?? []).map((e) => e.trim()).filter(Boolean);
  await sesv2.send(
    new PutAccountDetailsCommand({
      MailType: req.mailType,
      WebsiteURL: req.websiteUrl.trim(),
      ContactLanguage: req.contactLanguage,
      UseCaseDescription: req.useCaseDescription.trim(),
      AdditionalContactEmailAddresses: extra.length ? extra : undefined,
      ProductionAccessEnabled: true,
    }),
  );

  await record([
    {
      action: "created",
      service: "SES",
      resourceType: "Production access request",
      name: `SES production access (${ctx.region})`,
      region: ctx.region,
      detail: `mailType=${req.mailType}, site=${req.websiteUrl.trim()}`,
    },
  ]);

  return getSesAccount(ctx);
}

// ---- Custom MAIL FROM domain (DESIGN §13 — SPF alignment / deliverability) ----

/** Read-only: the identity's current MAIL FROM configuration + verification status. */
export async function getMailFromStatus(ctx: AwsContext, domain: string): Promise<MailFromState> {
  const { sesv2 } = clients(ctx);
  try {
    const out = await sesv2.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
    const m = out.MailFromAttributes;
    return {
      mailFromDomain: m?.MailFromDomain,
      status: m?.MailFromDomainStatus as MailFromStatus | undefined,
      behaviorOnMxFailure: m?.BehaviorOnMxFailure,
    };
  } catch (e) {
    // The SES identity may not exist yet — the domain hasn't been provisioned, or
    // is mid-verification during first setup. A status *read* must degrade to
    // "not configured" rather than 502 (mirrors getDomainIdentityStatus and the
    // other read helpers above). setupMailFrom still surfaces real errors.
    if (/does not exist|ValidationError|NotFound/i.test((e as Error).message ?? "")) {
      return { mailFromDomain: undefined, status: undefined };
    }
    throw e;
  }
}

/**
 * Mutating: configure a custom MAIL FROM subdomain (default `mail.<domain>`) so
 * SPF aligns to the sender's domain (helps Outlook/Hotmail placement). Points the
 * SES identity at the subdomain and writes its required DNS (feedback MX + SPF
 * TXT) to Route53. BehaviorOnMxFailure=USE_DEFAULT_VALUE so mail still sends if
 * the MX ever fails to resolve. The UI confirms first (it changes DNS). SES then
 * verifies the MX asynchronously (status PENDING → SUCCESS). Ledger-logged.
 */
export async function setupMailFrom(
  ctx: AwsContext,
  args: { domain: string; subdomain?: string },
): Promise<{ mailFromDomain: string; records: DnsRecord[]; state: MailFromState }> {
  const { sesv2, route53 } = clients(ctx);
  const domain = args.domain.trim().toLowerCase();
  const mailFromDomain = (args.subdomain?.trim().toLowerCase() || defaultMailFromDomain(domain)).replace(/\.$/, "");

  // 1. Point the SES identity at the custom MAIL FROM domain.
  await sesv2.send(
    new PutEmailIdentityMailFromAttributesCommand({
      EmailIdentity: domain,
      MailFromDomain: mailFromDomain,
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    }),
  );

  // 2. Write the feedback MX + SPF TXT for the subdomain (fresh names — no merge needed).
  const records = mailFromDnsRecords(mailFromDomain, ctx.region);
  const zoneId = await findHostedZoneId(ctx, domain);
  const changes: Change[] = records.map((r) => ({
    Action: "UPSERT",
    ResourceRecordSet: {
      Name: r.name,
      Type: r.type as RRType,
      TTL: 300,
      ResourceRecords: [{ Value: r.value }],
    },
  }));
  await route53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      ChangeBatch: { Comment: "Mailpoppy custom MAIL FROM", Changes: changes },
    }),
  );

  await record([
    { action: "created", service: "SES", resourceType: "MAIL FROM domain", name: mailFromDomain, region: ctx.region, detail: `identity ${domain}` },
    ...records.map((r) => ({
      action: "created" as const,
      service: "Route53",
      resourceType: `${r.type} record`,
      name: r.name,
      region: ctx.region,
      detail: `zone ${zoneId}`,
    })),
  ]);

  return { mailFromDomain, records, state: await getMailFromStatus(ctx, domain) };
}

// ---- Environment readiness (run BEFORE provisioning, so setup never fails midway) ----

export interface Readiness {
  cli: { installed: boolean; version?: string };
  credentials: { ok: boolean; arn?: string; account?: string; error?: string };
  permissions: Record<"route53" | "ses" | "sesv2" | "s3", "ok" | "denied" | "error">;
  ready: boolean;
}

/** Detect the AWS CLI. Optional — the SDK reads ~/.aws directly — but it sharpens guidance. */
function detectCli(): { installed: boolean; version?: string } {
  try {
    const r = spawnSync("aws", ["--version"], { encoding: "utf8" });
    if (r.error) return { installed: false };
    const line = (r.stdout || r.stderr || "").trim().split("\n")[0] ?? "";
    return { installed: true, version: line || undefined };
  } catch {
    return { installed: false };
  }
}

function classifyError(e: unknown): "denied" | "error" {
  const name = (e as { name?: string }).name ?? "";
  return /AccessDenied|UnauthorizedOperation|NotAuthorized/i.test(name) ? "denied" : "error";
}

async function probe(send: Promise<unknown>): Promise<"ok" | "denied" | "error"> {
  try {
    await send;
    return "ok";
  } catch (e) {
    return classifyError(e);
  }
}

/**
 * Confirms the admin's environment can actually provision: credentials resolve and the
 * identity can reach each required service. Surfaces a clear "what to fix" instead of
 * failing partway through provisioning. (Read probes are a strong proxy; a full
 * write-permission check via iam:SimulatePrincipalPolicy is a later enhancement.)
 */
export async function checkReadiness(ctx: AwsContext): Promise<Readiness> {
  const cli = detectCli();

  // Brokered by a connected AgentsPoppy → the environment IS ready: AgentsPoppy has
  // granted MailPoppy a known, scoped permission set, so we deliberately don't probe.
  // Probing here would mint credentials, which (under supervised mode) forces a human
  // approval just to enable the form. The real credential mint + its approval happen
  // when MailPoppy actually deploys.
  if (brokerConnected()) {
    return {
      cli,
      credentials: { ok: true, arn: "Brokered by AgentsPoppy", account: brokerAccountId() },
      permissions: { route53: "ok", ses: "ok", sesv2: "ok", s3: "ok" },
      ready: true,
    };
  }

  const c = clients(ctx);

  const credentials: Readiness["credentials"] = { ok: false };
  try {
    const id = await c.sts.send(new GetCallerIdentityCommand({}));
    credentials.ok = true;
    credentials.arn = id.Arn;
    credentials.account = id.Account;
  } catch (e) {
    credentials.error = (e as Error).message ?? String(e);
  }

  const permissions: Readiness["permissions"] = credentials.ok
    ? {
        route53: await probe(c.route53.send(new ListHostedZonesByNameCommand({ MaxItems: 1 }))),
        ses: await probe(c.ses.send(new DescribeActiveReceiptRuleSetCommand({}))),
        sesv2: await probe(c.sesv2.send(new ListEmailIdentitiesCommand({ PageSize: 1 }))),
        s3: await probe(c.s3.send(new ListBucketsCommand({}))),
      }
    : { route53: "error", ses: "error", sesv2: "error", s3: "error" };

  const ready = credentials.ok && Object.values(permissions).every((v) => v === "ok");
  return { cli, credentials, permissions, ready };
}

// ---- Mailbox storage quotas (admin) ----

/** Resolve the settings table name from outputs, falling back to the resource list. */
async function resolveSettingsTableName(
  ctx: AwsContext,
  stackName: string,
  outputs: Record<string, string>,
): Promise<string | undefined> {
  if (outputs.SettingsTableName) return outputs.SettingsTableName;
  const { resources } = await listStackResources(ctx, stackName);
  return resources.find((r) => r.logicalId === "SettingsTable" && r.type === "AWS::DynamoDB::Table")?.physicalId;
}

/** A mailbox's current storage usage (sum of sizeBytes) and quota (if set). */
export async function getMailboxStorage(
  ctx: AwsContext,
  args: { stackName?: string; email: string },
): Promise<MailboxStorage> {
  const { dynamodb } = clients(ctx);
  const stackName = args.stackName ?? "MailpoppyMailStack";
  const email = args.email.trim().toLowerCase();
  const outputs = await getStackOutputs(ctx, stackName);
  const indexTable = outputs.IndexTableName;
  if (!indexTable) throw new Error("IndexTableName not found in stack outputs");

  const pk = mailboxPk(email);
  let usedBytes = 0;
  let messageCount = 0;
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const out = await dynamodb.send(
      new QueryCommand({
        TableName: indexTable,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: pk } },
        ProjectionExpression: "sizeBytes",
        ExclusiveStartKey,
      }),
    );
    for (const item of out.Items ?? []) {
      usedBytes += Number(item.sizeBytes?.N ?? 0);
      messageCount += 1;
    }
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  let quotaBytes: number | null = null;
  const settingsTable = await resolveSettingsTableName(ctx, stackName, outputs);
  if (settingsTable) {
    const q = await dynamodb.send(
      new GetItemCommand({ TableName: settingsTable, Key: { pk: { S: quotaSettingsKey(email) } } }),
    );
    const v = q.Item?.quotaBytes?.N;
    if (v) quotaBytes = Number(v);
  }
  return { email, usedBytes, messageCount, quotaBytes };
}

/** Set (or, with null, clear) a mailbox's storage quota in bytes. */
export async function setMailboxQuota(
  ctx: AwsContext,
  args: { stackName?: string; email: string; quotaBytes: number | null },
): Promise<{ ok: true; email: string; quotaBytes: number | null }> {
  const { dynamodb } = clients(ctx);
  const stackName = args.stackName ?? "MailpoppyMailStack";
  const email = args.email.trim().toLowerCase();
  const outputs = await getStackOutputs(ctx, stackName);
  const settingsTable = await resolveSettingsTableName(ctx, stackName, outputs);
  if (!settingsTable) throw new Error("settings table not found — re-deploy the backend to enable quotas");

  const Key = { pk: { S: quotaSettingsKey(email) } };
  if (args.quotaBytes && args.quotaBytes > 0) {
    await dynamodb.send(
      new PutItemCommand({
        TableName: settingsTable,
        Item: { pk: { S: quotaSettingsKey(email) }, quotaBytes: { N: String(Math.floor(args.quotaBytes)) } },
      }),
    );
    return { ok: true, email, quotaBytes: Math.floor(args.quotaBytes) };
  }
  await dynamodb.send(new DeleteItemCommand({ TableName: settingsTable, Key }));
  return { ok: true, email, quotaBytes: null };
}

// ---- Agent-owned mailboxes (the CrewPoppy bridge) ----
// The flag lives in the settings table (`agent#<address>`); the inbound Lambda
// reads it per delivery and, when set, hands a plain-text copy of the mail to
// CrewPoppy's runner. Default is OFF — the desktop UI shows the privacy
// disclosure before ever enabling it.

/** Whether a mailbox is flagged agent-owned (mail handed to CrewPoppy). */
export async function getAgentOwned(
  ctx: AwsContext,
  args: { stackName?: string; email: string },
): Promise<{ email: string; agentOwned: boolean }> {
  const { dynamodb } = clients(ctx);
  const stackName = args.stackName ?? "MailpoppyMailStack";
  const email = args.email.trim().toLowerCase();
  const outputs = await getStackOutputs(ctx, stackName);
  const settingsTable = await resolveSettingsTableName(ctx, stackName, outputs);
  if (!settingsTable) throw new Error("settings table not found — deploy the backend first");
  const out = await dynamodb.send(
    new GetItemCommand({ TableName: settingsTable, Key: { pk: { S: agentOwnedSettingsKey(email) } } }),
  );
  return { email, agentOwned: out.Item?.agentOwned?.BOOL === true };
}

/** Flag (or unflag) a mailbox as agent-owned. Unflagging deletes the item, so
 *  "off" is the absence of the flag — exactly what the Lambda fail-safes to. */
export async function setAgentOwned(
  ctx: AwsContext,
  args: { stackName?: string; email: string; agentOwned: boolean },
): Promise<{ ok: true; email: string; agentOwned: boolean }> {
  const { dynamodb } = clients(ctx);
  const stackName = args.stackName ?? "MailpoppyMailStack";
  const email = args.email.trim().toLowerCase();
  const outputs = await getStackOutputs(ctx, stackName);
  const settingsTable = await resolveSettingsTableName(ctx, stackName, outputs);
  if (!settingsTable) throw new Error("settings table not found — deploy the backend first");
  const Key = { pk: { S: agentOwnedSettingsKey(email) } };
  if (args.agentOwned) {
    await dynamodb.send(
      new PutItemCommand({ TableName: settingsTable, Item: { ...Key, agentOwned: { BOOL: true } } }),
    );
  } else {
    await dynamodb.send(new DeleteItemCommand({ TableName: settingsTable, Key }));
  }

  // Tell CrewPoppy (kind:"mailbox") so its agent editor can offer this address in a
  // SELECT instead of a free-text field. Best-effort by design: CrewPoppy absent or
  // torn down must never make the toggle fail — the flag above is the truth, and
  // CrewPoppy also self-heals its registry from the first arriving mail.
  try {
    const { lambda } = clients(ctx);
    await lambda.send(
      new InvokeCommand({
        FunctionName: "CrewPoppyRunner",
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ kind: "mailbox", email, agentOwned: args.agentOwned })),
      }),
    );
  } catch (e) {
    console.log("[mailpoppy] CrewPoppy not notified (absent or not permitted) — fine:", (e as Error).name);
  }
  return { ok: true, email, agentOwned: args.agentOwned };
}

export interface MailboxDeletion {
  email: string;
  userDeleted: boolean;
  deletedMessages: number;
  deletedObjects: number;
  freedBytes: number;
}

/**
 * Permanently delete a single mailbox: its Cognito sign-in user AND all of its
 * stored mail (DynamoDB index rows + the raw .eml / attachment objects in S3) +
 * its quota setting. Irreversible. Mail is keyed solely by the owning address,
 * so we enumerate the mailbox's partition, delete the referenced S3 objects,
 * then the rows. The Cognito user is removed LAST so a failure mid-way leaves
 * the user (and the UI listing) intact to retry, rather than an unreachable
 * orphan of mail.
 */
export async function deleteMailbox(
  ctx: AwsContext,
  args: { stackName?: string; email: string },
): Promise<MailboxDeletion> {
  const { dynamodb, s3, cognito } = clients(ctx);
  const stackName = args.stackName ?? "MailpoppyMailStack";
  const email = args.email.trim().toLowerCase();
  const outputs = await getStackOutputs(ctx, stackName);
  const indexTable = outputs.IndexTableName;
  const bucket = outputs.MailBucketName;
  const userPoolId = outputs.UserPoolId;
  if (!indexTable) throw new Error("IndexTableName not found in stack outputs");
  if (!userPoolId) throw new Error("UserPoolId not found in stack outputs");

  const pk = mailboxPk(email);

  // 1. Enumerate the mailbox's messages: sort keys (to delete index rows), the
  //    S3 object keys (raw .eml + each attachment), and total bytes freed.
  const sortKeys: string[] = [];
  const objectKeys = new Set<string>();
  let freedBytes = 0;
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const out = await dynamodb.send(
      new QueryCommand({
        TableName: indexTable,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: pk } },
        ProjectionExpression: "sk, s3Key, sizeBytes, attachments",
        ExclusiveStartKey,
      }),
    );
    for (const item of out.Items ?? []) {
      if (item.sk?.S) sortKeys.push(item.sk.S);
      if (item.s3Key?.S) objectKeys.add(item.s3Key.S);
      freedBytes += Number(item.sizeBytes?.N ?? 0);
      for (const a of item.attachments?.L ?? []) {
        const k = a.M?.s3Key?.S;
        if (k) objectKeys.add(k);
      }
    }
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  // 2. Delete the S3 objects (up to 1000 keys per request).
  let deletedObjects = 0;
  if (bucket && objectKeys.size > 0) {
    const keys = [...objectKeys];
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      deletedObjects += chunk.length;
    }
  }

  // 3. Delete the index rows (25 per BatchWriteItem; retry UnprocessedItems).
  for (let i = 0; i < sortKeys.length; i += 25) {
    const requests: WriteRequest[] = sortKeys
      .slice(i, i + 25)
      .map((sk) => ({ DeleteRequest: { Key: { pk: { S: pk }, sk: { S: sk } } } }));
    let requestItems: Record<string, WriteRequest[]> = { [indexTable]: requests };
    let attempts = 0;
    while (Object.keys(requestItems).length > 0 && attempts < 8) {
      const res: BatchWriteItemCommandOutput = await dynamodb.send(
        new BatchWriteItemCommand({ RequestItems: requestItems }),
      );
      requestItems = res.UnprocessedItems ?? {};
      attempts++;
    }
  }

  // 4. Delete the mailbox's quota setting doc (best-effort).
  try {
    const settingsTable = await resolveSettingsTableName(ctx, stackName, outputs);
    if (settingsTable) {
      await dynamodb.send(
        new DeleteItemCommand({ TableName: settingsTable, Key: { pk: { S: quotaSettingsKey(email) } } }),
      );
    }
  } catch {
    // non-fatal — a left-over quota row is harmless
  }

  // 5. Delete the Cognito sign-in user LAST (see doc comment).
  let userDeleted = false;
  try {
    await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }));
    userDeleted = true;
  } catch (e) {
    if (!/UserNotFound/i.test((e as Error).name ?? "")) throw e;
  }

  await record([
    {
      action: "deleted",
      service: "Cognito",
      resourceType: "Mailbox",
      name: email,
      region: ctx.region,
      detail: `removed sign-in + ${sortKeys.length} stored messages (${deletedObjects} S3 objects)`,
    },
  ]);

  return { email, userDeleted, deletedMessages: sortKeys.length, deletedObjects, freedBytes };
}

// ---- Spam / auth policy (admin: allow-block lists + per-verdict actions, DESIGN §10) ----

/**
 * Read a spam/auth policy from the settings table (defaults if unset). `scope`
 * is a domain for a per-domain override; omitted → the deployment-wide default.
 */
export async function getSpamPolicy(ctx: AwsContext, args: { stackName?: string; scope?: string }): Promise<SpamPolicy> {
  const { dynamodb } = clients(ctx);
  const stackName = args.stackName ?? "MailpoppyMailStack";
  const outputs = await getStackOutputs(ctx, stackName);
  const settingsTable = await resolveSettingsTableName(ctx, stackName, outputs);
  if (!settingsTable) return normalizeSpamPolicy(null);
  const out = await dynamodb.send(
    new GetItemCommand({ TableName: settingsTable, Key: { pk: { S: policySettingsKey(args.scope) } } }),
  );
  const json = out.Item?.json?.S;
  try {
    return normalizeSpamPolicy(json ? (JSON.parse(json) as Partial<SpamPolicy>) : null);
  } catch {
    return normalizeSpamPolicy(null);
  }
}

/** Write a spam/auth policy (normalized). `scope` = a domain for a per-domain override. */
export async function setSpamPolicy(
  ctx: AwsContext,
  args: { stackName?: string; policy: Partial<SpamPolicy>; scope?: string },
): Promise<{ ok: true; policy: SpamPolicy }> {
  const { dynamodb } = clients(ctx);
  const stackName = args.stackName ?? "MailpoppyMailStack";
  const outputs = await getStackOutputs(ctx, stackName);
  const settingsTable = await resolveSettingsTableName(ctx, stackName, outputs);
  if (!settingsTable) throw new Error("settings table not found — re-deploy the backend to enable mail rules");

  const policy = normalizeSpamPolicy(args.policy);
  await dynamodb.send(
    new PutItemCommand({
      TableName: settingsTable,
      Item: { pk: { S: policySettingsKey(args.scope) }, json: { S: JSON.stringify(policy) } },
    }),
  );
  return { ok: true, policy };
}

// ---- Send settings (admin: max outgoing attachment size) ----

/** Read the deployment-wide send settings (defaults if unset). */
export async function getSendSettings(
  ctx: AwsContext,
  args: { stackName?: string },
): Promise<SendSettings> {
  const { dynamodb } = clients(ctx);
  const stackName = args.stackName ?? "MailpoppyMailStack";
  const outputs = await getStackOutputs(ctx, stackName);
  const settingsTable = await resolveSettingsTableName(ctx, stackName, outputs);
  if (!settingsTable) return normalizeSendSettings(null);
  const out = await dynamodb.send(
    new GetItemCommand({ TableName: settingsTable, Key: { pk: { S: sendSettingsKey() } } }),
  );
  const raw = out.Item?.maxAttachmentBytes?.N;
  return normalizeSendSettings(raw ? { maxAttachmentBytes: Number(raw) } : null);
}

/**
 * Write the max attachment size (normalized + clamped to 1–40 MB). Stored as a
 * plain Number attribute so the access-api Lambda reads it back directly.
 */
export async function setSendSettings(
  ctx: AwsContext,
  args: { stackName?: string; maxAttachmentBytes: number },
): Promise<{ ok: true; settings: SendSettings }> {
  const { dynamodb } = clients(ctx);
  const stackName = args.stackName ?? "MailpoppyMailStack";
  const outputs = await getStackOutputs(ctx, stackName);
  const settingsTable = await resolveSettingsTableName(ctx, stackName, outputs);
  if (!settingsTable) throw new Error("settings table not found — re-deploy the backend to enable this");

  const settings = normalizeSendSettings({ maxAttachmentBytes: args.maxAttachmentBytes });
  await dynamodb.send(
    new PutItemCommand({
      TableName: settingsTable,
      Item: {
        pk: { S: sendSettingsKey() },
        maxAttachmentBytes: { N: String(settings.maxAttachmentBytes) },
      },
    }),
  );
  return { ok: true, settings };
}

// ---- Retention (admin: how long mail is kept, DESIGN §10) ----

/**
 * Read retention settings (defaults if unset). `scope` is a domain for a
 * per-domain override; omitted → the deployment-wide default.
 */
export async function getRetention(ctx: AwsContext, args: { stackName?: string; scope?: string }): Promise<RetentionSettings> {
  const { dynamodb } = clients(ctx);
  const stackName = args.stackName ?? "MailpoppyMailStack";
  const outputs = await getStackOutputs(ctx, stackName);
  const settingsTable = await resolveSettingsTableName(ctx, stackName, outputs);
  if (!settingsTable) return normalizeRetention(null);
  const out = await dynamodb.send(
    new GetItemCommand({ TableName: settingsTable, Key: { pk: { S: retentionSettingsKey(args.scope) } } }),
  );
  const json = out.Item?.json?.S;
  try {
    return normalizeRetention(json ? (JSON.parse(json) as Partial<RetentionSettings>) : null);
  } catch {
    return normalizeRetention(null);
  }
}

/** Write retention settings (normalized). `scope` = a domain for a per-domain override. */
export async function setRetention(
  ctx: AwsContext,
  args: { stackName?: string; retention: Partial<RetentionSettings>; scope?: string },
): Promise<{ ok: true; retention: RetentionSettings }> {
  const { dynamodb } = clients(ctx);
  const stackName = args.stackName ?? "MailpoppyMailStack";
  const outputs = await getStackOutputs(ctx, stackName);
  const settingsTable = await resolveSettingsTableName(ctx, stackName, outputs);
  if (!settingsTable) throw new Error("settings table not found — re-deploy the backend to enable retention");

  const retention = normalizeRetention(args.retention);
  await dynamodb.send(
    new PutItemCommand({
      TableName: settingsTable,
      Item: { pk: { S: retentionSettingsKey(args.scope) }, json: { S: JSON.stringify(retention) } },
    }),
  );
  return { ok: true, retention };
}

// ---- Teardown: remove everything Mailpoppy deployed (the inverse of deploy + provision) ----

export interface TeardownResult {
  ok: true;
  domain: string;
  domains: string[]; // every provisioned domain whose SES identity + DNS was cleaned
  stackName: string;
  deleted: string[]; // human-readable list of what was removed
  warnings: string[]; // non-fatal issues the user should know about
}

/**
 * Best-effort discovery of EVERY domain this backend was provisioned for, so
 * teardown cleans each one's SES identity + DNS — not just a single "primary"
 * domain. The local ledger can be incomplete (e.g. a domain set up from another
 * machine), so we union several live signals and tolerate any of them being gone:
 *   - the address domains of the backend's mailboxes (Cognito users)
 *   - the recipients of our active SES receipt rule set
 *   - SES EmailIdentity entries recorded in the local provisioning ledger
 */
export async function discoverProvisionedDomains(ctx: AwsContext, stackName: string): Promise<string[]> {
  const { cognito, ses } = clients(ctx);
  const domains = new Set<string>();
  const add = (raw?: string | null) => {
    if (!raw) return;
    const v = raw.trim().toLowerCase();
    const d = v.includes("@") ? addressDomain(v) : v;
    if (d && d.includes(".")) domains.add(d);
  };

  // Mailbox (Cognito user) address domains.
  try {
    const outputs = await getStackOutputs(ctx, stackName);
    if (outputs.UserPoolId) {
      let token: string | undefined;
      do {
        const out = await cognito.send(
          new ListUsersCommand({ UserPoolId: outputs.UserPoolId, Limit: 60, PaginationToken: token }),
        );
        for (const u of out.Users ?? []) add(u.Attributes?.find((a) => a.Name === "email")?.Value ?? u.Username);
        token = out.PaginationToken;
      } while (token);
    }
  } catch {
    // stack/pool may be gone (e.g. a re-run after partial teardown) — ignore
  }

  // Recipients of our active SES receipt rule set.
  try {
    const active = await ses.send(new DescribeActiveReceiptRuleSetCommand({}));
    const name = active.Metadata?.Name;
    if (name && /mailpoppy|MailRuleSet/i.test(name)) {
      for (const rule of active.Rules ?? []) for (const r of rule.Recipients ?? []) add(r);
    }
  } catch {
    // no active rule set — ignore
  }

  // SES identities recorded in the local ledger — NET of any later teardown.
  // The ledger is append-only and chronological, so a domain that was created
  // and then deleted has both entries; replaying add/remove in order leaves only
  // the identities that still exist. (Without this, a torn-down domain lingers
  // forever as a ghost — e.g. shows up on the Home dashboard after teardown.)
  // liveDomainIdentities deliberately EXCLUDES email-address identities: those are
  // verified test recipients (verifyRecipient), not domains we host. Passing one to
  // add() would reduce it to its domain and claim a domain the admin doesn't own —
  // verifying a personal you@gmail.com published a phantom "gmail.com" domain onto
  // the dashboard AND into teardown's DNS cleanup list (field bug 2026-08-23, shipped
  // in 0.1.19). The rule is unit-tested in core so it can't drift back.
  try {
    for (const name of liveDomainIdentities(await readLedger())) add(name);
  } catch {
    // missing/corrupt ledger — ignore
  }

  return [...domains].sort();
}

/** Empty a bucket (all objects + versions) then delete it. Returns false if it didn't exist. */
async function emptyAndDeleteBucket(ctx: AwsContext, bucket: string): Promise<boolean> {
  const { s3 } = clients(ctx);
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    return false; // already gone
  }
  let token: string | undefined;
  do {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    const objects = (list.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);
    if (objects.length > 0) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  return true;
}

/** Poll until the stack is gone (DELETE_COMPLETE) or fails. Returns true on success. */
async function waitForStackDeleted(ctx: AwsContext, stackName: string, timeoutMs = 600_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await stackStatus(ctx, stackName);
    if (status === null) return true; // gone
    if (status === "DELETE_FAILED" || /ROLLBACK_FAILED/.test(status)) return false;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

/**
 * Remove the DNS records Mailpoppy published for a domain: the SES MX, the DMARC
 * TXT, the DKIM CNAMEs, and the amazonses SPF value (merged out of the apex TXT,
 * preserving any other TXT records like domain-verification tokens). Builds DELETE
 * changes from the *actual* record sets so they match exactly. Returns a list of
 * human-readable descriptions of what was removed.
 */
async function removeDnsRecords(ctx: AwsContext, domain: string): Promise<string[]> {
  const { route53 } = clients(ctx);
  const zoneId = await findHostedZoneId(ctx, domain);
  const apex = `${domain}.`;
  const dmarc = `_dmarc.${domain}.`;

  // Gather all record sets (paginated).
  type RecordSet = { Name?: string; Type?: RRType; TTL?: number; ResourceRecords?: ResourceRecord[] };
  const all: RecordSet[] = [];
  let startName: string | undefined;
  let startType: RRType | undefined;
  do {
    const out = await route53.send(
      new ListResourceRecordSetsCommand({ HostedZoneId: zoneId, StartRecordName: startName, StartRecordType: startType }),
    );
    for (const r of out.ResourceRecordSets ?? []) all.push(r);
    if (out.IsTruncated) {
      startName = out.NextRecordName;
      startType = out.NextRecordType;
    } else {
      startName = undefined;
      startType = undefined;
    }
  } while (startName);

  const changes: Change[] = [];
  const removed: string[] = [];

  const del = (r: RecordSet) => {
    changes.push({
      Action: "DELETE",
      ResourceRecordSet: { Name: r.Name!, Type: r.Type, TTL: r.TTL, ResourceRecords: r.ResourceRecords },
    });
  };

  const isAmazonSesSpf = (v: string) => /v=spf1/.test(v) && /include:amazonses\.com/.test(v);

  // First pass: identify custom MAIL FROM subdomains (any name carrying a
  // "feedback-smtp.*.amazonses.com" MX). Their MX + SPF TXT must be removed too —
  // the SPF-alignment / MAIL FROM setup publishes records under e.g. mail.<domain>.
  const mailFromNames = new Set<string>();
  for (const r of all) {
    if (r.Type === "MX" && (r.ResourceRecords ?? []).some((x) => /feedback-smtp\..*amazonses\.com/.test(x.Value ?? ""))) {
      if (r.Name) mailFromNames.add(r.Name);
    }
  }

  for (const r of all) {
    const records = r.ResourceRecords ?? [];
    // SES inbound MX at the apex.
    if (r.Name === apex && r.Type === "MX" && records.some((x) => /inbound-smtp\..*amazonaws\.com/.test(x.Value ?? ""))) {
      del(r);
      removed.push(`MX ${domain}`);
    }
    // Custom MAIL FROM MX (e.g. mail.<domain> → feedback-smtp.*.amazonses.com).
    else if (r.Type === "MX" && records.some((x) => /feedback-smtp\..*amazonses\.com/.test(x.Value ?? ""))) {
      del(r);
      removed.push(`MAIL FROM MX ${r.Name?.replace(/\.$/, "")}`);
    }
    // DMARC TXT.
    else if (r.Name === dmarc && r.Type === "TXT") {
      del(r);
      removed.push(`TXT ${dmarc.replace(/\.$/, "")}`);
    }
    // DKIM CNAMEs (token._domainkey.<domain> → ....dkim.amazonses.com).
    else if (
      r.Type === "CNAME" &&
      r.Name?.endsWith(`._domainkey.${apex}`) &&
      records.some((x) => /dkim\.amazonses\.com\.?$/.test(x.Value ?? ""))
    ) {
      del(r);
      removed.push(`DKIM CNAME ${r.Name.replace(/\.$/, "")}`);
    }
    // SPF TXT on a MAIL FROM subdomain (strip the amazonses SPF; keep anything else).
    else if (r.Name && mailFromNames.has(r.Name) && r.Type === "TXT" && records.some((x) => isAmazonSesSpf(x.Value ?? ""))) {
      const keep = records.filter((x) => !isAmazonSesSpf(x.Value ?? ""));
      if (keep.length === 0) {
        del(r);
        removed.push(`MAIL FROM SPF TXT ${r.Name.replace(/\.$/, "")}`);
      } else {
        changes.push({
          Action: "UPSERT",
          ResourceRecordSet: { Name: r.Name, Type: "TXT", TTL: r.TTL ?? 300, ResourceRecords: keep },
        });
        removed.push(`SPF value from TXT ${r.Name.replace(/\.$/, "")}`);
      }
    }
    // Apex TXT: strip only the amazonses SPF value, keep everything else.
    else if (r.Name === apex && r.Type === "TXT") {
      const isSpf = (v: string) => /v=spf1/.test(v) && /include:amazonses\.com/.test(v);
      const keep = records.filter((x) => !isSpf(x.Value ?? ""));
      const hadSpf = keep.length !== records.length;
      if (hadSpf) {
        if (keep.length === 0) {
          del(r);
          removed.push(`TXT ${domain} (SPF)`);
        } else {
          changes.push({
            Action: "UPSERT",
            ResourceRecordSet: { Name: r.Name, Type: "TXT", TTL: r.TTL ?? 300, ResourceRecords: keep },
          });
          removed.push(`SPF value from TXT ${domain}`);
        }
      }
    }
  }

  if (changes.length > 0) {
    await route53.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: zoneId,
        ChangeBatch: { Comment: "Mailpoppy teardown", Changes: changes },
      }),
    );
  }
  return removed;
}

/**
 * Remove EVERYTHING Mailpoppy created for a domain: deactivate + delete the SES
 * receipt rule set (via the stack), delete the CloudFormation stack, then delete
 * the resources the stack RETAINs on delete (S3 mail bucket, DynamoDB tables,
 * Cognito user pool), the per-account deploy bucket, the SES domain identity, and
 * the published DNS records. Destructive and irreversible — the UI confirms first.
 *
 * Best-effort and idempotent: each step tolerates "already gone", and failures are
 * collected as warnings rather than aborting the whole teardown, so a partial
 * earlier run can be finished by running it again.
 */
export async function teardownAll(
  ctx: AwsContext,
  args: { domain: string; stackName?: string; deleteDeployBucket?: boolean },
): Promise<TeardownResult> {
  const { cloudformation, ses, sesv2, dynamodb, cognito } = clients(ctx);
  const region = ctx.region;
  const stackName = args.stackName ?? "MailpoppyMailStack";
  const domain = args.domain.trim().toLowerCase();
  const deleted: string[] = [];
  const warnings: string[] = [];
  const ledger: Array<Omit<LedgerEntry, "ts">> = [];

  // 1. Inventory the stack's RETAIN resources + rule set BEFORE we delete it (we
  //    can't read them once the stack is gone).
  const orphanBuckets: string[] = [];
  const orphanTables: string[] = [];
  const orphanUserPools: string[] = [];
  let ruleSetName: string | undefined;
  const initialStatus = await stackStatus(ctx, stackName);
  if (initialStatus) {
    const [{ resources }, outputs] = await Promise.all([
      listStackResources(ctx, stackName),
      getStackOutputs(ctx, stackName).catch(() => ({}) as Record<string, string>),
    ]);
    ruleSetName = outputs.RuleSetName;
    for (const r of resources) {
      if (!r.physicalId) continue;
      if (r.type === "AWS::S3::Bucket") orphanBuckets.push(r.physicalId);
      else if (r.type === "AWS::DynamoDB::Table") orphanTables.push(r.physicalId);
      else if (r.type === "AWS::Cognito::UserPool") orphanUserPools.push(r.physicalId);
    }
  } else {
    warnings.push(`stack ${stackName} not found — cleaning up any remaining known resources`);
  }

  // 1b. Discover EVERY provisioned domain BEFORE we delete the stack / pool /
  //     rule set (we read those as discovery signals). Always include the typed
  //     domain. This ensures a second provisioned domain (e.g. one set up from
  //     another machine, absent from the local ledger) isn't left orphaned.
  const domainsToClean = new Set<string>();
  if (domain) domainsToClean.add(domain);
  for (const d of await discoverProvisionedDomains(ctx, stackName)) domainsToClean.add(d);

  // 2. Deactivate the SES receipt rule set if ours is active (CloudFormation can't
  //    delete an active rule set, and inbound mail should stop now).
  try {
    const active = await ses.send(new DescribeActiveReceiptRuleSetCommand({}));
    const activeName = active.Metadata?.Name;
    if (activeName && (activeName === ruleSetName || /mailpoppy|MailRuleSet/i.test(activeName))) {
      await ses.send(new SetActiveReceiptRuleSetCommand({})); // omitting the name clears the active set
      deleted.push(`SES active receipt rule set cleared (${activeName})`);
      ledger.push({ action: "deleted", service: "SES", resourceType: "ActiveReceiptRuleSet", name: activeName, region });
    }
  } catch (e) {
    warnings.push(`could not clear active receipt rule set: ${(e as Error).message}`);
  }

  // 3. Delete the CloudFormation stack and wait for it to finish.
  if (initialStatus) {
    try {
      await cloudformation.send(new DeleteStackCommand({ StackName: stackName }));
      if (await waitForStackDeleted(ctx, stackName)) {
        deleted.push(`CloudFormation stack ${stackName}`);
        ledger.push({ action: "deleted", service: "CloudFormation", resourceType: "Stack", name: stackName, region });
      } else {
        warnings.push(`stack ${stackName} did not reach DELETE_COMPLETE; some resources may remain — check CloudFormation`);
      }
    } catch (e) {
      warnings.push(`DeleteStack failed: ${(e as Error).message}`);
    }
  }

  // 4. Delete the RETAINed resources the stack left behind (idempotent).
  for (const b of orphanBuckets) {
    try {
      if (await emptyAndDeleteBucket(ctx, b)) {
        deleted.push(`S3 bucket ${b}`);
        ledger.push({ action: "deleted", service: "S3", resourceType: "Bucket", name: b, region });
      }
    } catch (e) {
      warnings.push(`bucket ${b}: ${(e as Error).message}`);
    }
  }
  for (const t of orphanTables) {
    try {
      await dynamodb.send(new DeleteTableCommand({ TableName: t }));
      deleted.push(`DynamoDB table ${t}`);
      ledger.push({ action: "deleted", service: "DynamoDB", resourceType: "Table", name: t, region });
    } catch (e) {
      if (!/ResourceNotFound/i.test((e as Error).name ?? "")) warnings.push(`table ${t}: ${(e as Error).message}`);
    }
  }
  for (const p of orphanUserPools) {
    try {
      await cognito.send(new DeleteUserPoolCommand({ UserPoolId: p }));
      deleted.push(`Cognito user pool ${p}`);
      ledger.push({ action: "deleted", service: "Cognito", resourceType: "UserPool", name: p, region });
    } catch (e) {
      if (!/ResourceNotFound/i.test((e as Error).name ?? "")) warnings.push(`user pool ${p}: ${(e as Error).message}`);
    }
  }

  // 5. Delete the per-account deploy bucket (template + Lambda zip). Default on;
  //    pass deleteDeployBucket:false to keep it for faster future deploys.
  if (args.deleteDeployBucket !== false) {
    try {
      const accountId = await getAccountId(ctx);
      const deployBucket = `mailpoppy-deploy-${accountId}-${region}`;
      if (await emptyAndDeleteBucket(ctx, deployBucket)) {
        deleted.push(`S3 deploy bucket ${deployBucket}`);
        ledger.push({ action: "deleted", service: "S3", resourceType: "Bucket", name: deployBucket, region });
      }
    } catch (e) {
      warnings.push(`deploy bucket: ${(e as Error).message}`);
    }
  }

  // 6. Delete the SES domain identity for EVERY provisioned domain.
  for (const d of domainsToClean) {
    try {
      await sesv2.send(new DeleteEmailIdentityCommand({ EmailIdentity: d }));
      deleted.push(`SES domain identity ${d}`);
      ledger.push({ action: "deleted", service: "SES", resourceType: "EmailIdentity", name: d, region });
    } catch (e) {
      if (!/NotFound/i.test((e as Error).name ?? "")) warnings.push(`SES identity ${d}: ${(e as Error).message}`);
    }
  }

  // 6b. Delete any EMAIL-ADDRESS identities MailPoppy created (verified test
  //     recipients for sandbox sends — recorded in the ledger, name contains "@").
  //     Best-effort: skip ones a later ledger entry already marks deleted.
  try {
    for (const addr of liveRecipientIdentities(await readLedger())) {
      try {
        await sesv2.send(new DeleteEmailIdentityCommand({ EmailIdentity: addr }));
        deleted.push(`SES verified recipient ${addr}`);
        ledger.push({ action: "deleted", service: "SES", resourceType: "EmailIdentity", name: addr, region });
      } catch (e) {
        if (!/NotFound/i.test((e as Error).name ?? "")) warnings.push(`SES recipient ${addr}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    warnings.push(`verified recipients cleanup: ${(e as Error).message}`);
  }

  // 7. Remove the DNS records (MX / DMARC / DKIM CNAMEs / amazonses SPF) for
  //    every provisioned domain. Each domain's hosted zone is cleaned independently.
  for (const d of domainsToClean) {
    try {
      const removed = await removeDnsRecords(ctx, d);
      for (const desc of removed) {
        deleted.push(`Route53 ${desc}`);
        ledger.push({ action: "deleted", service: "Route53", resourceType: "DNS", name: desc, region });
      }
    } catch (e) {
      warnings.push(`DNS cleanup ${d}: ${(e as Error).message}`);
    }
  }

  await record(ledger);
  return { ok: true, domain, domains: [...domainsToClean], stackName, deleted, warnings };
}

export interface RemoveDomainResult {
  ok: true;
  domain: string;
  stackName: string;
  deletedMailboxes: string[]; // emails removed
  deletedMessages: number; // total stored messages purged across those mailboxes
  deletedObjects: number; // total S3 objects purged (raw .eml + attachments)
  freedBytes: number;
  sesIdentityDeleted: boolean;
  dnsRemoved: string[]; // human-readable DNS record removals
  warnings: string[]; // non-fatal issues the user should know about
}

/**
 * Remove ONE domain from the shared backend, leaving the CloudFormation stack and
 * every OTHER domain intact. Deletes everything specific to this domain:
 *   - each mailbox on it (Cognito user + its stored mail in S3/DynamoDB + quota
 *     row) via deleteMailbox,
 *   - the domain's per-domain mail-rules + retention overrides,
 *   - the SES domain identity (stops sending; clears DKIM/MAIL FROM), and
 *   - the published DNS records (apex MX / DKIM CNAMEs / DMARC / MAIL FROM MX +
 *     SPF) in the domain's hosted zone.
 *
 * Inbound stops the moment the identity + apex MX are gone, so the shared SES
 * receipt rule is intentionally left untouched — editing its recipients risks an
 * empty list, which SES treats as a catch-all. Best-effort + idempotent: each
 * step tolerates "already gone" and collects failures as warnings rather than
 * aborting, so a partial run can be finished by running it again.
 */
export async function removeDomain(
  ctx: AwsContext,
  args: { domain: string; stackName?: string },
): Promise<RemoveDomainResult> {
  const { sesv2, dynamodb } = clients(ctx);
  const region = ctx.region;
  const stackName = args.stackName ?? "MailpoppyMailStack";
  const domain = args.domain.trim().toLowerCase();
  if (!domain || !domain.includes(".")) throw new Error(`invalid domain: ${args.domain}`);

  const deletedMailboxes: string[] = [];
  const warnings: string[] = [];
  const ledger: Array<Omit<LedgerEntry, "ts">> = [];
  let deletedMessages = 0;
  let deletedObjects = 0;
  let freedBytes = 0;

  // 1. Delete every mailbox on this domain (sign-in user + its stored mail +
  //    quota). deleteMailbox records its own ledger entry per mailbox.
  try {
    const outputs = await getStackOutputs(ctx, stackName);
    if (outputs.UserPoolId) {
      const boxes = (await listMailboxes(ctx, outputs.UserPoolId)).filter((m) => addressDomain(m.email) === domain);
      for (const m of boxes) {
        try {
          const r = await deleteMailbox(ctx, { stackName, email: m.email });
          deletedMailboxes.push(m.email);
          deletedMessages += r.deletedMessages;
          deletedObjects += r.deletedObjects;
          freedBytes += r.freedBytes;
        } catch (e) {
          warnings.push(`mailbox ${m.email}: ${(e as Error).message}`);
        }
      }
      // 2. Drop this domain's per-domain settings overrides (best-effort).
      const settingsTable = await resolveSettingsTableName(ctx, stackName, outputs);
      if (settingsTable) {
        for (const key of [policySettingsKey(domain), retentionSettingsKey(domain)]) {
          try {
            await dynamodb.send(new DeleteItemCommand({ TableName: settingsTable, Key: { pk: { S: key } } }));
          } catch {
            // a left-over settings row is harmless
          }
        }
      }
    } else {
      warnings.push("no user pool in stack outputs — skipped mailbox cleanup");
    }
  } catch (e) {
    warnings.push(`stack outputs unavailable (${(e as Error).message}) — skipped mailbox + settings cleanup`);
  }

  // 3. Delete the SES domain identity (stops sending; removes DKIM/MAIL FROM).
  let sesIdentityDeleted = false;
  try {
    await sesv2.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain }));
    sesIdentityDeleted = true;
    ledger.push({ action: "deleted", service: "SES", resourceType: "EmailIdentity", name: domain, region });
  } catch (e) {
    if (!/NotFound/i.test((e as Error).name ?? "")) warnings.push(`SES identity ${domain}: ${(e as Error).message}`);
  }

  // 4. Remove the DNS records Mailpoppy published in this domain's hosted zone.
  let dnsRemoved: string[] = [];
  try {
    dnsRemoved = await removeDnsRecords(ctx, domain);
    for (const desc of dnsRemoved) {
      ledger.push({ action: "deleted", service: "Route53", resourceType: "DNS", name: desc, region });
    }
  } catch (e) {
    warnings.push(`DNS cleanup ${domain}: ${(e as Error).message}`);
  }

  await record(ledger);
  return {
    ok: true,
    domain,
    stackName,
    deletedMailboxes,
    deletedMessages,
    deletedObjects,
    freedBytes,
    sesIdentityDeleted,
    dnsRemoved,
    warnings,
  };
}
