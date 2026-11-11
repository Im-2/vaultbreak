# Backend for a container host (Render / Koyeb / Back4App / Fly ...): the NEAR testnet demo API.
# State lives in /app/.testnet-data and is restored from the encrypted off-site backup when the disk is empty.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY sdk/package.json sdk/
RUN npm install --no-audit --no-fund --workspace=@vaultbreak/server --workspace=@vaultbreak/sdk --include-workspace-root
COPY server server
COPY sdk sdk
COPY scripts scripts
COPY guardians guardians
ENV PORT=8787 NODE_ENV=production
EXPOSE 8787
CMD ["node", "--import", "tsx", "scripts/testnet-stack.ts"]
