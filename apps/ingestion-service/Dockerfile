FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ../../tsconfig.base.json ./
COPY apps/ingestion-service/package.json ./apps/ingestion-service/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json
RUN npm install --workspace @sqts/ingestion-service --workspace @sqts/shared-types
COPY apps/ingestion-service ./apps/ingestion-service
COPY packages/shared-types ./packages/shared-types
COPY tsconfig.base.json ./tsconfig.base.json
WORKDIR /app/apps/ingestion-service
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/apps/ingestion-service/dist ./dist
COPY --from=build /app/apps/ingestion-service/package.json ./package.json
ENV NODE_ENV=production
EXPOSE 4001
CMD ["node", "dist/index.js"]
