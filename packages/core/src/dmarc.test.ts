import { describe, it, expect } from "vitest";
import {
  parseDmarcAggregate,
  summarizeAggregate,
  dmarcRowPasses,
  dmarcAttachmentKind,
  dmarcHealth,
  type DomainDmarc,
} from "./dmarc";

// A Google-shaped report: XML prolog, two records (one fully aligned, one
// SPF-only pass), CDATA-free, lots of whitespace.
const GOOGLE = `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>10515055889071234</report_id>
    <date_range>
      <begin>1612224000</begin>
      <end>1612310400</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>boxord.com</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>none</p>
    <sp>none</sp>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>209.85.220.41</source_ip>
      <count>7</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>boxord.com</header_from>
    </identifiers>
    <auth_results>
      <dkim><domain>boxord.com</domain><result>pass</result></dkim>
      <spf><domain>mail.boxord.com</domain><result>pass</result></spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>198.51.100.9</source_ip>
      <count>3</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>fail</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>boxord.com</header_from>
    </identifiers>
  </record>
</feedback>`;

// A report where mail is failing BOTH pillars (possible spoofing/misconfig),
// with a namespaced root + CDATA org name.
const SPOOFED = `<feedback xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <report_metadata>
    <org_name><![CDATA[Yahoo! Inc.]]></org_name>
    <report_id>abc-987</report_id>
    <date_range><begin>1700000000</begin><end>1700086400</end></date_range>
  </report_metadata>
  <policy_published><domain>EvilSpoof.com</domain><p>none</p></policy_published>
  <record>
    <row>
      <source_ip>185.10.10.10</source_ip>
      <count>40</count>
      <policy_evaluated><disposition>none</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated>
    </row>
    <identifiers><header_from>evilspoof.com</header_from></identifiers>
  </record>
</feedback>`;

describe("parseDmarcAggregate", () => {
  it("returns null for non-DMARC XML/text", () => {
    expect(parseDmarcAggregate("")).toBeNull();
    expect(parseDmarcAggregate("<html><body>hi</body></html>")).toBeNull();
    expect(parseDmarcAggregate("just a plain text email")).toBeNull();
  });

  it("extracts metadata, policy domain and every record row", () => {
    const r = parseDmarcAggregate(GOOGLE)!;
    expect(r).not.toBeNull();
    expect(r.orgName).toBe("google.com");
    expect(r.reportId).toBe("10515055889071234");
    expect(r.domain).toBe("boxord.com");
    expect(r.begin).toBe(1612224000);
    expect(r.end).toBe(1612310400);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ sourceIp: "209.85.220.41", count: 7, dkim: "pass", spf: "pass" });
    expect(r.rows[1]).toMatchObject({ count: 3, dkim: "fail", spf: "pass", headerFrom: "boxord.com" });
  });

  it("scopes leaf reads to their block (policy domain, not auth_results domain)", () => {
    // boxord.com appears in policy_published AND inside auth_results dkim/spf —
    // the parser must read the policy_published one, not a nested auth domain.
    const r = parseDmarcAggregate(GOOGLE)!;
    expect(r.domain).toBe("boxord.com");
  });

  it("tolerates a namespaced root and CDATA, lower-cases the domain", () => {
    const r = parseDmarcAggregate(SPOOFED)!;
    expect(r.orgName).toBe("Yahoo! Inc.");
    expect(r.domain).toBe("evilspoof.com");
    expect(r.rows[0]).toMatchObject({ count: 40, dkim: "fail", spf: "fail" });
  });

  it("falls back to header_from when policy_published has no domain", () => {
    const xml = `<feedback><report_metadata><org_name>x</org_name></report_metadata>
      <record><row><count>2</count><policy_evaluated><dkim>pass</dkim><spf>fail</spf></policy_evaluated></row>
      <identifiers><header_from>Fallback.NET</header_from></identifiers></record></feedback>`;
    expect(parseDmarcAggregate(xml)!.domain).toBe("fallback.net");
  });
});

