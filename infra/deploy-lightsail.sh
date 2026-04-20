#!/usr/bin/env bash
# Deploy ETDP to AWS Lightsail instance with Docker Compose
# Minimal cost: $20/mo (2 GB RAM, 1 vCPU) or $40/mo (4 GB, 2 vCPU recommended)
#
# Prerequisites:
#   - AWS CLI configured with credentials (aws configure)
#   - SSH key pair created in Lightsail console or via CLI
#
# Usage:
#   chmod +x infra/deploy-lightsail.sh
#   ./infra/deploy-lightsail.sh [--plan 2gb|4gb] [--region us-east-1] [--name etdp]

set -euo pipefail

# --- Config ---
PLAN="${PLAN:-4gb}"            # nano_3_0=$5(512MB) micro_3_0=$10(1GB) small_3_0=$20(2GB) medium_3_0=$40(4GB)
REGION="${REGION:-ap-south-1}" # Mumbai (closest to India)
INSTANCE_NAME="${INSTANCE_NAME:-etdp-server}"
REPO_URL="https://github.com/pavan-kratikal-com/Test.git"
BRANCH="claude/create-email-security-ojf3Y"
KEY_PAIR_NAME="${KEY_PAIR_NAME:-etdp-key2}"

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --plan) PLAN="$2"; shift 2;;
    --region) REGION="$2"; shift 2;;
    --name) INSTANCE_NAME="$2"; shift 2;;
    --key) KEY_PAIR_NAME="$2"; shift 2;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

# Map friendly plan names to Lightsail bundle IDs
case "$PLAN" in
  1gb|micro)  BUNDLE_ID="micro_3_1";;
  2gb|small)  BUNDLE_ID="small_3_1";;
  4gb|medium) BUNDLE_ID="medium_3_1";;
  8gb|large)  BUNDLE_ID="large_3_1";;
  *)          BUNDLE_ID="$PLAN";;
esac

echo "=== ETDP Lightsail Deployment ==="
echo "Instance: $INSTANCE_NAME"
echo "Plan:     $BUNDLE_ID ($PLAN)"
echo "Region:   $REGION"
echo ""

# --- User-data script (runs on first boot) ---
USER_DATA=$(cat <<'USERDATA'
#!/bin/bash
set -ex

# Install Docker + Docker Compose
yum update -y
yum install -y docker git
systemctl enable docker && systemctl start docker
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Clone repo
cd /opt
git clone -b BRANCH_PLACEHOLDER REPO_PLACEHOLDER etdp
cd etdp

# Create .env for secrets (edit these after deploy)
cat > infra/.env <<'ENV'
RSPAMD_PASSWORD=etdp
SLM_ENABLED=1
SLM_BASE_URL=http://e10_classifier:7070/v1
SLM_API_KEY=
SLM_MODEL=email-classifier-v1
SLM_MODE=classifier
SLM_TIMEOUT=30000
JWT_SECRET=change-me-in-production
ENV

# Build and start
cd infra
docker-compose --env-file .env up -d --build

# Enable auto-restart on reboot
cat > /etc/systemd/system/etdp.service <<'SVC'
[Unit]
Description=ETDP Email Security
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/etdp/infra
ExecStart=/usr/local/bin/docker-compose --env-file .env up -d
ExecStop=/usr/local/bin/docker-compose down

[Install]
WantedBy=multi-user.target
SVC
systemctl enable etdp.service

echo "ETDP deployment complete!"
USERDATA
)

# Replace placeholders
USER_DATA="${USER_DATA//BRANCH_PLACEHOLDER/$BRANCH}"
USER_DATA="${USER_DATA//REPO_PLACEHOLDER/$REPO_URL}"

# --- Check if instance exists ---
if aws lightsail get-instance --instance-name "$INSTANCE_NAME" --region "$REGION" 2>/dev/null; then
  echo "Instance '$INSTANCE_NAME' already exists."
  echo "To redeploy, SSH in and run: cd /opt/etdp && git pull && cd infra && docker-compose up -d --build"

  IP=$(aws lightsail get-instance --instance-name "$INSTANCE_NAME" --region "$REGION" \
    --query 'instance.publicIpAddress' --output text)
  echo ""
  echo "Public IP: $IP"
  echo "Dashboard: http://$IP:8000"
  echo "SMTP:      $IP:2525"
  exit 0
