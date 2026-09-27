#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { MarathonStack } from "../lib/marathon-stack";

const app = new cdk.App();
new MarathonStack(app, "MarathonStack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ap-southeast-2" },
  paramPrefix: app.node.tryGetContext("paramPrefix") ?? "/marathon",
});
