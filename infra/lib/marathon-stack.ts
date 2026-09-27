import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";

export interface MarathonStackProps extends cdk.StackProps {
  /** SSM path prefix for all parameters, e.g. /marathon */
  paramPrefix: string;
}

export class MarathonStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MarathonStackProps) {
    super(scope, id, props);
    const prefix = props.paramPrefix;

    // Private bucket; only CloudFront (via OAC) can read it. The page is rebuilt from git, so it's safe to delete.
    const site = new s3.Bucket(this, "Site", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const api = new nodejs.NodejsFunction(this, "Api", {
      entry: path.join(__dirname, "../lambda/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(20),
      environment: { PARAM_PREFIX: prefix },
      bundling: { externalModules: ["@aws-sdk/*"], minify: true, sourceMap: false },
      logGroup: new logs.LogGroup(this, "ApiLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // ARNs are built from the prefix string (not from Parameter constructs) so the function
    // doesn't depend on the distribution, which itself depends on the function URL.
    const paramArn = (name: string) =>
      cdk.Arn.format({ service: "ssm", resource: "parameter", resourceName: `${prefix.replace(/^\//, "")}/${name}` }, this);
    api.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameters"], resources: [paramArn("*")] }));
    api.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:PutParameter"],
        resources: [paramArn("strava/refresh_token"), paramArn("strava/athlete_id")],
      }),
    );

    // IAM-authenticated URL: only CloudFront, signing via OAC, can invoke it.
    const apiUrl = api.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    const distribution = new cloudfront.Distribution(this, "Cdn", {
      comment: "Tokyo lead-up",
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL, // Australian edge locations are only in "All"
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
      },
      additionalBehaviors: {
        "/api/*": {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(apiUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          // Responses depend on the session cookie, so CloudFront never caches them;
          // the Lambda keeps its own 5-minute cache of Strava results.
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Forward cookies and query strings, but not Host (the function URL needs its own).
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
      },
    });

    // Function URLs created since Oct 2025 need lambda:InvokeFunction as well as the
    // lambda:InvokeFunctionUrl grant that FunctionUrlOrigin adds.
    api.addPermission("InvokeFromCdn", {
      principal: new iam.ServicePrincipal("cloudfront.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: this.formatArn({
        service: "cloudfront",
        region: "",
        resource: "distribution",
        resourceName: distribution.distributionId,
      }),
      invokedViaFunctionUrl: true,
    });

    const publicUrl = `https://${distribution.distributionDomainName}`;
    new ssm.StringParameter(this, "PublicUrl", {
      parameterName: `${prefix}/public_url`,
      stringValue: publicUrl,
      description: "Public origin of the Tokyo lead-up page; used to build the Strava redirect_uri",
    });

    new cdk.CfnOutput(this, "SiteUrl", { value: publicUrl });
    new cdk.CfnOutput(this, "StravaCallbackDomain", { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, "BucketName", { value: site.bucketName });
    new cdk.CfnOutput(this, "DistributionId", { value: distribution.distributionId });
  }
}