fi

# --- Create key pair if needed ---
if ! aws lightsail get-key-pair --key-pair-name "$KEY_PAIR_NAME" --region "$REGION" 2>/dev/null; then
  echo "Creating SSH key pair: $KEY_PAIR_NAME"
  aws lightsail create-key-pair --key-pair-name "$KEY_PAIR_NAME" --region "$REGION" \
    --query 'privateKeyBase64' --output text > ~/.ssh/${KEY_PAIR_NAME}.pem
  chmod 600 ~/.ssh/${KEY_PAIR_NAME}.pem
  echo "Private key saved to ~/.ssh/${KEY_PAIR_NAME}.pem"
fi

# --- Create instance ---
echo "Creating Lightsail instance..."
aws lightsail create-instances \
  --instance-name "$INSTANCE_NAME" \
  --availability-zone "${REGION}a" \
  --blueprint-id "amazon_linux_2023" \
  --bundle-id "$BUNDLE_ID" \
  --key-pair-name "$KEY_PAIR_NAME" \
  --user-data "$USER_DATA" \
  --region "$REGION"

echo "Waiting for instance to be running..."
# Wait for instance to be running
for i in $(seq 1 20); do
  STATE=$(aws lightsail get-instance --instance-name "$INSTANCE_NAME" --region "$REGION" \
    --query 'instance.state.name' --output text 2>/dev/null || echo "pending")
  [ "$STATE" = "running" ] && break
  echo "  Status: $STATE (waiting...)"
  sleep 10
done

# --- Allocate static IP ---
STATIC_IP_NAME="${INSTANCE_NAME}-ip"
echo "Allocating static IP..."
aws lightsail allocate-static-ip --static-ip-name "$STATIC_IP_NAME" --region "$REGION" 2>/dev/null || true
aws lightsail attach-static-ip --static-ip-name "$STATIC_IP_NAME" --instance-name "$INSTANCE_NAME" --region "$REGION"

IP=$(aws lightsail get-static-ip --static-ip-name "$STATIC_IP_NAME" --region "$REGION" \
  --query 'staticIp.ipAddress' --output text)

# --- Open firewall ports ---
echo "Opening firewall ports (8000, 2525)..."
aws lightsail open-instance-public-ports --region "$REGION" \
  --instance-name "$INSTANCE_NAME" \
  --port-info fromPort=8000,toPort=8000,protocol=tcp

aws lightsail open-instance-public-ports --region "$REGION" \
  --instance-name "$INSTANCE_NAME" \
  --port-info fromPort=2525,toPort=2525,protocol=tcp

# Keep SSH open
aws lightsail open-instance-public-ports --region "$REGION" \
  --instance-name "$INSTANCE_NAME" \
  --port-info fromPort=22,toPort=22,protocol=tcp

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Instance:  $INSTANCE_NAME"
echo "Public IP: $IP"
echo "Plan:      $BUNDLE_ID (~\$$(echo "$PLAN" | sed 's/1gb/10/;s/2gb/20/;s/4gb/40/;s/8gb/80/')/mo)"
echo "Region:    $REGION"
echo ""
echo "Dashboard: http://$IP:8000"
echo "SMTP:      $IP:2525"
echo "SSH:       ssh -i ~/.ssh/${KEY_PAIR_NAME}.pem ec2-user@$IP"
echo ""
echo "NOTE: First boot takes ~5 minutes to install Docker and build containers."
echo "Monitor progress: ssh in and run 'tail -f /var/log/cloud-init-output.log'"
echo ""
echo "After deploy, update secrets:"
echo "  ssh -i ~/.ssh/${KEY_PAIR_NAME}.pem ec2-user@$IP"
echo "  sudo vi /opt/etdp/infra/.env"
echo "  cd /opt/etdp/infra && sudo docker-compose up -d"
