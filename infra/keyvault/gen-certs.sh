#!/bin/sh
# Generates a local CA and a TLS certificate for the Key Vault emulator (host name "keyvault") once.
# Output (shared volume /certs): ca.pem (trusted by consumers via NODE_EXTRA_CA_CERTS),
# keyvault.p12 (keystore for Lowkey Vault, password in keyvault.pass).
set -eu
cd /certs
if [ -f keyvault.p12 ] && [ -f ca.pem ]; then
  echo "certificates exist"; exit 0
fi
apk add --no-cache openssl >/dev/null
PASS=$(openssl rand -hex 16)
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=coworking local CA" -keyout ca.key -out ca.pem
cat > san.cnf <<EOF
subjectAltName=DNS:keyvault,DNS:localhost,IP:127.0.0.1
extendedKeyUsage=serverAuth
EOF
openssl req -newkey rsa:2048 -nodes -subj "/CN=keyvault" -keyout keyvault.key -out keyvault.csr
openssl x509 -req -in keyvault.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 825 -extfile san.cnf -out keyvault.pem
openssl pkcs12 -export -in keyvault.pem -inkey keyvault.key -certfile ca.pem -name lowkey-vault -passout pass:"$PASS" -out keyvault.p12
printf '%s' "$PASS" > keyvault.pass
rm -f ca.key keyvault.key keyvault.csr san.cnf ca.srl
chmod 644 ca.pem keyvault.p12 keyvault.pass
echo "certificates created"
