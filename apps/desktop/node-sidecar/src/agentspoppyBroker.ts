// AgentsPoppy broker integration (opt-in) — lets MailPoppy obtain its AWS
// credentials from a *local* AgentsPoppy broker instead of a ~/.aws profile, so
// AgentsPoppy can govern, monitor, and tear down whatever MailPoppy deploys.
//
// This is a tiny, self-contained mirror of the `@agentspoppy/client` SDK
// (zero-dependency, structural types) so we don't take a cross-repo build
// dependency. It speaks the same local broker HTTP API:
//   GET  /accounts                                  → linked AWS accounts
//   GET  /connections                               → existing connections
//   POST /connections                               → request a connection
//   GET  /connections/:id                            → poll status
//   POST /connections/:id/credentials               → mint scoped creds
//
// DEFAULT OFF. Nothing changes unless MAILPOPPY_AGENTSPOPPY_BROKER is set (or the
// user explicitly connects via POST /agentspoppy/connect). When off, MailPoppy
// keeps resolving credentials from the ~/.aws `mailpoppy` profile exactly as before.

const DEFAULT_BASE_URL = "http://127.0.0.1:8799";
const REFRESH_BUFFER_MS = 300_000; // re-mint 5 min before expiry

/**
 * The stable ownership tag AgentsPoppy attributes + tears down on (must match the
 * broker). Keyed to the APP, not the connection, so a stack survives connection
 * supersedes instead of being orphaned. CloudFormation propagates it to resources.
 */
export const APP_TAG_KEY = "agentspoppy:app";

/** Audit tag recording which connection created the stack (not used for ownership). */
export const CONNECTION_TAG_KEY = "agentspoppy:connection";

/** Account attribution tag. */
export const ACCOUNT_TAG_KEY = "agentspoppy:account";

/**
 * AgentsPoppy's sentinel resourceScope meaning "only resources tagged as THIS
 * app's own" — the broker turns it into an `aws:ResourceTag/agentspoppy:app`
 * condition on the vended session policy. Value must match @agentspoppy/core's
 * TAGGED_AS_SELF. Used to ensure MailPoppy can only touch resources it created.
 */
const TAGGED_AS_SELF = "tagged-as-self";

/** AWS SDK v3 `AwsCredentialIdentity` shape (structural — no SDK import needed). */
export interface AwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}
export type AwsCredentialIdentityProvider = () => Promise<AwsCredentialIdentity>;

interface ScopedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}
type ConnectionStatus = "pending" | "active" | "paused" | "revoked";
interface ConnectionDTO {
  id: string;
  accountId: string;
  status: ConnectionStatus;
  app?: { id: string; name: string };
  /** The scope the broker stored at creation — compared on reconnect to detect drift. */
  permissionSet?: { grants?: unknown[] };
}
interface AccountDTO {
  id: string;
  accountId: string;
  alias?: string;
  regions: string[];
}

/** How MailPoppy introduces itself to AgentsPoppy. */
export const APP = { id: "com.mailpoppy.desktop", name: "MailPoppy" } as const;

/**
 * What MailPoppy asks AgentsPoppy to broker — a faithful mirror of MailPoppy's own
 * least-privilege deploy + provisioning policies (infra/policies/mailpoppy-*.json),
 * NOT a lazy `*`. Every grant is the minimal action set, scoped to MailPoppy's own
 * resources (`MailpoppyMailStack-*` / `mailpoppy*`) wherever AWS supports
 * resource-level permissions. A handful of services genuinely can't be
 * resource-scoped (SES, Route53, Cognito user-pool *creation*, GuardDuty, the
 * read-only capability/identity probes), so those stay account-wide — but always
 * with a specific action list, never `service:*`, and never ANY IAM *user*
 * management. AgentsPoppy enforces these scopes in the session policy it vends
 * (policy.ts writes resourceScope straight into the credential's Resource), so this
 * is a real bound on the credentials, not just a friendlier label.
 *
 * Keep this in sync with infra/policies/mailpoppy-deploy-policy.json +
 * mailpoppy-provisioning-policy.json — those are the tested source of truth.
 *
 * This is ALSO the source the AgentsPoppy extension manifest (`extension.json`) is
 * generated from (see extensionManifest.ts / scripts/build-manifest.mjs), so the
 * container host reconciles the exact same scope and the two can never drift.
 */
