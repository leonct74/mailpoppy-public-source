import {
  Stack,
  type StackProps,
  RemovalPolicy,
  Duration,
  CfnParameter,
  CfnCondition,
  CfnOutput,
  Fn,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as guardduty from "aws-cdk-lib/aws-guardduty";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sesActions from "aws-cdk-lib/aws-ses-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { HttpApi, HttpMethod, CorsHttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";

const BY_MESSAGE_INDEX = "by-message";

/**
 * The deployable Mailpoppy backend — runs entirely inside the CUSTOMER's AWS
 * account. `cdk synth` turns this into the CloudFormation template the desktop
 * app deploys via cloudformation:CreateStack (customers never install CDK).
 * See DESIGN §5 / §8 / §15.
 *
 * Flow wired here:
 *   SES receipt rule → S3 (raw .eml) + Lambda (inbound-processor → DynamoDB)
 *   Client → API Gateway (Cognito JWT) → access-api Lambda → DynamoDB / S3 / SES
 *   EventBridge (daily) → janitor;  SNS (bounces/complaints) → suppression
 */
export class MailStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // The domain this deployment receives mail for (e.g. "ollydigital.com").
    const mailDomain = new CfnParameter(this, "MailDomain", {
      type: "String",
      description: "Primary domain this deployment receives email for (e.g. ollydigital.com).",
    });

    // Lambda code is loaded from S3 (NOT a CDK asset) so the desktop app can
    // deploy this template via cloudformation:CreateStack — no `cdk deploy`, no
    // bootstrap. The sidecar uploads the prebuilt zip and passes these in.
    const codeBucketParam = new CfnParameter(this, "LambdaCodeBucket", {
      type: "String",
      description: "S3 bucket holding the prebuilt Lambda code zip.",
    });
    const codeKeyParam = new CfnParameter(this, "LambdaCodeKey", {
      type: "String",
      description: "S3 key of the prebuilt Lambda code zip (all handlers).",
    });
    // Optional, recommended: enable GuardDuty Malware Protection scanning of the
    // mail bucket. Off by default (it's a small paid AWS feature). When "true",
    // GuardDuty scans stored objects and tags them; the access API blocks
    // downloads of anything tagged THREATS_FOUND.
    const enableMalware = new CfnParameter(this, "EnableMalwareProtection", {
      type: "String",
      allowedValues: ["true", "false"],
      default: "false",
      description: "Scan stored mail/attachments with GuardDuty Malware Protection (recommended).",
    });
    const malwareEnabled = new CfnCondition(this, "MalwareProtectionEnabled", {
      expression: Fn.conditionEquals(enableMalware.valueAsString, "true"),
    });
    // Mailbox encryption at rest (docs/mailbox-encryption-design.md). Off by
    // default: when on, the inbound-processor seals each activated mailbox's body
    // + attachments so the admin can't read them. Flip to "true" only once every
    // client can decrypt (the design's Phase 5 "flip on" step).
    const enableEncryption = new CfnParameter(this, "EncryptionEnabled", {
      type: "String",
      allowedValues: ["true", "false"],
      default: "false",
      description: "Encrypt mailbox body + attachments at rest so even the AWS admin can't read them.",
    });
    const lambdaCode = lambda.Code.fromBucket(
      s3.Bucket.fromBucketName(this, "LambdaCodeBucketRef", codeBucketParam.valueAsString),
      codeKeyParam.valueAsString,
    );

    // ---- Storage -----------------------------------------------------------
    // Raw mail: inbound/<messageId>, sent/<messageId>.
    const mailBucket = new s3.Bucket(this, "MailBucket", {
      removalPolicy: RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Let clients (desktop webview / web app) upload large attachments straight
      // to S3 via presigned URLs. The signed URL is the credential; CORS only
      // governs which browser origins may issue the request, so "*" is safe here.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 3000,
        },
      ],
      // Auto-expire abandoned outbound-staging uploads (the backstop for /send's
      // own best-effort cleanup) so staged bytes never accrue storage cost.
      lifecycleRules: [
        {
          id: "expire-outbound-staging",
          prefix: "outbound-staging/",
          expiration: Duration.days(1),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });

    // The "mailbox" — manufactured state (flags, folders, threads) on top of S3.
    //   PK = `${domain}#${address}`   SK = `${folder}#${date}#${messageId}`
    const indexTable = new dynamodb.Table(this, "IndexTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    // Thread view (group a conversation across folders).
    indexTable.addGlobalSecondaryIndex({
      indexName: "by-thread",
      partitionKey: { name: "threadId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "date", type: dynamodb.AttributeType.STRING },
    });
    // Locate a row by SES messageId (for raw/flags/move) without scanning.
    indexTable.addGlobalSecondaryIndex({
      indexName: BY_MESSAGE_INDEX,
      partitionKey: { name: "messageId", type: dynamodb.AttributeType.STRING },
    });

    // Per-deployment / per-domain policy + the send suppression list.
    const settingsTable = new dynamodb.Table(this, "SettingsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- Identity (mailbox access plane) -----------------------------------
    const userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: false, // admins create mailbox users
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      customAttributes: { aliases: new cognito.StringAttribute({ mutable: true }) },
      mfa: cognito.Mfa.OPTIONAL,
      // Self-service password reset by email: the user sets their own password, so
      // the admin never learns it. (The forgot-password UI lands with the mail client.)
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const userPoolClient = userPool.addClient("DesktopMobileClient", {
      authFlows: { userSrp: true },
      // Public client (no secret) — desktop & React Native use SRP.
    });

    // ---- Lambdas -----------------------------------------------------------
    // All four handlers ship in one prebuilt zip (each esbuild-bundled, deps
    // inlined); they differ only by handler entry point `<name>.handler`.
    const fn = (name: string, base: string, env: Record<string, string>): lambda.Function =>
      new lambda.Function(this, name, {
        code: lambdaCode,
        handler: `${base}.handler`,
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        // Sized for the biggest thing these functions do: assembling/parsing a
        // message at the send limit (15 MB raw → ~20 MB base64, and a JS string
        // holds that as UTF-16, so the working set is several times the raw size).
        // 256 MB was enough for 4 MB attachments and would OOM well before 15 MB.
        // More memory also means proportionally more CPU, so the base64 + MIME
        // work finishes faster — billing is per-ms, so this is close to cost-neutral.
        timeout: Duration.seconds(60),
        memorySize: 1024,
        environment: env,
      });

    const inboundProcessor = fn("InboundProcessor", "inbound-processor", {
      INDEX_TABLE: indexTable.tableName,
      SETTINGS_TABLE: settingsTable.tableName,
      MAIL_BUCKET: mailBucket.bucketName,
      INBOUND_PREFIX: "inbound/",
      HOSTED_DOMAINS: mailDomain.valueAsString,
      USER_POOL_ID: userPool.userPoolId, // resolve real mailboxes → reject unknown recipients
      ENCRYPTION_ENABLED: enableEncryption.valueAsString, // seal body+attachments when "true"
    });
    mailBucket.grantReadWrite(inboundProcessor); // read the raw .eml + write/delete attachments + raw
    indexTable.grantReadWriteData(inboundProcessor); // write rows + read for quota usage
    // read policy/quota docs + WRITE the per-domain DMARC#<domain>#<day> counters
    // accumulated from incoming aggregate reports (DESIGN §13).
    settingsTable.grantReadWriteData(inboundProcessor);
    // Send a "mailbox full" / "no such mailbox" bounce to the sender.
    inboundProcessor.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["ses:SendEmail", "ses:SendRawEmail"], resources: ["*"] }),
    );
    // List mailboxes (Cognito users) to tell a real recipient from an unknown one.
    inboundProcessor.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["cognito-idp:ListUsers"], resources: [userPool.userPoolArn] }),
    );
    // The CrewPoppy bridge: mail delivered to a mailbox the admin flagged
    // agent-owned is COPIED to CrewPoppy's runner Lambda in this same account +
    // region. Pinned to that exact function name (not CrewPoppy*): MailPoppy can
    // START the admin's agents; it can never read their data or touch anything
    // else of theirs. If CrewPoppy isn't installed, the invoke fails and mail
    // delivery proceeds untouched.
    inboundProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [`arn:${this.partition}:lambda:${this.region}:${this.account}:function:CrewPoppyRunner`],
      }),
    );

    const accessApi = fn("AccessApi", "access-api", {
      INDEX_TABLE: indexTable.tableName,
      SETTINGS_TABLE: settingsTable.tableName,
      MAIL_BUCKET: mailBucket.bucketName,
      BY_MESSAGE_INDEX,
      SENT_PREFIX: "sent/",
    });
    indexTable.grantReadWriteData(accessApi);
    mailBucket.grantReadWrite(accessApi);
    // Read quota docs; WRITE the per-mailbox push device-token registry (/devices).
    settingsTable.grantReadWriteData(accessApi);
    // SendEmail covers the simple (no-attachment) path; SendRawEmail is required
    // when we send a hand-built raw MIME message (attachments).
    accessApi.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["ses:SendEmail", "ses:SendRawEmail"], resources: ["*"] }),
    );

    const janitor = fn("Janitor", "janitor", {
      INDEX_TABLE: indexTable.tableName,
      SETTINGS_TABLE: settingsTable.tableName,
      MAIL_BUCKET: mailBucket.bucketName,
    });
    indexTable.grantReadWriteData(janitor);
    mailBucket.grantReadWrite(janitor);
    settingsTable.grantReadData(janitor); // read the admin's retention settings

    const suppression = fn("Suppression", "suppression", {
      SETTINGS_TABLE: settingsTable.tableName,
    });
    settingsTable.grantWriteData(suppression);

    // ---- Inbound pipeline: SES receipt rule → S3 + Lambda ------------------
    const ruleSet = new ses.ReceiptRuleSet(this, "MailRuleSet");
    ruleSet.addRule("InboundRule", {
      // Catch-all (no `recipients` → matches every recipient that reaches our MX).
      // Only the domains we provision point their MX at SES inbound, so this rule
      // only ever sees our own mail; the inbound-processor then decides acceptance
      // per recipient against the LIVE Cognito mailbox set. This is what lets a
      // newly-added domain receive mail without re-deploying the stack just to
      // widen a recipients list. (`mailDomain` still seeds the Lambda's
      // HOSTED_DOMAINS fallback, used only if the mailbox lookup transiently fails.)
      scanEnabled: true, // populate spam/virus verdicts
      actions: [
        new sesActions.S3({ bucket: mailBucket, objectKeyPrefix: "inbound/" }),
        new sesActions.Lambda({
          function: inboundProcessor,
          invocationType: sesActions.LambdaInvocationType.EVENT,
        }),
      ],
    });

    // Only one receipt rule set can be active per account/region. Rather than a
    // custom-resource Lambda (which would re-introduce a CDK asset and break the
    // asset-free CreateStack path), the sidecar calls SES setActiveReceiptRuleSet
    // right after the stack deploys (and clears it on teardown), using RuleSetName.

    // ---- Access API: HTTP API + Cognito JWT authorizer ---------------------
    const authorizer = new HttpUserPoolAuthorizer("MailboxAuthorizer", userPool, {
      userPoolClients: [userPoolClient],
    });
    const integration = new HttpLambdaIntegration("AccessApiIntegration", accessApi);
    const httpApi = new HttpApi(this, "MailApi", {
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: ["*"], // desktop (tauri/localhost) + mobile
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["authorization", "content-type"],
      },
    });
    httpApi.addRoutes({ path: "/usage", methods: [HttpMethod.GET], integration });
    httpApi.addRoutes({ path: "/messages", methods: [HttpMethod.GET], integration });
    httpApi.addRoutes({ path: "/messages/{id}/raw", methods: [HttpMethod.GET], integration });
    httpApi.addRoutes({ path: "/messages/{id}/attachments/{index}", methods: [HttpMethod.GET], integration });
    httpApi.addRoutes({ path: "/messages/{id}/flags", methods: [HttpMethod.PATCH], integration });
    httpApi.addRoutes({ path: "/messages/{id}/move", methods: [HttpMethod.POST], integration });
    // Permanently empty the Trash folder (user-driven hard delete).
    httpApi.addRoutes({ path: "/trash/empty", methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: "/send", methods: [HttpMethod.POST], integration });
    // Outbound config + large-attachment staging (presigned direct-to-S3 upload).
    httpApi.addRoutes({ path: "/send-config", methods: [HttpMethod.GET], integration });
    httpApi.addRoutes({ path: "/attachments/presign", methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: "/drafts", methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: "/drafts/{id}", methods: [HttpMethod.DELETE], integration });
    // Mobile push: register/refresh + unregister an Expo device token.
    httpApi.addRoutes({ path: "/devices", methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: "/devices/{token}", methods: [HttpMethod.DELETE], integration });
    // Mailbox encryption: read / upload the caller's public + password-wrapped key.
    httpApi.addRoutes({ path: "/mailbox-keys", methods: [HttpMethod.GET, HttpMethod.PUT], integration });

    // ---- Retention janitor (daily) -----------------------------------------
    new events.Rule(this, "JanitorSchedule", {
      schedule: events.Schedule.rate(Duration.days(1)),
      targets: [new targets.LambdaFunction(janitor)],
    });

    // ---- Bounce/complaint suppression --------------------------------------
    // SES publishes bounce/complaint notifications here; wiring the verified
    // identity → topic is completed at provisioning time (DESIGN §13).
    const notifications = new sns.Topic(this, "MailNotifications");
    notifications.addSubscription(new subs.LambdaSubscription(suppression));

    // ---- Optional: GuardDuty Malware Protection for S3 (deep file scanning) --
    // Created only when EnableMalwareProtection=true. The role + permissions are
    // exactly those AWS documents for Malware Protection for S3 with object
    // tagging (no KMS statement — the mail bucket uses SSE-S3, not KMS).
    const eventsRuleArn = `arn:aws:events:${this.region}:${this.account}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*`;
    const scanRole = new iam.CfnRole(this, "MalwareScanRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "malware-protection-plan.guardduty.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      },
      policies: [
        {
          policyName: "MalwareScanPolicy",
          policyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "AllowManagedRuleToSendS3EventsToGuardDuty",
                Effect: "Allow",
                Action: ["events:PutRule", "events:DeleteRule", "events:PutTargets", "events:RemoveTargets"],
                Resource: [eventsRuleArn],
                Condition: { StringLike: { "events:ManagedBy": "malware-protection-plan.guardduty.amazonaws.com" } },
              },
              {
                Sid: "AllowGuardDutyToMonitorEventBridgeManagedRule",
                Effect: "Allow",
                Action: ["events:DescribeRule", "events:ListTargetsByRule"],
                Resource: [eventsRuleArn],
              },
              {
                Sid: "AllowPostScanTag",
                Effect: "Allow",
                Action: ["s3:PutObjectTagging", "s3:GetObjectTagging", "s3:PutObjectVersionTagging", "s3:GetObjectVersionTagging"],
                Resource: [`${mailBucket.bucketArn}/*`],
              },
              {
                Sid: "AllowEnableS3EventBridgeEvents",
                Effect: "Allow",
                Action: ["s3:PutBucketNotification", "s3:GetBucketNotification"],
                Resource: [mailBucket.bucketArn],
              },
              {
                Sid: "AllowPutValidationObject",
                Effect: "Allow",
                Action: ["s3:PutObject"],
                Resource: [`${mailBucket.bucketArn}/malware-protection-resource-validation-object`],
              },
              {
                Sid: "AllowCheckBucketOwnership",
                Effect: "Allow",
                Action: ["s3:ListBucket"],
                Resource: [mailBucket.bucketArn],
              },
              {
                Sid: "AllowMalwareScan",
                Effect: "Allow",
                Action: ["s3:GetObject", "s3:GetObjectVersion"],
                Resource: [`${mailBucket.bucketArn}/*`],
              },
            ],
          },
        },
      ],
    });
    scanRole.cfnOptions.condition = malwareEnabled;

    const malwarePlan = new guardduty.CfnMalwareProtectionPlan(this, "MalwareProtectionPlan", {
      role: scanRole.attrArn,
      protectedResource: { s3Bucket: { bucketName: mailBucket.bucketName } },
      actions: { tagging: { status: "ENABLED" } },
    });
    malwarePlan.cfnOptions.condition = malwareEnabled;
    malwarePlan.addDependency(scanRole);

    // ---- Outputs (the desktop app reads these to configure the client) -----
    new CfnOutput(this, "MalwareProtection", {
      value: Fn.conditionIf(malwareEnabled.logicalId, "enabled", "disabled").toString(),
    });
    new CfnOutput(this, "ApiBaseUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "MailBucketName", { value: mailBucket.bucketName });
    new CfnOutput(this, "IndexTableName", { value: indexTable.tableName });
    new CfnOutput(this, "SettingsTableName", { value: settingsTable.tableName });
    new CfnOutput(this, "NotificationsTopicArn", { value: notifications.topicArn });
    new CfnOutput(this, "RuleSetName", { value: ruleSet.receiptRuleSetName });
    new CfnOutput(this, "DeployRegion", { value: this.region });
  }
}
