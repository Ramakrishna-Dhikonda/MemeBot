FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ../../tsconfig.base.json ./
COPY apps/strategy-service/package.json ./apps/strategy-service/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json
RUN npm install --workspace @sqts/strategy-service --workspace @sqts/shared-types
COPY apps/strategy-service ./apps/strategy-service
COPY packages/shared-types ./packages/shared-types
COPY tsconfig.base.json ./tsconfig.base.json
WORKDIR /app/apps/strategy-service
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/apps/strategy-service/dist ./dist
COPY --from=build /app/apps/strategy-service/package.json ./package.json
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