export function permissionSet() {
  const grant = (service: string, actions: string[], resourceScope = "*") => ({ service, actions, resourceScope });
  const stack = "arn:aws:cloudformation:*:*:stack/MailpoppyMailStack/*";
  const role = "arn:aws:iam::*:role/MailpoppyMailStack-*";
  const fn = "arn:aws:lambda:*:*:function:MailpoppyMailStack-*";
  const table = "arn:aws:dynamodb:*:*:table/MailpoppyMailStack-*";
  const tableIndexes = "arn:aws:dynamodb:*:*:table/MailpoppyMailStack-*/index/*";
  const logs = "arn:aws:logs:*:*:log-group:/aws/lambda/MailpoppyMailStack-*";
  const topic = "arn:aws:sns:*:*:MailpoppyMailStack-*";
  const rule = "arn:aws:events:*:*:rule/MailpoppyMailStack-*";
  // API Gateway has no TagResource/UntagResource IAM action — tagging goes through POST/PUT
  // on the /tags path below. Access Analyzer rejects both names as INVALID_ACTION, and they
  // only padded the consent list users read.
  const apigwVerbs = ["POST", "GET", "PATCH", "PUT", "DELETE"];
  const buckets = "arn:aws:s3:::mailpoppy*";
  const objects = "arn:aws:s3:::mailpoppy*/*";
  return {
    id: "mailpoppy-backend",
    name: "MailPoppy backend",
    description:
      "Deploy & manage the MailPoppy mail backend, scoped to MailpoppyMailStack-* / mailpoppy* resources. " +
      "It also applies your AgentsPoppy safety limit to the roles it creates, so they can never be given " +
      "more access than you have allowed. " +
      "If you also use CrewPoppy, mail addressed to an agent-owned mailbox is handed to your CrewPoppy agents. " +
      "MailPoppy can start your agents; it can never read their data or touch anything else of theirs.",
    grants: [
      // --- CloudFormation: the stack itself, plus account-level read-only validation ---
      grant("cloudformation", [
        "CreateStack", "UpdateStack", "DeleteStack", "DescribeStacks", "DescribeStackEvents",
        "DescribeStackResources", "ListStackResources", "GetTemplate", "CreateChangeSet",
        "DescribeChangeSet", "ExecuteChangeSet", "DeleteChangeSet", "TagResource",
      ], stack),
      grant("cloudformation", ["ValidateTemplate", "GetTemplateSummary"]),
      // --- IAM: only the stack's own Lambda roles (NO user management, NO iam:*) ---
      grant("iam", [
        "CreateRole", "DeleteRole", "GetRole", "TagRole", "UntagRole", "AttachRolePolicy",
        "DetachRolePolicy", "PutRolePolicy", "DeleteRolePolicy", "GetRolePolicy",
        "ListRolePolicies", "ListAttachedRolePolicies", "PassRole",
        // AgentsPoppy's permissions boundary (broker-role-v2 step 2): CloudFormation
        // attaches/strips it on the stack's own roles when the PermissionsBoundaryArn
        // parameter is set/cleared. Same role scope — this CAPS the roles, it grants
        // them nothing.
        "PutRolePermissionsBoundary", "DeleteRolePermissionsBoundary",
      ], role),
      grant("iam", ["SimulatePrincipalPolicy"]), // read-only capability probe
      // --- Compute / data, all pinned to MailpoppyMailStack-* ---
      grant("lambda", [
        "CreateFunction", "DeleteFunction", "GetFunction", "GetFunctionConfiguration",
        "UpdateFunctionCode", "UpdateFunctionConfiguration", "AddPermission", "RemovePermission",
        "InvokeFunction", "TagResource", "UntagResource", "ListTags",
      ], fn),
      // --- Cross-poppy integration grant (the platform's first — a deliberate,
      //     visible exception to "a poppy touches only its own resources"): if the
      //     admin also uses CrewPoppy, mail addressed to an agent-owned mailbox is
      //     handed to their CrewPoppy agents. Pinned to the exact runner function
      //     name, not CrewPoppy* — MailPoppy can START your agents; it can never
      //     read their data or touch anything else of theirs. ---
      grant("lambda", ["InvokeFunction"], "arn:aws:lambda:*:*:function:CrewPoppyRunner"),
      grant("dynamodb", [
        // control plane: table lifecycle
        "CreateTable", "DeleteTable", "DescribeTable", "UpdateTable", "DescribeContinuousBackups",
        "UpdateContinuousBackups", "DescribeTimeToLive", "UpdateTimeToLive", "TagResource",
        "UntagResource", "ListTagsOfResource",
        // data plane: the sidecar reads/writes items directly — listing & purging a
        // mailbox's messages (Query/Scan + BatchWriteItem), per-mailbox quota/settings
        // (Get/Put/DeleteItem). Without these, deleting a mailbox fails on dynamodb:Query.
        "GetItem", "BatchGetItem", "PutItem", "UpdateItem", "DeleteItem", "Query", "Scan",
        "BatchWriteItem", "ConditionCheckItem",
      ], table),
      // Query/Scan against a table's secondary indexes need the index ARN as well.
      grant("dynamodb", ["Query", "Scan"], tableIndexes),
      grant("logs", ["CreateLogGroup", "DeleteLogGroup", "DescribeLogGroups", "PutRetentionPolicy", "TagResource"], logs),
      grant("sns", [
        "CreateTopic", "DeleteTopic", "Subscribe", "Unsubscribe", "GetTopicAttributes",
        "SetTopicAttributes", "GetSubscriptionAttributes", "TagResource", "UntagResource",
      ], topic),
      grant("events", [
        "PutRule", "DeleteRule", "DescribeRule", "PutTargets", "RemoveTargets",
        "ListTargetsByRule", "TagResource", "UntagResource",
      ], rule),
      // API Gateway control-plane ARNs are account-less and the API id is server-assigned, so
      // we can't pin to "our" API at create time — but we DO keep it to the /apis (v1+v2) and
      // /tags paths only (never /domainnames, /account, /vpclinks, /usageplans). Tagging a new
      // API/stage is a POST to the SEPARATE /tags/<arn> path; an /apis-only scope missed it, so
      // the create rolled back (AccessDenied on apigateway:POST /tags/...). AWS's own
      // AmazonAPIGatewayAdministrator just uses the broader /*.
      grant("apigateway", apigwVerbs, "arn:aws:apigateway:*::/apis*"),
      grant("apigateway", apigwVerbs, "arn:aws:apigateway:*::/v2/apis*"),
      grant("apigateway", apigwVerbs, "arn:aws:apigateway:*::/tags*"),
      // --- S3: only mailpoppy* buckets/objects (+ read-only bucket listing) ---
      grant("s3", [
        "CreateBucket", "DeleteBucket", "PutBucketPolicy", "GetBucketPolicy", "DeleteBucketPolicy",
        "PutEncryptionConfiguration", "GetEncryptionConfiguration", "PutBucketPublicAccessBlock",
        "GetBucketPublicAccessBlock", "PutBucketTagging", "PutLifecycleConfiguration",
        "GetLifecycleConfiguration", "PutBucketCORS", "GetBucketCORS", "ListBucket", "HeadBucket",
      ], buckets),
      grant("s3", ["GetObject", "PutObject", "DeleteObject"], objects),
      grant("s3", ["ListAllMyBuckets"]),
      // --- Cognito: creating a pool/client, reading, and tagging can't be tied to a
      //     not-yet-existing resource (and CFN needs TagResource to stamp the propagated
      //     connection tag onto the new pool), so they stay account-wide — harmless.
      //     But every operation that could DAMAGE or read out an existing pool (delete,
      //     reconfigure, or touch its users) is scoped to pools tagged as MailPoppy's
      //     OWN — so MailPoppy can never delete or alter another app's user pool. ---
      grant("cognito-idp", [
        "CreateUserPool", "CreateUserPoolClient", "DescribeUserPool", "DescribeUserPoolClient",
        "GetUserPoolMfaConfig", "TagResource", "UntagResource",
        // ListUsers is account-wide, NOT tagged-as-self: AWS does not populate
        // aws:ResourceTag in the authorization context for cognito-idp:ListUsers, so a
        // tag-scoped grant for it is an effective DENY (unlike the Admin* item ops below,
        // which DO get the resource tag — that's why mailbox-create works tag-scoped but
        // the manage view's mailbox-LIST didn't). Exposure is bounded: it can only list a
        // pool whose id it already knows, and there's no ListUserPools grant to discover
        // others — MailPoppy only ever lists its own pool (from its stack outputs).
        "ListUsers",
      ]),
      grant("cognito-idp", [
        "DeleteUserPool", "UpdateUserPool", "DeleteUserPoolClient", "UpdateUserPoolClient",
        "SetUserPoolMfaConfig", "AdminCreateUser", "AdminSetUserPassword", "AdminDeleteUser",
      ], TAGGED_AS_SELF),
      // --- Services with no resource-level IAM support: specific actions, account-wide ---
      grant("ses", [
        "CreateReceiptRuleSet", "CreateReceiptRule", "DeleteReceiptRule", "DeleteReceiptRuleSet",
        "DescribeReceiptRuleSet", "DescribeActiveReceiptRuleSet", "SetActiveReceiptRuleSet",
        "CreateEmailIdentity", "GetEmailIdentity", "DeleteEmailIdentity", "ListEmailIdentities",
        "GetAccount", "GetSendStatistics", "PutAccountDetails", "PutEmailIdentityMailFromAttributes", "SendEmail",
        // Point a domain's bounce/complaint notifications at our SNS topic, so the
        // suppression Lambda receives them (without these the do-not-send list and the
        // per-domain sending-health counters are never populated at all).
        "SetIdentityNotificationTopic", "SetIdentityHeadersInNotificationsEnabled",
        // Clearing a do-not-send entry must also clear AWS's OWN account-level suppression
        // entry, or the "unblocked" send is accepted by SES and silently dropped.
        "DeleteSuppressedDestination",
      ]),
      grant("route53", ["ListHostedZonesByName", "ListResourceRecordSets", "ChangeResourceRecordSets"]),
      grant("guardduty", [
        "CreateMalwareProtectionPlan", "GetMalwareProtectionPlan", "UpdateMalwareProtectionPlan",
        "DeleteMalwareProtectionPlan", "ListMalwareProtectionPlans", "TagResource", "UntagResource", "ListTagsForResource",
      ]),
      grant("sts", ["GetCallerIdentity"]),
    ],
    requiredTags: [CONNECTION_TAG_KEY],
    limits: null,
  };
}

