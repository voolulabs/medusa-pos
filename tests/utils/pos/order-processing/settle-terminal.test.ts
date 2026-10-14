import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AdminOrder } from "@medusajs/types";
import {
  settleCollection,
} from "@/utils/pos/order-processing";
import {
  TerminalChargeTimeoutError,
  TerminalPaymentDeclinedError,
} from "@/utils/pos/order-processing/terminal-poll";

const h = vi.hoisted(() => {
  const calls = {
    fetches: [] as { path: string; method?: string }[],
    markAsPaid: [] as unknown[][],
    capture: [] as unknown[][],
    deleteCollection: [] as string[],
  };
  const flags = {
    // Loose typing: the fake charge state is data (string), not a union guard.
    nextChargeState: undefined as string | undefined,
    nextChargeReason: undefined as string | undefined,
  };
  const sdk = {
    client: {
      fetch: vi.fn(async (path: string, init?: { method?: string }) => {
        calls.fetches.push({ path, method: init?.method });
        return { state: flags.nextChargeState, reason: flags.nextChargeReason };
      }),
    },
    admin: {
      paymentCollection: {
        createPaymentSession: vi.fn(
          async () =>
            ({ payment_collection: { ...COLLECTION_BASE } }) as unknown
        ),
        delete: vi.fn(async (id: string) => {
          calls.deleteCollection.push(id);
          return { id, deleted: true };
        }),
        markAsPaid: vi.fn(async (...args: unknown[]) => {
          calls.markAsPaid.push(args);
          return { id: "col-1" };
        }),
      },
      payment: {
        capture: vi.fn(async (...args: unknown[]) => {
          calls.capture.push(args);
          return { id: "pay-1" };
        }),
      },
    },
  };
  return { calls, sdk, flags };
});

vi.mock("@/config/medusa", () => ({ getSdk: () => h.sdk }));
vi.mock("@/utils/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
  safeStringify: (v: unknown) => String(v),
}));
vi.mock("@/utils/storage", () => ({ default: { getItem: vi.fn(async () => undefined) } }));

const ORDER = { id: "order_1", display_id: 1 } as unknown as AdminOrder;
const COLLECTION_BASE = {
  id: "col-1",
  status: "not_paid",
  amount: 10000,
  payments: [] as { id?: string; captured_at?: string | null }[],
  payment_sessions: [] as unknown[],
};

const pendingSession = (chargeId?: string) => ({
  id: "ps-1",
  provider_id: "pp_pos-terminal_mercadopago",
  status: "pending",
  data: chargeId ? { charge_id: chargeId, data_version: 1 } : {},
});

function sessionReturn(chargeId?: string, payments: typeof COLLECTION_BASE.payments = []) {
  const session = pendingSession(chargeId);
  h.sdk.admin.paymentCollection.createPaymentSession =
    vi.fn(async () => ({
      payment_collection: {
        ...COLLECTION_BASE,
        payments,
        payment_sessions: [session],
      },
    }));
}

const stubSession = (payment_collection: unknown) => {
  h.sdk.admin.paymentCollection.createPaymentSession = vi.fn(
    async () => payment_collection as { payment_collection: unknown }
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.fetches.length = 0;
  h.calls.markAsPaid.length = 0;
  h.calls.capture.length = 0;
  h.calls.deleteCollection.length = 0;
  h.flags.nextChargeState = "paid";
  h.flags.nextChargeReason = undefined;
});

describe("settleCollection — seam do terminal (B2.1)", () => {
  it("sem charge_id (manual): nenhuma leitura de charge e finalize normal", async () => {
    sessionReturn(undefined);
    await settleCollection(ORDER.id, "col-1", "pp_pos-terminal_card");
    expect(h.calls.fetches).toHaveLength(0);
    expect(h.calls.markAsPaid[0]?.[1]).toMatchObject({ provider_id: "pp_pos-terminal_card" });
    expect(h.calls.deleteCollection).toHaveLength(0);
  });

  it("paid: poll até paid e finalize segue (markAsPaid com o provider verbatim)", async () => {
    sessionReturn("chg-1");
    h.flags.nextChargeState = "paid";
    await settleCollection(ORDER.id, "col-1", "pp_pos-terminal_mercadopago");
    expect(h.calls.fetches[0]?.path).toBe("/admin/pos-payments/charges/chg-1");
    expect(h.calls.markAsPaid).toHaveLength(1);
    expect(h.calls.deleteCollection).toHaveLength(0);
  });

  it("failed (sem dinheiro na collection): collection deletada e motivo sobe tipado", async () => {
    sessionReturn("chg-1");
    h.flags.nextChargeState = "failed";
    h.flags.nextChargeReason = "rejected_by_issuer";
    const err = await settleCollection(ORDER.id, "col-1", "pp_pos-terminal_mercadopago").catch((e) => e);
    expect(err).toBeInstanceOf(TerminalPaymentDeclinedError);
    expect(h.calls.deleteCollection).toEqual(["col-1"]);
    expect(h.calls.markAsPaid).toHaveLength(0);
  });

  it("failed com payment AUTHORIZED na collection: NADA é deletado (guarda do AC4)", async () => {
    stubSession({
      payment_collection: {
        ...COLLECTION_BASE,
        payments: [],
        payment_sessions: [{ id: "ps-2", status: "authorized", data: {} }, pendingSession("chg-1")],
      },
    });
    h.flags.nextChargeState = "failed";
    const err = await settleCollection(ORDER.id, "col-1", "pp_pos-terminal_mercadopago").catch((e) => e);
    expect(err).toBeInstanceOf(TerminalPaymentDeclinedError);
    expect(h.calls.deleteCollection).toHaveLength(0);
  });

  it("refunded NÃO deleta a collection (M1 — dinheiro moveu na janela)", async () => {
    stubSession({
      payment_collection: {
        ...COLLECTION_BASE,
        payments: [],
        payment_sessions: [pendingSession("chg-1")],
      },
    });
    h.flags.nextChargeState = "refunded";
    const err = await settleCollection(ORDER.id, "col-1", "pp_pos-terminal_mercadopago").catch((e) => e);
    expect(err).toBeInstanceOf(TerminalPaymentDeclinedError);
    expect(h.calls.deleteCollection).toHaveLength(0);
  });

  it("captura efetivada antes do poll: nenhum trabalho extra", async () => {
    stubSession({
      payment_collection: {
        ...COLLECTION_BASE,
        payments: [{ id: "pay-1", captured_at: new Date().toISOString() }],
        payment_sessions: [pendingSession("chg-1")],
      },
    });
    await settleCollection(ORDER.id, "col-1", "pp_pos-terminal_mercadopago");
    expect(h.calls.fetches).toHaveLength(0);
    expect(h.calls.markAsPaid).toHaveLength(0);
  });
});

describe("settleCollection — timeout do poll (orçamento 40s)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("40s sem estado terminal: sem delete, sem markAsPaid — ordem fica pendente", async () => {
    vi.useFakeTimers();
    sessionReturn("chg-1");
    h.flags.nextChargeState = "awaiting_terminal";
    const p = settleCollection(ORDER.id, "col-1", "pp_pos-terminal_mercadopago");
    const result = await Promise.all([
      p.then(
        () => "resolved",
        (e) => e
      ),
      vi.waitFor(() => h.calls.fetches.length > 10),
      vi.advanceTimersByTimeAsync(45_000),
    ]);
    const err = result[0];
    expect(err).toBeInstanceOf(TerminalChargeTimeoutError);
    expect(h.calls.deleteCollection).toHaveLength(0);
    expect(h.calls.markAsPaid).toHaveLength(0);
  });
});