describe("dmarcRowPasses", () => {
  it("passes when either SPF or DKIM is aligned-pass", () => {
    expect(dmarcRowPasses({ count: 1, dkim: "pass", spf: "fail" })).toBe(true);
    expect(dmarcRowPasses({ count: 1, dkim: "fail", spf: "pass" })).toBe(true);
    expect(dmarcRowPasses({ count: 1, dkim: "pass", spf: "pass" })).toBe(true);
  });
  it("fails when neither is an explicit pass", () => {
    expect(dmarcRowPasses({ count: 1, dkim: "fail", spf: "fail" })).toBe(false);
    expect(dmarcRowPasses({ count: 1 })).toBe(false);
    expect(dmarcRowPasses({ count: 1, dkim: "none", spf: "softfail" })).toBe(false);
  });
});

describe("summarizeAggregate", () => {
  it("sums message volume and DMARC passes weighted by count", () => {
    const s = summarizeAggregate(parseDmarcAggregate(GOOGLE)!);
    // row1: 7 pass, row2: 3 pass (spf aligned) → all 10 pass
    expect(s).toEqual({ domain: "boxord.com", volume: 10, pass: 10, fail: 0 });
  });
  it("counts a both-fail report entirely as failures", () => {
    const s = summarizeAggregate(parseDmarcAggregate(SPOOFED)!);
    expect(s).toEqual({ domain: "evilspoof.com", volume: 40, pass: 0, fail: 40 });
  });
  it("handles a report with no records", () => {
    const r = parseDmarcAggregate(`<feedback><policy_published><domain>a.com</domain></policy_published></feedback>`)!;
    expect(summarizeAggregate(r)).toEqual({ domain: "a.com", volume: 0, pass: 0, fail: 0 });
  });
});

describe("dmarcAttachmentKind", () => {
  it("detects gzip (incl. .xml.gz and content type) before zip", () => {
    expect(dmarcAttachmentKind("boxord.com!163.xml.gz", "application/gzip")).toBe("gzip");
    expect(dmarcAttachmentKind("report.gz", "application/octet-stream")).toBe("gzip");
    expect(dmarcAttachmentKind("r", "application/x-gzip")).toBe("gzip");
  });
  it("detects zip", () => {
    expect(dmarcAttachmentKind("google.com!boxord.com!1.zip", "application/zip")).toBe("zip");
    expect(dmarcAttachmentKind("r.zip", "application/x-zip-compressed")).toBe("zip");
  });
  it("detects plain xml", () => {
    expect(dmarcAttachmentKind("report.xml", "text/xml")).toBe("xml");
    expect(dmarcAttachmentKind("r", "application/xml")).toBe("xml");
  });
  it("returns null for ordinary attachments", () => {
    expect(dmarcAttachmentKind("invoice.pdf", "application/pdf")).toBeNull();
    expect(dmarcAttachmentKind("photo.png", "image/png")).toBeNull();
    expect(dmarcAttachmentKind(undefined, undefined)).toBeNull();
  });
});

describe("dmarcHealth", () => {
  const d = (p: Partial<DomainDmarc>): DomainDmarc => ({
    reports: 1,
    volume: 100,
    pass: 100,
    fail: 0,
    failRate: 0,
    windowDays: 14,
    ...p,
  });
  it("is good with no/low data", () => {
    expect(dmarcHealth(null)).toBe("good");
    expect(dmarcHealth(d({ volume: 5, fail: 5, failRate: 1 }))).toBe("good"); // below volume floor
    expect(dmarcHealth(d({ failRate: 0 }))).toBe("good");
  });
  it("watches a moderate fail rate", () => {
    expect(dmarcHealth(d({ failRate: 0.05 }))).toBe("watch");
    expect(dmarcHealth(d({ failRate: 0.19 }))).toBe("watch");
  });
  it("flags a high fail rate", () => {
    expect(dmarcHealth(d({ failRate: 0.2 }))).toBe("action");
    expect(dmarcHealth(d({ failRate: 0.8 }))).toBe("action");
  });
});