/**
 * A canonical signature of a permission set's grants, for detecting whether the scope
 * MailPoppy declares has drifted from what a stored connection was created with. Per
 * grant we take [service, sorted actions, resourceScope]; actions are sorted so a mere
 * ordering difference isn't seen as a change, but grant order (and any added/removed
 * grant) still is. Anything non-array → "" so a malformed/absent set always differs.
 */
function grantsSignature(grants: unknown): string {
  if (!Array.isArray(grants)) return "";
  return JSON.stringify(
    grants.map((g) => {
      const x = (g ?? {}) as { service?: string; actions?: string[]; resourceScope?: string };
      return [x.service ?? "", [...(x.actions ?? [])].sort(), x.resourceScope ?? ""];
    }),
  );
}

/**
 * What the AgentsPoppy *container host* injects into MailPoppy's backend when it
 * spawns it as an extension (env `AGENTSPOPPY_BOOTSTRAP`, a JSON blob). This REPLACES
 * the old self-discovery dance (`beginBrokerConnect`): the host has already created
 * (and the user has approved) the connection, so the backend doesn't hunt for the
 * broker on a fixed port or request its own connection — it's handed the exact
 * connection id, a loopback endpoint to mint this connection's scoped credentials,
 * the port to listen on, and the resolved AWS account/region. Mirror of
 * @agentspoppy/extension-sdk's BackendBootstrap (structural — no cross-repo dep).
 *
 * Absent → standalone mode (the existing self-connect / ~/.aws profile path), unchanged.
 */
