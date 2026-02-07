export type EventTopic =
  | "new_token_events"
  | "liquidity_events"
  | "whale_events"
  | "trade_signals"
  | "risk_approved_orders"
  | "risk_dead_letter"
  | "execution_results"
  | "portfolio_updates";

export interface BaseEvent {
  id: string;
  topic: EventTopic;
  timestamp: string;
}

export interface NewTokenEvent extends BaseEvent {
  topic: "new_token_events";
  mintAddress: string;
  creator: string;
  metadataUri?: string;
}

export interface LiquidityEvent extends BaseEvent {
  topic: "liquidity_events";
  mintAddress: string;
  poolAddress: string;
  liquidityUsd: number;
}

export interface WhaleEvent extends BaseEvent {
  topic: "whale_events";
  walletAddress: string;
  mintAddress: string;
  amountUsd: number;
}

export type IngestionEvent = NewTokenEvent | LiquidityEvent | WhaleEvent;

export type StrategyType = "sniper" | "momentum_breakout";

export interface TradeSignal extends BaseEvent {
  topic: "trade_signals";
  strategy: StrategyType;
  mintAddress: string;
  side: "buy" | "sell";
  confidence: number;
  expectedSlippageBps: number;
  sizeUsd?: number;
}

export interface RiskApprovedOrder extends BaseEvent {
  topic: "risk_approved_orders";
  signalId: string;
  mintAddress: string;
  side: "buy" | "sell";
  sizeUsd: number;
  maxSlippageBps: number;
}

export interface RiskRejectedSignal extends BaseEvent {
  topic: "risk_dead_letter";
  signalId: string;
  mintAddress: string;
  reason: string;
}

export interface ExecutionResult extends BaseEvent {
  topic: "execution_results";
  orderId: string;
  signature: string;
  status: "filled" | "failed";
  filledSizeUsd?: number;
  error?: string;
}

export interface PortfolioUpdate extends BaseEvent {
  topic: "portfolio_updates";
  mintAddress: string;
  positionSize: number;
  avgEntryPriceUsd: number;
  realizedPnlUsd?: number;
  unrealizedPnlUsd?: number;
}

export type EventPayload =
  | IngestionEvent
  | TradeSignal
  | RiskApprovedOrder
  | RiskRejectedSignal
  | ExecutionResult
  | PortfolioUpdate;
