FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY apps/portfolio-service/package.json ./apps/portfolio-service/package.json
RUN npm install --workspace @sqts/portfolio-service
COPY apps/portfolio-service ./apps/portfolio-service
COPY tsconfig.base.json ./tsconfig.base.json
WORKDIR /app/apps/portfolio-service
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/apps/portfolio-service/dist ./dist
COPY --from=build /app/apps/portfolio-service/package.json ./package.json
ENV NODE_ENV=production
EXPOSE 4005
CMD ["node", "dist/index.js"]