interface BackendBootstrap {
  connectionId: string;
  credentialsUrl: string;
  /** Bearer token proving this backend may mint ITS OWN connection's creds. The
   *  broker rejects the mint without it (and rejects it on any other route), so a
   *  poppy can't use it to touch a sibling. Absent against a pre-auth broker. */
  credentialsToken?: string;
  port?: number;
  /**
   * The private, per-poppy folder the host created for us (0700) — once the backend is
   * confined (`backend.isolation: "strict"`), the ONLY place outside the OS temp dir it
   * may write. The provisioning ledger and the buyer id live here (storage.ts). Absent
   * on a host too old to send it, which is also a host too old to confine us.
   */
  dataDir?: string;
  /**
   * ARN of the account's `AgentsPoppyBoundary` managed policy — present only when the
   * host has confirmed the deployed AgentsPoppy setup actually carries it. When set,
   * the deploy passes it as the stack's `PermissionsBoundaryArn` parameter so every
   * IAM role the stack creates is capped by the boundary. Absent → deploy preserves
   * whatever the stack already has (never strips a boundary on a hiccup, never names
   * a policy that may not exist).
   */
  permissionsBoundaryArn?: string;
  account: { accountId: string; region: string };
}

/** A usable IAM policy ARN, or undefined. See the bootstrap field's comment. */
function boundaryArnOrUndefined(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const arn = v.trim();
  return /^arn:aws[a-z-]*:iam::\d{12}:policy\/.+/.test(arn) ? arn : undefined;
}

