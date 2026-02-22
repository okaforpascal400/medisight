#!/bin/bash
set -e

PROJECT_ID="medisight-pascal"
REGION="us-central1"
SERVICE_NAME="medisight"

echo "🚀 Deploying MediSight to Google Cloud Run..."

gcloud config set project $PROJECT_ID

gcloud run deploy $SERVICE_NAME \
  --source ./backend \
  --region $REGION \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=$GEMINI_API_KEY \
  --memory 2Gi \
  --port 8080

echo "✅ MediSight deployed successfully!"
gcloud run services describe $SERVICE_NAME --region $REGION --format 'value(status.url)'