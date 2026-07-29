import { App, DefaultStackSynthesizer } from "aws-cdk-lib";
import { MailStack } from "../lib/mail-stack";

// `cdk synth` produces the CloudFormation template that the desktop app ships and
// deploys into the customer's account via cloudformation:CreateStack/UpdateStack
// (so customers never need CDK installed). DESIGN §15.
//
// The stack is asset-free (Lambda code comes from S3 via CFN parameters), so we
// also turn off the bootstrap-version rule/parameter — the template must deploy
// into a brand-new account with no `cdk bootstrap`.
const app = new App();
new MailStack(app, "MailpoppyMailStack", {
  synthesizer: new DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
});
app.synth();