function readBootstrap(): BackendBootstrap | null {
  const raw = process.env.AGENTSPOPPY_BOOTSTRAP;
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as Partial<BackendBootstrap>;
    if (
      b &&
      typeof b.connectionId === "string" &&
      typeof b.credentialsUrl === "string" &&
      b.account &&
      typeof b.account.accountId === "string" &&
      typeof b.account.region === "string"
    ) {
      return {
        connectionId: b.connectionId,
        credentialsUrl: b.credentialsUrl,
        credentialsToken: typeof b.credentialsToken === "string" ? b.credentialsToken : undefined,
        port: typeof b.port === "number" ? b.port : undefined,
        dataDir: typeof b.dataDir === "string" && b.dataDir ? b.dataDir : undefined,
        // Must look like an IAM policy ARN. Anything else — absent, empty, whitespace,
        // the wrong shape — becomes undefined and we deploy unbounded, because a
        // malformed value would make the CFN condition true and fail every CreateRole
        // in the stack: a rolled-back deploy instead of the graceful degradation the
        // optional-by-construction design promises.
        permissionsBoundaryArn: boundaryArnOrUndefined(b.permissionsBoundaryArn),
        account: { accountId: b.account.accountId, region: b.account.region },
      };
    }
  } catch {
    /* malformed bootstrap → treat as standalone */
  }
  return null;
}

// --- module state (the sidecar is a single long-lived process) ---

/** Set when the host spawned us as an in-container extension; null in standalone mode. */
const bootstrap = readBootstrap();

