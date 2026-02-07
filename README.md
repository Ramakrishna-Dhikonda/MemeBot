# Solana Quant Trading System

Production-grade, microservice-based Solana automated trading system. Phase 1 scaffolding includes core packages for shared types, Solana RPC client, wallet management, and transaction building.

## Workspace

- `apps/`: microservices (to be built in subsequent phases)
- `packages/`: shared libraries used by services
- `infra/`: docker, terraform, and k8s assets

## Phase 1 Packages

- `@sqts/shared-types`
- `@sqts/solana-client`
- `@sqts/wallet-manager`
- `@sqts/transaction-builder`

## Scripts

```bash
npm run build
npm run test
```
