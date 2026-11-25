#!/bin/sh
# Inicialização do storage, executada pelo serviço de execução única `storage-init` do Compose.
# Cria o bucket privado `S3_BUCKET`, sem política anônima, e a credencial da aplicação
# restrita a ele, com política mínima (phase-03-videos/TD-06). Pode rodar de novo sem efeito colateral.
set -eu

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER não definido}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD não definido}"
: "${S3_BUCKET:?S3_BUCKET não definido}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID não definido}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY não definido}"

ALIAS=storage
APP_POLICY="${S3_BUCKET}-app"
POLICY_FILE=/tmp/app-policy.json

# Host pelo nome do serviço do Compose, nunca localhost.
mc alias set "$ALIAS" http://storage:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null

mc mb --ignore-existing "$ALIAS/$S3_BUCKET"
mc anonymous set private "$ALIAS/$S3_BUCKET"

# Multipart (Create, UploadPart e Complete) é coberto por s3:PutObject; HeadObject, por s3:GetObject.
cat >"$POLICY_FILE" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": ["arn:aws:s3:::${S3_BUCKET}"]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": ["arn:aws:s3:::${S3_BUCKET}/*"]
    }
  ]
}
EOF

mc admin user add "$ALIAS" "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY"
mc admin policy create "$ALIAS" "$APP_POLICY" "$POLICY_FILE"

# O Silo aceita repetir o vínculo de uma política já vinculada, com código 0.
mc admin policy attach "$ALIAS" "$APP_POLICY" \
  --user "$S3_ACCESS_KEY_ID"

echo "storage-init: bucket '$S3_BUCKET' privado e credencial da aplicação com a política '$APP_POLICY'."