let baseUrl = process.env.AGENTSPOPPY_BASE_URL ?? DEFAULT_BASE_URL;
let enabled = bootstrap !== null || /^(1|true|yes|on)$/i.test(process.env.MAILPOPPY_AGENTSPOPPY_BROKER ?? "");
let connection: ConnectionDTO | null = null;
let credsProvider: AwsCredentialIdentityProvider | null = null;
/** AWS account number behind the active connection (for display); set on connect. */
let awsAccountId: string | null = null;

// In container (bootstrap) mode the host only spawns this backend once the connection
// is active, so bind to it immediately — no /accounts lookup, no connection request,
// no approval poll for the *connection* itself (per-mint supervised approval still
// happens against credentialsUrl, exactly as in standalone mode).
if (bootstrap) {
  connection = { id: bootstrap.connectionId, accountId: bootstrap.account.accountId, status: "active", app: APP };
  awsAccountId = bootstrap.account.accountId;
  credsProvider = makeProvider(bootstrap.connectionId);
}

export function isBrokerEnabled(): boolean {
  return enabled;
}

/**
 * True when an approved AgentsPoppy connection is the active credential source.
 * Readiness treats this as "environment ready" without probing AWS — AgentsPoppy
 * has already granted a known, scoped permission set, and the actual credential
 * mint (with its supervised approval) happens at deploy time, not form-enable time.
 */
export function brokerConnected(): boolean {
  return enabled && connection?.status === "active";
}

/** The AWS account number behind the active broker connection, if known. */
export function brokerAccountId(): string | undefined {
  return brokerConnected() ? awsAccountId ?? undefined : undefined;
}

/** True when the host spawned us as an in-container extension (vs standalone). */
export function isContainerMode(): boolean {
  return bootstrap !== null;
}

/** The AWS region the host resolved for this connection (container mode only). */
export function brokerRegion(): string | undefined {
  return bootstrap?.account.region;
}

/**
 * ARN of the account's AgentsPoppyBoundary policy, when the host confirmed it exists
 * (container mode, AgentsPoppy setup v3+). Deploys pass it as the stack's
 * `PermissionsBoundaryArn` parameter; absent means "preserve what's deployed".
 */
export function brokerBoundaryArn(): string | undefined {
  return bootstrap?.permissionsBoundaryArn;
}

/** The loopback port the host assigned this backend to listen on (container mode only). */
export function brokerPort(): number | undefined {
  return bootstrap?.port;
}

/** The host's private data folder for this poppy (container mode only) — see storage.ts. */
export function brokerDataDir(): string | undefined {
  return bootstrap?.dataDir;
}

/**
 * The stack-level tags to stamp on deploys, or null if not connected+active.
 * Ownership is the stable app tag (`agentspoppy:app`), so AgentsPoppy can still
 * attribute + tear this stack down after a connection supersede; the connection id
 * is kept only as an audit tag. CloudFormation propagates these to every taggable
 * resource in the stack (the user pool, its client, buckets, …).
 */
export function brokerStackTags(): { Key: string; Value: string }[] | null {
  if (!(connection && connection.status === "active")) return null;
  const tags = [
    { Key: APP_TAG_KEY, Value: APP.id },
    { Key: CONNECTION_TAG_KEY, Value: connection.id },
  ];
  if (awsAccountId) tags.push({ Key: ACCOUNT_TAG_KEY, Value: awsAccountId });
  return tags;
}

/**
 * The credential provider to use for AWS calls, or undefined when we should fall
 * back to the local profile. Only returns a provider once the connection is
 * `active` (approved) — a pending/paused/revoked connection can't mint.
 */
