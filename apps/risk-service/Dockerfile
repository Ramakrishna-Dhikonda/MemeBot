FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY apps/risk-service/package.json ./apps/risk-service/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json
RUN npm install --workspace @sqts/risk-service --workspace @sqts/shared-types
COPY apps/risk-service ./apps/risk-service
COPY packages/shared-types ./packages/shared-types
COPY tsconfig.base.json ./tsconfig.base.json
WORKDIR /app/apps/risk-service
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/apps/risk-service/dist ./dist
COPY --from=build /app/apps/risk-service/package.json ./package.json
ENV NODE_ENV=production
EXPOSE 4003
CMD ["node", "dist/index.js"]
