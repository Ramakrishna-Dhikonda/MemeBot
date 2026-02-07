FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ../../tsconfig.base.json ./
COPY apps/backtesting-engine/package.json ./apps/backtesting-engine/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json
RUN npm install --workspace @sqts/backtesting-engine --workspace @sqts/shared-types
COPY apps/backtesting-engine ./apps/backtesting-engine
COPY packages/shared-types ./packages/shared-types
COPY tsconfig.base.json ./tsconfig.base.json
WORKDIR /app/apps/backtesting-engine
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/apps/backtesting-engine/dist ./dist
COPY --from=build /app/apps/backtesting-engine/package.json ./package.json
ENV NODE_ENV=production
EXPOSE 4010
CMD ["node", "dist/index.js"]