export function brokerCredentials(): AwsCredentialIdentityProvider | undefined {
  if (!(enabled && connection?.status === "active")) return undefined;
  // Arm the provider lazily so it can never lag behind "connected". Without this,
  // a connection observed as active via a path that didn't run beginBrokerConnect
  // (e.g. status re-sync after a restart) would leave credsProvider null →
  // readiness (brokerConnected) says ready, but AWS calls silently fall back to the
  // local profile and fail. Keyed off connection.id so it always matches.
  if (!credsProvider) credsProvider = makeProvider(connection.id);
  return credsProvider;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
function doFetch(path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<FetchResponse> {
  return fetchUrl(`${baseUrl}${path}`, init);
}

/** Fetch an ABSOLUTE url (used for the host-injected credentialsUrl in bootstrap mode). */
function fetchUrl(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<FetchResponse> {
  const f = (globalThis as { fetch?: (u: string, i?: unknown) => Promise<FetchResponse> }).fetch;
  if (!f) throw new Error("global fetch unavailable (Node 18+ required) for AgentsPoppy broker");
  return f(url, init);
}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await doFetch(path, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    let message = `AgentsPoppy broker returned ${res.status}`;
    try {
      const b = (await res.json()) as { message?: string; error?: string };
      if (b?.message) message = b.message;
    } catch {
      /* keep status-based message */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

function isScopedCredentials(v: unknown): v is ScopedCredentials {
  const c = v as Partial<ScopedCredentials> | null;
  return !!c && !!c.accessKeyId && !!c.secretAccessKey && !!c.sessionToken && !!c.expiration;
}

/** Poll interval while a supervised approval is pending (the user decides in AgentsPoppy). */
const APPROVAL_POLL_MS = 2000;

/**
 * Mint scoped credentials. For a normal connection this returns at once. For a
 * *supervised* connection the broker answers with `202 { approvalRequired, approval }`
 * — the user must approve the operation in the AgentsPoppy window — so we poll
 * (echoing the approval id) until it's approved (→ credentials) or denied (→ error).
 * That's how AgentsPoppy can require a human OK before MailPoppy changes anything.
 */
async function mintCredentials(connectionId: string): Promise<ScopedCredentials> {
  // In container (bootstrap) mode the host hands us the exact loopback mint endpoint;
  // standalone, we address the broker's own /connections/:id/credentials route.
  const url = bootstrap
    ? bootstrap.credentialsUrl
    : `${baseUrl}/connections/${encodeURIComponent(connectionId)}/credentials`;
  // The broker requires this backend's own credential token on the mint route (it's
  // scoped to THIS connection — see the AgentsPoppy broker's caller auth).
  const post = (body?: unknown) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (bootstrap?.credentialsToken) headers["authorization"] = `Bearer ${bootstrap.credentialsToken}`;
    return fetchUrl(url, {
      method: "POST",
      headers: Object.keys(headers).length ? headers : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  let res = await post();
  for (;;) {
    if (!res.ok) {
      let message = `AgentsPoppy broker returned ${res.status}`;
      try {
        const b = (await res.json()) as { message?: string };
        if (b?.message) message = b.message;
      } catch {
        /* keep status-based message */
      }
      // A pending approval has a 15-min TTL. If it lapses (or was already consumed)
      // while we're still mid-deploy — e.g. the user took a moment to walk over to
      // AgentsPoppy — that's NOT a failure: transparently re-request a fresh approval
      // (which re-notifies them) and keep waiting, instead of surfacing a bare "error".
      // A genuine denial still propagates so the user's "no" is honoured.
      if (/expired|already been used|request again/i.test(message)) {
        await new Promise((r) => setTimeout(r, APPROVAL_POLL_MS));
        res = await post();
        continue;
      }
      throw new Error(message);
    }
    const body = await res.json();
    if (isScopedCredentials(body)) return body;
    const approvalId = (body as { approval?: { id?: string } }).approval?.id;
    if (!approvalId) throw new Error("AgentsPoppy broker returned an unexpected credentials response");
    await new Promise((r) => setTimeout(r, APPROVAL_POLL_MS));
    res = await post({ approvalId });
  }
}

function makeProvider(connectionId: string): AwsCredentialIdentityProvider {
  let cached: ScopedCredentials | null = null;
  let inflight: Promise<ScopedCredentials> | null = null;
  const fresh = (c: ScopedCredentials): boolean => {
    const exp = Date.parse(c.expiration);
    return Number.isFinite(exp) && Date.now() < exp - REFRESH_BUFFER_MS;
  };
  const refresh = (): Promise<ScopedCredentials> => {
    if (!inflight) {
      inflight = mintCredentials(connectionId)
        .then((c) => {
          cached = c;
          return c;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
  return async () => {
    const c = cached && fresh(cached) ? cached : await refresh();
    return {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken,
      expiration: new Date(c.expiration),
    };
  };
}

export interface BrokerConnectResult {
  connectionId: string;
  status: ConnectionStatus;
  accountId: string;
  alias?: string;
}

/**
 * Request (or reuse) a MailPoppy connection on the local AgentsPoppy broker, and
 * arm the credential provider. Turning this on implies broker mode. The returned
 * connection is usually `pending` — the user approves it in the AgentsPoppy
 * window, then poll {@link refreshBrokerStatus} until it's `active`.
 */
export async function beginBrokerConnect(opts: { accountId?: string } = {}): Promise<BrokerConnectResult> {
  enabled = true;
  const accounts = await api<AccountDTO[]>("/accounts");
  if (accounts.length === 0) {
    throw new Error("AgentsPoppy has no AWS account linked yet — link one in AgentsPoppy first, then connect.");
  }
  const account = opts.accountId
    ? accounts.find((a) => a.id === opts.accountId || a.accountId === opts.accountId)
    : accounts[0];
  if (!account) throw new Error(`AgentsPoppy account "${opts.accountId}" not found`);

  const desired = permissionSet();
  const existing = (await api<ConnectionDTO[]>("/connections")).find(
    (c) => c.app?.id === APP.id && c.accountId === account.id && c.status !== "revoked",
  );
  // The broker stores a connection's scope at creation and never updates it, so a reused
  // connection keeps vending whatever it was first granted. If MailPoppy's declared scope
  // has since changed (e.g. a broker-grant fix shipped), reusing it would silently deploy
  // with the OLD permissions. Detect that drift and supersede the stale connection with a
  // fresh one — which the user re-approves, the correct behaviour for a scope change.
  const stale = !!existing && grantsSignature(existing.permissionSet?.grants) !== grantsSignature(desired.grants);
  if (existing && stale) {
    try {
      await api(`/connections/${encodeURIComponent(existing.id)}`, { method: "DELETE" }); // revoke
    } catch {
      /* best-effort; worst case the user revokes the old connection manually */
    }
  }
  connection =
    existing && !stale
      ? existing
      : await api<ConnectionDTO>("/connections", {
          method: "POST",
          body: { accountId: account.id, app: APP, permissionSet: desired },
        });
  credsProvider = makeProvider(connection.id);
  awsAccountId = account.accountId;
  return { connectionId: connection.id, status: connection.status, accountId: account.accountId, alias: account.alias };
}

export interface BrokerStatus {
  enabled: boolean;
  connected: boolean;
  connectionId?: string;
  status?: ConnectionStatus;
}

/** Re-read the connection's status from the broker (the UI polls this). */
export async function refreshBrokerStatus(): Promise<BrokerStatus> {
  if (!connection) return { enabled, connected: false };
  connection = await api<ConnectionDTO>(`/connections/${encodeURIComponent(connection.id)}`);
  return { enabled, connected: connection.status === "active", connectionId: connection.id, status: connection.status };
}

/** Forget the connection and stop using broker credentials (back to the profile). */
export function disconnectBroker(): void {
  // In container mode the host owns the connection lifecycle — there's no ~/.aws
  // profile to fall back to, so a stray standalone "disconnect" must be a no-op.
  if (bootstrap) return;
  connection = null;
  credsProvider = null;
  awsAccountId = null;
  enabled = /^(1|true|yes|on)$/i.test(process.env.MAILPOPPY_AGENTSPOPPY_BROKER ?? "");
}

/** Test seam: point the vendored client at a fake broker. */
export function __setBrokerBaseUrlForTests(url: string): void {
  baseUrl = url;
}
