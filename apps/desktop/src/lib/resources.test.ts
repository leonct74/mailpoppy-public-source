import { describe, it, expect } from "vitest";
import { serviceFor, awsConsoleUrl, groupByService, type ResourceEntry } from "./resources";

describe("serviceFor", () => {
  it("maps known namespaces to friendly names", () => {
    expect(serviceFor("AWS::Lambda::Function")).toBe("Lambda");
    expect(serviceFor("AWS::ApiGatewayV2::Api")).toBe("API Gateway");
    expect(serviceFor("AWS::Events::Rule")).toBe("EventBridge");
    expect(serviceFor("AWS::DynamoDB::Table")).toBe("DynamoDB");
  });
  it("passes unknown namespaces through", () => {
    expect(serviceFor("AWS::Kinesis::Stream")).toBe("Kinesis");
  });
});

describe("awsConsoleUrl", () => {
  it("builds region-aware deep links for common types", () => {
    expect(awsConsoleUrl("AWS::S3::Bucket", "my-bucket", "eu-west-1")).toContain("/s3/buckets/my-bucket");
    expect(awsConsoleUrl("AWS::Lambda::Function", "fn", "eu-west-1")).toBe(
      "https://eu-west-1.console.aws.amazon.com/lambda/home?region=eu-west-1#/functions/fn",
    );
    expect(awsConsoleUrl("AWS::DynamoDB::Table", "T", "us-east-1")).toContain("table?name=T");
  });
  it("returns undefined for unknown types or missing id", () => {
    expect(awsConsoleUrl("AWS::Kinesis::Stream", "s", "eu-west-1")).toBeUndefined();
    expect(awsConsoleUrl("AWS::S3::Bucket", "", "eu-west-1")).toBeUndefined();
  });
});

describe("groupByService", () => {
  it("groups resources by friendly service, sorted", () => {
    const resources: ResourceEntry[] = [
      { logicalId: "Fn", physicalId: "fn", type: "AWS::Lambda::Function", status: "CREATE_COMPLETE" },
      { logicalId: "Tbl", physicalId: "t", type: "AWS::DynamoDB::Table", status: "CREATE_COMPLETE" },
      { logicalId: "Fn2", physicalId: "fn2", type: "AWS::Lambda::Function", status: "CREATE_COMPLETE" },
    ];
    const grouped = groupByService(resources);
    expect(grouped.map((g) => g.service)).toEqual(["DynamoDB", "Lambda"]);
    expect(grouped.find((g) => g.service === "Lambda")?.items).toHaveLength(2);
  });
});
