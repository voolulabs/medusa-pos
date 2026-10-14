import { describe, expect, it, vi } from "vitest";
import {
  TerminalChargeTimeoutError,
  TerminalPaymentDeclinedError,
  TerminalChargeView,
  cadenceMs,
  findTerminalChargeId,
  isSettledTerminalState,
  pollTerminalCharge,
} from "@/utils/pos/order-processing/terminal-poll";

const noSleep = () => Promise.resolve();

describe("cadenceMs (janela típica 10s do plugin, POLL_WINDOW {10,40})", () => {
  it("polla rápido dentro da janela típica e devagar depois", () => {
    expect(cadenceMs(0)).toBe(2000);
    expect(cadenceMs(9.99)).toBe(2000);
    expect(cadenceMs(10)).toBe(5000);
    expect(cadenceMs(39)).toBe(5000);
  });
});

describe("findTerminalChargeId", () => {
  it("lê o charge_id do blob data do plugin", () => {
    expect(findTerminalChargeId({ data: { charge_id: "ord-1", data_version: 1 } })).toBe("ord-1");
  });
  it("devolve null (fluxo não-terminal) quando não há data ou o valor não é string", () => {
    expect(findTerminalChargeId(undefined)).toBeNull();
    expect(findTerminalChargeId({ data: {} })).toBeNull();
    expect(findTerminalChargeId({ data: { charge_id: 42 } })).toBeNull();
    expect(findTerminalChargeId({ data: null })).toBeNull();
  });
});

describe("estados terminais", () => {
  it("paid/failed/expired/canceled encerram; pending/awaiting_terminal/action_required não", () => {
    expect(isSettledTerminalState("paid")).toBe(true);
    expect(isSettledTerminalState("failed")).toBe(true);
    expect(isSettledTerminalState("expired")).toBe(true);
    expect(isSettledTerminalState("canceled")).toBe(true);
    expect(isSettledTerminalState("pending")).toBe(false);
    expect(isSettledTerminalState("awaiting_terminal")).toBe(false);
    expect(isSettledTerminalState("action_required")).toBe(false);
  });
});

describe("pollTerminalCharge", () => {
  const seq =
    (...states: TerminalChargeView["state"][]) =>
    (id: string) => {
      expect(id).toBe("chg-1");
      const next = states.shift() ?? "paid";
      return Promise.resolve({ state: next, reason: next === "failed" ? "rejected_by_issuer" : undefined });
    };

  it("1ª leitura imediata; cadência 2s na janela típica e 5s fora; onUpdate vê cada leitura", async () => {
    const seen: TerminalChargeView[] = [];
    const sleeps: number[] = [];
    vi.useFakeTimers();
    try {
      const sleep = async (ms: number) => {
        sleeps.push(ms);
        await vi.advanceTimersByTimeAsync(ms);
      };
      const final = await pollTerminalCharge({
        chargeId: "chg-1",
        getCharge: seq("pending", "awaiting_terminal", "action_required", "action_required", "action_required", "action_required", "paid"),
        onUpdate: (v) => seen.push(v),
        sleep,
      });
      expect(final.state).toBe("paid");
      // 1ª leitura imediata (elapsed 0) → sleep 2000; após 10s somados → 5000
      expect(sleeps[0]).toBe(2000);
      expect(sleeps[sleeps.length - 1]).toBe(5000);
      expect(seen.map((v) => v.state)).toEqual([
        "pending",
        "awaiting_terminal",
        "action_required",
        "action_required",
        "action_required",
        "action_required",
        "paid",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("estado failed rejeita tipado com reasonCode estável e copy do plugin", async () => {
    const err = await pollTerminalCharge({
      chargeId: "chg-1",
      getCharge: () => Promise.resolve<TerminalChargeView>({
        state: "failed",
        reason: "Recusa do emissor",
        reasonCode: "rejected_by_issuer",
      }),
      sleep: noSleep,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TerminalPaymentDeclinedError);
    expect((err as TerminalPaymentDeclinedError).chargeReason).toBe("Recusa do emissor");
    expect((err as TerminalPaymentDeclinedError).reasonCode).toBe("rejected_by_issuer");
  });

  it("40s sem estado terminal = timeout, NUNCA failed", async () => {
    const err = await pollTerminalCharge({
      chargeId: "chg-1",
      getCharge: () => Promise.resolve<TerminalChargeView>({ state: "pending" }),
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 200))),
      maxSeconds: 0.2,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TerminalChargeTimeoutError);
    expect(err).not.toBeInstanceOf(TerminalPaymentDeclinedError);
  });

  it("sleep nunca estoura o teto da janela", async () => {
    const sleeps: number[] = [];
    // Relógio controlado: cada sleep avança o Date.now no tempo declarado —
    // nada de relógio real (o loop de microtasks era lento no CPU de CI).
    let now = 0;
    const realDateNow = Date.now;
    Date.now = () => now;
    try {
      await pollTerminalCharge({
        chargeId: "chg-1",
        getCharge: () => Promise.resolve<TerminalChargeView>({ state: "pending" }),
        sleep: (ms) => {
          sleeps.push(ms);
          now += ms;
          return Promise.resolve();
        },
        typicalSeconds: 1,
        maxSeconds: 2,
      });
      expect.unreachable("devia dar timeout");
    } catch {
      expect(sleeps.every((ms) => ms <= 2000)).toBe(true);
    } finally {
      Date.now = realDateNow;
    }
  });
});

describe("transport errors não suedam o poll (P5 achado 1)", () => {
  it("fulga de rede volta a pollar até o orçamento, depois timeout", async () => {
    let reads = 0;
    vi.useFakeTimers();
    try {
      const err = await pollTerminalCharge({
        chargeId: "chg-1",
        getCharge: () => {
          reads += 1;
          if (reads === 1) return Promise.reject(new Error("502"));
          return Promise.resolve<TerminalChargeView>({ state: "awaiting_terminal" });
        },
        sleep: async (ms: number) => {
          await vi.advanceTimersByTimeAsync(ms);
        },
        maxSeconds: 0.5,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(TerminalChargeTimeoutError);
      expect(reads).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("refunded é estado terminal (P5 achado 7 — espelho do enum do plugin)", () => {
  it("refunded rejeita tipado (não polula até o timeout)", async () => {
    const err = await pollTerminalCharge({
      chargeId: "chg-1",
      getCharge: () => Promise.resolve<TerminalChargeView>({ state: "refunded" }),
      sleep: () => Promise.resolve(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TerminalPaymentDeclinedError);
    expect((err as TerminalPaymentDeclinedError).state).toBe("refunded");
  });
});
