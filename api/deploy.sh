#!/bin/bash
# Deploy Provenance Layer API as Lambda + Function URL
set -e

FUNCTION_NAME="provenance-layer-api"
REGION="us-east-1"
ROLE_ARN="arn:aws:iam::234680850143:role/provenance-lambda-role"
BUCKET="provenance-layer-media-cb"

echo "📦 Packaging Lambda..."

# Create deployment package
DEPLOY_DIR=$(mktemp -d)
cp api/lambda-handler.js "$DEPLOY_DIR/index.mjs"
cp -r web "$DEPLOY_DIR/web"

# Create package.json for Lambda
cat > "$DEPLOY_DIR/package.json" << 'EOF'
{
  "type": "module",
  "dependencies": {
    "@aws-sdk/client-s3": "^3.0.0"
  }
}
EOF

cd "$DEPLOY_DIR"
npm install --production 2>/dev/null

# Zip everything
zip -r /tmp/provenance-api.zip . -x "*.git*" > /dev/null

echo "📦 Package size: $(du -h /tmp/provenance-api.zip | cut -f1)"
echo "🚀 Deploying to Lambda..."

cd -

node -e "
import { LambdaClient, CreateFunctionCommand, UpdateFunctionCodeCommand, GetFunctionCommand, CreateFunctionUrlConfigCommand, GetFunctionUrlConfigCommand, AddPermissionCommand, UpdateFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { readFileSync } from 'fs';

const lambda = new LambdaClient({ region: '$REGION' });
const zipFile = readFileSync('/tmp/provenance-api.zip');

async function deploy() {
  let functionExists = false;
  try {
    await lambda.send(new GetFunctionCommand({ FunctionName: '$FUNCTION_NAME' }));
    functionExists = true;
  } catch (e) {}

  if (functionExists) {
    console.log('Updating existing function...');
    await lambda.send(new UpdateFunctionCodeCommand({
      FunctionName: '$FUNCTION_NAME',
      ZipFile: zipFile,
    }));
    // Wait for update to complete
    await new Promise(r => setTimeout(r, 3000));
    await lambda.send(new UpdateFunctionConfigurationCommand({
      FunctionName: '$FUNCTION_NAME',
      Timeout: 30,
      MemorySize: 256,
      Environment: { Variables: { BUCKET: '$BUCKET', AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1' } },
    }));
  } else {
    console.log('Creating new function...');
    await lambda.send(new CreateFunctionCommand({
      FunctionName: '$FUNCTION_NAME',
      Runtime: 'nodejs22.x',
      Role: '$ROLE_ARN',
      Handler: 'index.handler',
      Code: { ZipFile: zipFile },
      Timeout: 30,
      MemorySize: 256,
      Environment: { Variables: { BUCKET: '$BUCKET', AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1' } },
      PackageType: 'Zip',
    }));
    console.log('Waiting for function to be active...');
    await new Promise(r => setTimeout(r, 5000));
  }

  // Create function URL if not exists
  let urlConfig;
  try {
    urlConfig = await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: '$FUNCTION_NAME' }));
    console.log('Function URL already exists');
  } catch (e) {
    console.log('Creating function URL...');
    urlConfig = await lambda.send(new CreateFunctionUrlConfigCommand({
      FunctionName: '$FUNCTION_NAME',
      AuthType: 'NONE',
      Cors: {
        AllowOrigins: ['*'],
        AllowMethods: ['GET', 'POST', 'OPTIONS'],
        AllowHeaders: ['content-type'],
      },
    }));

    // Add public invoke permission
    try {
      await lambda.send(new AddPermissionCommand({
        FunctionName: '$FUNCTION_NAME',
        StatementId: 'FunctionURLAllowPublicAccess',
        Action: 'lambda:InvokeFunctionUrl',
        Principal: '*',
        FunctionUrlAuthType: 'NONE',
      }));
    } catch (e) {
      if (!e.message?.includes('already exists')) throw e;
    }
  }

  console.log('');
  console.log('✅ Deployed!');
  console.log('🌐 URL:', urlConfig.FunctionUrl);
}

deploy().catch(e => { console.error('Deploy failed:', e); process.exit(1); });
"

# Cleanup
rm -rf "$DEPLOY_DIR" /tmp/provenance-api.zip
