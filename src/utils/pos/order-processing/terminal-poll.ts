/**
 * Status polling for a POS terminal charge (plugin @voolulabs/medusajs-plugin-pos-payments).
 *
 * The plugin is the single authority on a charge's state (its webhook only brings the
 * state forward), so the till polls `GET /admin/pos-payments/charges/:id` until a
 * terminal state. Windows mirror the plugin's `POLL_WINDOW` (10s typical / 40s cap):
 * once the cap is exceeded the charge is STILL standing — a timeout is never a failure,
 * the payment can still complete and the backend reconciles it on its own.
 */

/** Plugin contract: enum in medusa-plugin-pos-payments adapters/types.ts (ChargeState). */
export type TerminalChargeState =
  | "pending"
  | "awaiting_terminal"
  | "action_required"
  | "paid"
  | "failed"
  | "expired"
  | "canceled"
  | "refunded";

export type TerminalChargeView = {
  state: TerminalChargeState;
  rawStatus?: string;
  /** Raw adquirente code (ex. "rejected_by_issuer") — locale-stable for UI. */
  reasonCode?: string;
  reason?: string;
};

/** Mirror of the plugin's POLL_WINDOW — keep both in step when it moves. */
export const TERMINAL_POLL_WINDOW = {
  typicalSeconds: 10,
  maxSeconds: 40,
} as const;

/** Cadence: fast while the typical transition window runs, then slower. */
export const cadenceMs = (
  secondsElapsed: number,
  typicalSeconds: number = TERMINAL_POLL_WINDOW.typicalSeconds
): number => (secondsElapsed < typicalSeconds ? 2000 : 5000);

export class TerminalPaymentDeclinedError extends Error {
  readonly state: TerminalChargeState;
  readonly chargeReason?: string;
  /** Stable adquirente code — the UI interpolates THIS, not the pt-BR copy. */
  readonly reasonCode?: string;

  constructor(state: TerminalChargeState, chargeReason?: string, reasonCode?: string) {
    super(`Terminal charge did not settle: ${state}${chargeReason ? ` (${chargeReason})` : ""}`);
    this.name = "TerminalPaymentDeclinedError";
    this.state = state;
    this.chargeReason = chargeReason;
    this.reasonCode = reasonCode;
  }
}

/** 40s without a terminal state — the charge is still live at the adquirente. */
export class TerminalChargeTimeoutError extends Error {
  constructor() {
    super("Terminal charge did not report a terminal state before the poll window closed");
    this.name = "TerminalChargeTimeoutError";
  }
}

const SETTLE_STATES: ReadonlySet<TerminalChargeState> = new Set([
  "paid",
  "failed",
  "expired",
  "canceled",
  "refunded",
]);

export const isSettledTerminalState = (state: TerminalChargeState): boolean =>
  SETTLE_STATES.has(state);

/**
 * The plugin writes the authoritative charge id into the payment session's data
 * blob (data_version payload). Terminal providers are only those that do — the
 * manual provider leaves no charge_id behind, so a null here means "not a
 * terminal flow" and callers skip polling entirely.
 */
export const findTerminalChargeId = (
  paymentSession?: { data?: unknown } | null
): string | null => {
  const data = paymentSession?.data;
  if (!data || typeof data !== "object") return null;
  const chargeId = (data as Record<string, unknown>).charge_id;
  return typeof chargeId === "string" && chargeId.length > 0 ? chargeId : null;
};

export interface PollTerminalChargeParams {
  chargeId: string;
  getCharge: (chargeId: string) => Promise<TerminalChargeView>;
  /** Live UI feedback between fetches ("check the terminal" state in the dialog). */
  onUpdate?: (view: TerminalChargeView) => void;
  sleep?: (ms: number) => Promise<void>;
  typicalSeconds?: number;
  maxSeconds?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Polls the charge until a terminal state or the window closes. Resolves with the
 * final view (state === "paid") or rejects:
 * - TerminalPaymentDeclinedError — settled NOT-paid states (include the stale pending
 *   session only for failed/expired/canceled; safe to delete);
 * - TerminalChargeTimeoutError — window closed, charge still standing; the caller must
 *   leave the session and the order intact (webhook/provider reconciliation may still
 *   capture it).
 */
export async function pollTerminalCharge({
  chargeId,
  getCharge,
  onUpdate,
  sleep = defaultSleep,
  typicalSeconds = TERMINAL_POLL_WINDOW.typicalSeconds,
  maxSeconds = TERMINAL_POLL_WINDOW.maxSeconds,
}: PollTerminalChargeParams): Promise<TerminalChargeView> {
  const startedAt = Date.now();
  for (;;) {
    let view: TerminalChargeView;
    try {
      view = await getCharge(chargeId);
    } catch (transportError) {
      // A transport failure is not a charge state — the adquirente still holds
      // the truth. Keep watching until the 40s budget closes, then fall through
      // to the timeout semantics (never a synthetic "failed").
      void transportError;
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      if (elapsedSeconds >= maxSeconds) {
        throw new TerminalChargeTimeoutError();
      }
      const wait = Math.min(
        cadenceMs(elapsedSeconds, typicalSeconds),
        Math.ceil((maxSeconds - elapsedSeconds) * 1000)
      );
      await sleep(wait);
      continue;
    }
    onUpdate?.(view);

    if (isSettledTerminalState(view.state)) {
      if (view.state !== "paid") {
        throw new TerminalPaymentDeclinedError(view.state, view.reason, view.reasonCode);
      }
      return view;
    }

    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    if (elapsedSeconds >= maxSeconds) {
      throw new TerminalChargeTimeoutError();
    }

    const remainingToMax = maxSeconds - elapsedSeconds;
    const wait = Math.min(
      cadenceMs(elapsedSeconds, typicalSeconds),
      // Sleep never overshoots into the max window: overshoot would count a restore
      // gap against the charge rather than against the timer.
      Math.ceil(remainingToMax * 1000)
    );
    await sleep(wait);
  }
}
