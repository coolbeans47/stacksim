# Terraform HTTP API and DynamoDB

This example uses the standard `hashicorp/aws` provider to provision a small
serverless application directly through StackSim's AWS-compatible APIs:

- an API Gateway HTTP API with `GET /notes` and `POST /notes` routes;
- a Node.js 22 Lambda proxy integration;
- a DynamoDB table using on-demand billing;
- a least-privilege Lambda execution role and policy; and
- a CloudWatch log group with bounded retention.

Terraform owns the dependency graph and local state. StackSim owns the
simulated AWS resources and their runtime behavior. This example does not use
CloudFormation or a real AWS account.

## Prerequisites

- Windows 10/11 or a currently supported macOS version;
- Node.js 22.13 or newer and npm;
- Terraform 1.6 or newer, but earlier than Terraform 2.0; and
- internet access during `npm ci` and the first `terraform init`.

Check Node.js before continuing:

```text
node --version
npm --version
```

## Install Terraform

HashiCorp's official installation and download page is
[Install Terraform](https://developer.hashicorp.com/terraform/install). Use a
current stable Terraform 1.x release that matches your processor architecture.

### Windows: official ZIP

1. On the official installation page, select **Windows** and download the
   `AMD64` ZIP for most Intel/AMD PCs, or `ARM64` for a Windows ARM PC.
2. Adjust `$terraformZip` below to the downloaded ZIP's actual filename.
3. Run the following in PowerShell. Administrator access is not required
   because this installs Terraform for the current user.

```powershell
$terraformZip = "$env:USERPROFILE\Downloads\terraform_VERSION_windows_amd64.zip"
$installDirectory = Join-Path $env:LOCALAPPDATA "Programs\Terraform"

New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
Expand-Archive -LiteralPath $terraformZip -DestinationPath $installDirectory -Force

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $installDirectory) {
  $newUserPath = (($userPath.TrimEnd(";") + ";" + $installDirectory).Trim(";"))
  [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
}

# Make Terraform available in this PowerShell session too.
$env:Path = "$env:Path;$installDirectory"
terraform version
```

Replace `VERSION` with the version in the downloaded filename. For ARM64,
also replace `amd64` with `arm64`. Open a new PowerShell window after
installation and verify it again:

```powershell
terraform version
Get-Command terraform
```

HashiCorp also publishes checksum and signature files. For machines where
download verification is required, follow its
[archive verification guide](https://developer.hashicorp.com/terraform/tutorials/cli/verify-archive)
before extracting the ZIP.

### macOS: Homebrew

HashiCorp maintains an official Homebrew tap. In Terminal, run:

```bash
brew tap hashicorp/tap
brew install hashicorp/tap/terraform
terraform version
command -v terraform
```

To upgrade a later installation:

```bash
brew update
brew upgrade hashicorp/tap/terraform
```

If Homebrew is unavailable, download the macOS `ARM64` ZIP for Apple silicon
or the `AMD64` ZIP for an Intel Mac from HashiCorp's official installation
page. Extract it and place the executable in a directory on `PATH`:

```bash
cd ~/Downloads
unzip terraform_VERSION_darwin_arm64.zip
sudo install -m 0755 terraform /usr/local/bin/terraform
terraform version
command -v terraform
```

Use `darwin_amd64` instead on an Intel Mac.

## Start StackSim

From the StackSim repository root, start StackSim and leave it running in this
terminal:

```text
npm start
```

## Configure Terraform for StackSim

These credentials are local placeholders. StackSim validates them locally and
does not send them to AWS.

Windows PowerShell:

```powershell
$env:AWS_ACCESS_KEY_ID = "admin"
$env:AWS_SECRET_ACCESS_KEY = "password"
$env:AWS_REGION = "eu-west-1"
$env:AWS_DEFAULT_REGION = "eu-west-1"
$env:AWS_ENDPOINT_URL = "http://127.0.0.1:4566"
$env:AWS_EC2_METADATA_DISABLED = "true"

Remove-Item Env:AWS_SESSION_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:AWS_PROFILE -ErrorAction SilentlyContinue
Remove-Item Env:AWS_IGNORE_CONFIGURED_ENDPOINT_URLS -ErrorAction SilentlyContinue
```

macOS bash or zsh:

```bash
export AWS_ACCESS_KEY_ID=admin
export AWS_SECRET_ACCESS_KEY=password
export AWS_REGION=eu-west-1
export AWS_DEFAULT_REGION=eu-west-1
export AWS_ENDPOINT_URL=http://127.0.0.1:4566
export AWS_EC2_METADATA_DISABLED=true
unset AWS_SESSION_TOKEN AWS_PROFILE AWS_IGNORE_CONFIGURED_ENDPOINT_URLS
```

The provider restricts the permitted account to StackSim's default
`000000000000` account. This safety guard makes the example fail if it is
accidentally pointed at a real AWS account.

## Initialize, plan, and deploy

The Terraform commands are the same in PowerShell and macOS Terminal. Run them
from the repository root:

```text
cd examples/terraform-api-dynamodb
terraform init
terraform fmt -check
terraform validate
terraform plan -out .terraform/example.tfplan
terraform apply .terraform/example.tfplan
```

The first `terraform init` downloads the AWS and Archive providers. A
successful apply creates 11 resources and prints the local API URL, DynamoDB
table name, and Lambda function name.

## Test the deployed application

The included smoke test creates a note through `POST /notes`, retrieves notes
through `GET /notes`, and confirms the created note is present.

Windows PowerShell:

```powershell
$apiUrl = terraform output -raw api_url
node scripts/smoke.mjs $apiUrl
```

macOS:

```bash
api_url="$(terraform output -raw api_url)"
node scripts/smoke.mjs "$api_url"
```

You can also call the API manually.

Windows PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri $apiUrl -ContentType "application/json" -Body '{"title":"Learn Terraform"}'
Invoke-RestMethod -Method Get -Uri $apiUrl
```

macOS:

```bash
curl --fail --request POST "$api_url" \
  --header 'content-type: application/json' \
  --data '{"title":"Learn Terraform"}'
curl --fail "$api_url"
```

Finally, confirm that a second Terraform plan has no drift:

```text
terraform plan -detailed-exitcode
```

For `-detailed-exitcode`, exit code `0` means no changes, `2` means Terraform
found changes, and `1` means an error occurred.

Windows PowerShell displays the last exit code with:

```powershell
$LASTEXITCODE
```

macOS displays it with:

```bash
echo $?
```

## Destroy the example

Remove every resource created by the example:

```text
terraform destroy
```

Review the destroy plan and enter `yes`. Keep StackSim running until Terraform
reports `Destroy complete`.

Terraform state can contain sensitive values in larger applications. The local
state and `.terraform` working directory are ignored by this example's
`.gitignore`; `.terraform.lock.hcl` should remain committed for repeatable
provider selection.

## Troubleshooting

- If `terraform` is not recognized, open a new terminal and check
  `Get-Command terraform` on Windows or `command -v terraform` on macOS.
- If Terraform reports a connection error for port `4566`, confirm that
  StackSim is still running and repeat the health check.
- If provider installation fails, confirm internet access and run
  `terraform init` again.
- If a previous run was interrupted, run `terraform plan` before applying so
  Terraform can reconcile its local state with StackSim.
