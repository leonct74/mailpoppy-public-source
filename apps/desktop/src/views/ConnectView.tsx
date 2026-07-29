import { useState } from "react";
import type { DeploymentConfig } from "../lib/deploymentConfig";
import { Card, Button, cn } from "../ui";

// Enter the four CloudFormation Outputs of a deployed MailPoppy backend. The
// admin gets these from the Setup wizard's deploy step (or the AWS console).

const fieldCls =
  "w-full rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-3 py-2 font-mono text-sm text-on-surface placeholder:text-outline-variant focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30";
const labelCls = "mb-1 block text-sm text-on-surface-variant";

export function ConnectView({
  initial,
  onSave,
  onCancel,
}: {
  initial?: DeploymentConfig | null;
  onSave: (c: DeploymentConfig) => void;
  onCancel?: () => void;
}) {
  const [apiBaseUrl, setApiBaseUrl] = useState(initial?.apiBaseUrl ?? "");
  const [userPoolId, setUserPoolId] = useState(initial?.userPoolId ?? "");
  const [clientId, setClientId] = useState(initial?.clientId ?? "");
  const [region, setRegion] = useState(initial?.region ?? "eu-west-1");
  const [err, setErr] = useState<string | null>(null);

  function save() {
    if (!apiBaseUrl || !userPoolId || !clientId || !region) {
      setErr("All four values are required.");
      return;
    }
    onSave({ apiBaseUrl: apiBaseUrl.trim().replace(/\/$/, ""), userPoolId: userPoolId.trim(), clientId: clientId.trim(), region: region.trim() });
  }

  return (
    <Card className="max-w-xl">
      <h3 className="text-lg font-semibold text-on-surface">Connect to your deployment</h3>
      <p className="mt-1 text-sm text-on-surface-variant">Paste the outputs from your MailPoppy CloudFormation stack.</p>

      <div className="mt-4 flex flex-col gap-3">
        <div>
          <label className={labelCls}>API base URL (ApiBaseUrl)</label>
          <input className={fieldCls} value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="https://abc123.execute-api.eu-west-1.amazonaws.com" />
        </div>
        <div>
          <label className={labelCls}>User Pool ID (UserPoolId)</label>
          <input className={fieldCls} value={userPoolId} onChange={(e) => setUserPoolId(e.target.value)} placeholder="eu-west-1_xxxxxxxxx" />
        </div>
        <div>
          <label className={labelCls}>App client ID (UserPoolClientId)</label>
          <input className={fieldCls} value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxx" />
        </div>
        <div>
          <label className={labelCls}>Region (DeployRegion)</label>
          <input className={cn(fieldCls, "max-w-xs")} value={region} onChange={(e) => setRegion(e.target.value)} placeholder="eu-west-1" />
        </div>
      </div>

      {err && <p className="mt-2 text-sm text-tertiary">{err}</p>}
      <div className="mt-4 flex gap-2">
        <Button onClick={save}>Save &amp; continue</Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </Card>
  );
}
