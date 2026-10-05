// Every sandbox-only simulation call goes through this one interface so the
// demo can swap it out (or drop it) without touching card logic.
import type { AirwallexClient } from "./client.ts";
import type { SimulatedEvent } from "./issuing.ts";

export interface ChargeInput {
  cardId: string;
  amount: number;
  currency: string;
  mcc: string;
  merchant?: string;
}

export interface CardSimulator {
  /** Authorize and clear in one step (single_phase). */
  charge(input: ChargeInput): Promise<SimulatedEvent>;
  /** Authorize only; capture later. */
  authorize(input: ChargeInput): Promise<SimulatedEvent>;
  capture(lifecycleId: string, amount?: number): Promise<SimulatedEvent>;
  reverse(lifecycleId: string, amount?: number): Promise<SimulatedEvent>;
}

export class AirwallexSandboxSimulator implements CardSimulator {
  private awx: AirwallexClient;
  constructor(awx: AirwallexClient) { this.awx = awx; }

  charge(input: ChargeInput) { return this.create(input, true); }
  authorize(input: ChargeInput) { return this.create(input, false); }

  capture(lifecycleId: string, amount?: number) {
    return this.awx.post<SimulatedEvent>(
      `/simulation/issuing/card_transaction_lifecycles/${lifecycleId}/capture`,
      amount === undefined ? {} : { transaction_amount: amount },
    );
  }

  reverse(lifecycleId: string, amount?: number) {
    return this.awx.post<SimulatedEvent>(
      `/simulation/issuing/card_transaction_lifecycles/${lifecycleId}/reverse`,
      amount === undefined ? {} : { transaction_amount: amount },
    );
  }

  private create(input: ChargeInput, singlePhase: boolean) {
    return this.awx.post<SimulatedEvent>("/simulation/issuing/create", {
      card_id: input.cardId,
      transaction_amount: input.amount,
      transaction_currency: input.currency,
      merchant_category_code: input.mcc,
      merchant_info: input.merchant,
      single_phase: singlePhase,
    });
  }
}
