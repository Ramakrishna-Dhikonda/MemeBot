FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY apps/execution-service/package.json ./apps/execution-service/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json
COPY packages/solana-client/package.json ./packages/solana-client/package.json
COPY packages/transaction-builder/package.json ./packages/transaction-builder/package.json
COPY packages/wallet-manager/package.json ./packages/wallet-manager/package.json
RUN npm install --workspace @sqts/execution-service --workspace @sqts/shared-types --workspace @sqts/solana-client --workspace @sqts/transaction-builder --workspace @sqts/wallet-manager
COPY apps/execution-service ./apps/execution-service
COPY packages/shared-types ./packages/shared-types
COPY packages/solana-client ./packages/solana-client
COPY packages/transaction-builder ./packages/transaction-builder
COPY packages/wallet-manager ./packages/wallet-manager
COPY tsconfig.base.json ./tsconfig.base.json
WORKDIR /app/apps/execution-service
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/apps/execution-service/dist ./dist
COPY --from=build /app/apps/execution-service/package.json ./package.json
ENV NODE_ENV=production
EXPOSE 4004
CMD ["node", "dist/index.js"]
