import { AdminOrder } from "@medusajs/types";
import { getSdk } from "@/config/medusa";
import { logger, safeStringify } from "@/utils/logger";
import storage from "@/utils/storage";
import { toNumber } from "@/utils/pos/pricing";
import {
  findTerminalChargeId,
  pollTerminalCharge,
  type TerminalChargeView,
  TerminalPaymentDeclinedError,
} from "@/utils/pos/order-processing/terminal-poll";

/**
 * Ensures the order's payment is captured. Reuses an existing payment
 * collection or creates one, opens a payment session for the chosen provider,
 * then captures the pending payment. Falls back to markAsPaid when the
 * provider does not auto-authorize.
 */
async function processPaymentCollection(
  order: AdminOrder,
  providerId: string,
  opts?: { onPollUpdate?: (view: TerminalChargeView) => void }
): Promise<void> {
  const sdk = getSdk();

  if (
    order.payment_status === "captured" ||
    order.payment_status === "authorized"
  ) {
    return;
  }

  // An edit on an unpaid order cancels its collection and creates a new one, so
  // the first collection is not always the one to pay.
  let collectionId = findOpenCollection(order.payment_collections ?? [])?.id;

  if (!collectionId) {
    const paymentAmount = order.summary?.accounting_total || order.total || 0;
    const { payment_collection } = await sdk.admin.paymentCollection.create({
      order_id: order.id,
      amount: paymentAmount,
    });
    collectionId = payment_collection.id;
  }

  await settleCollection(order.id, collectionId, providerId, opts);
}

const POS_PAYMENTS_CHARGES_ROUTE = "/admin/pos-payments/charges/";

type CollectionWithMoney = {
  payments?: { captured_at?: unknown }[] | undefined;
  payment_sessions?: { status?: string }[] | undefined;
};

/** True when the collection already holds money (row captured) or an
 * authorized session — never delete such a collection on a decline. */
function collectionHasSettledMoney(collection: CollectionWithMoney): boolean {
  return (
    (collection.payments?.some((p) => !!p.captured_at) ?? false) ||
    (collection.payment_sessions?.some(
      (s) => s.status === "authorized" || s.status === "captured"
    ) ?? false)
  );
}

/**
 * B2.1 poll seam extracted from settleCollection (complexity budget): if the
 * freshly-created payment session carries the plugin's charge_id, watch the
 * charge route until a terminal state — paid follows the normal finalize;
 * terminal-reject throws typed (optionally cleaning the pending collection);
 * timeout raises TerminalChargeTimeoutError and leaves everything intact.
 */
async function ensureTerminalCharge(
  sdk: ReturnType<typeof getSdk>,
  updatedCollection: { payment_sessions?: { status?: string; data?: unknown }[]; payments?: { captured_at?: unknown }[] },
  collectionId: string,
  opts?: { onPollUpdate?: (view: TerminalChargeView) => void }
): Promise<void> {
  const sessions = updatedCollection.payment_sessions ?? [];
  const activeSession = sessions[sessions.length - 1];
  const terminalChargeId = findTerminalChargeId(activeSession);
  if (!terminalChargeId) return;
  try {
    await pollTerminalCharge({
      chargeId: terminalChargeId,
      getCharge: (chargeId) =>
        sdk.client.fetch(
          `${POS_PAYMENTS_CHARGES_ROUTE}${encodeURIComponent(chargeId)}`
        ) as Promise<TerminalChargeView>,
      onUpdate: opts?.onPollUpdate,
    });
    return;
  } catch (pollError) {
    // Only the spec's redo-able failures clean the collection (failed|
    // expired|canceled). refunded means money moved in the window-40s — the
    // stale from-create snapshot may not know it: leave the collection intact
    // and let the operator handle it from Orders.
    const deletableState =
      pollError instanceof TerminalPaymentDeclinedError &&
      (pollError.state === "failed" ||
        pollError.state === "expired" ||
        pollError.state === "canceled");
    if (deletableState && !collectionHasSettledMoney(updatedCollection)) {
      try {
        await sdk.admin.paymentCollection.delete(collectionId);
      } catch (deleteError) {
        void logger.error(
          `Failed to remove terminal-declined collection ${collectionId}: ${safeStringify(deleteError)}`
        );
      }
    }
    throw pollError;
  }
}

async function settleCollection(
  orderId: string,
  collectionId: string,
  providerId: string,
  opts?: { onPollUpdate?: (view: TerminalChargeView) => void }
): Promise<void> {
  const sdk = getSdk();

  const { payment_collection: updatedCollection } =
    await sdk.admin.paymentCollection.createPaymentSession(
      collectionId,
      { provider_id: providerId },
      { fields: "*payment_sessions,*payments" }
    );

  const alreadyCaptured = updatedCollection.payments?.find(
    (p) => !!p.captured_at
  );
  if (alreadyCaptured) {
    return;
  }

  // Terminal-poll seam (B2.1, spec .adlc/specs b21): see ensureTerminalCharge —
  // keeps settleCollection inside the complexity budget.
  await ensureTerminalCharge(sdk, updatedCollection, collectionId, opts);

  const pendingPayment = updatedCollection.payments?.find(
    (p) => !p.captured_at
  );

  if (pendingPayment?.id) {
    await sdk.admin.payment.capture(pendingPayment.id, {});
    return;
  }

  // Provider didn't auto-authorize — mark as paid. Try the real provider
  // first; if it can't authorize (HTTP 422), retry under the system default.
  // markAsPaid returns an empty body and only throws on a genuine rejection,
  // so the retry can't double-pay. The real provider is still recoverable from
  // the payment session via getOrderPaymentProviderId.
  try {
    await sdk.admin.paymentCollection.markAsPaid(collectionId, {
      order_id: orderId,
      provider_id: providerId,
    });
  } catch (markPaidError) {
    void logger.error(
      `markAsPaid with provider_id failed; retrying with system default: ${safeStringify(markPaidError)}`
    );
    await sdk.admin.paymentCollection.markAsPaid(collectionId, {
      order_id: orderId,
    });
  }
}

type CollectionLike = { id: string; status?: string | null; amount?: unknown };

/** The collection still waiting to be paid; a fresh sale has exactly one. */
function findOpenCollection<T extends CollectionLike>(collections: T[]): T | undefined {
  return (
    collections.find((c) => c.status !== "canceled" && c.status !== "completed") ??
    collections.find((c) => c.status !== "canceled")
  );
}

/**
 * The unpaid collection a confirmed edit or exchange created for the
 * difference — the newest one for exactly that amount.
 */
function findOutstandingCollection<T extends CollectionLike>(
  collections: T[],
  outstanding: number
): T | undefined {
  return [...collections]
    .reverse()
    .find(
      (c) =>
        c.status === "not_paid" && Math.abs(toNumber(c.amount) - outstanding) < 0.005
    );
}

/**
 * Takes payment for what a post-sale change left owing — never the order
 * total, and never skipped because the order already reads as paid.
 * Returns the amount charged (0 when nothing is owed).
 */
async function settleOutstanding(orderId: string, providerId: string): Promise<number> {
  const sdk = getSdk();
  const { order } = await sdk.admin.order.retrieve(orderId, {
    fields: "id,*summary,*payment_collections",
  });
  const outstanding = toNumber(order.summary?.pending_difference ?? 0);
  if (outstanding <= 0) return 0;

  let collectionId = findOutstandingCollection(order.payment_collections ?? [], outstanding)?.id;
  if (!collectionId) {
    // The backend creates this on confirm; creating it here only covers a backend that does not.
    const { payment_collection } = await sdk.admin.paymentCollection.create({
      order_id: orderId,
      amount: outstanding,
    });
    collectionId = payment_collection.id;
  }

  await settleCollection(orderId, collectionId, providerId);
  return outstanding;
}

/**
 * Fulfills + marks delivered, which is what decrements inventory at the stock
 * location. Throws on failure; callers decide whether that is fatal.
 */
async function processFulfillment(order: AdminOrder): Promise<void> {
  const sdk = getSdk();

  if (
    order.fulfillment_status === "fulfilled" ||
    order.fulfillment_status === "shipped" ||
    order.fulfillment_status === "delivered"
  ) {
    return;
  }

  if (order.fulfillments && order.fulfillments.length > 0) {
    const existingFulfillment = order.fulfillments[0];
    await sdk.admin.order.markAsDelivered(order.id, existingFulfillment.id);
    return;
  }

  const itemsToFulfill =
    order.items?.map((item) => ({
      id: item.id,
      quantity: item.quantity || 1,
    })) || [];

  if (itemsToFulfill.length === 0) {
    return;
  }

  const locationId = await storage.getItem("stock_location_id");

  const response = await sdk.admin.order.createFulfillment(order.id, {
    items: itemsToFulfill,
    no_notification: true,
    ...(locationId ? { location_id: locationId } : {}),
  });

  let fulfillmentId = response.order?.fulfillments?.[0]?.id;

  if (!fulfillmentId) {
    const { order: refreshedOrder } = await sdk.admin.order.retrieve(order.id, {
      fields: "*fulfillments",
    });
    fulfillmentId = refreshedOrder.fulfillments?.[0]?.id;
  }

  if (!fulfillmentId) {
    throw new Error("Failed to get fulfillment ID");
  }

  await sdk.admin.order.markAsDelivered(order.id, fulfillmentId);
}

/**
 * Quantities not yet handed over on lines an edit or exchange just added. Lines
 * the order already had are left alone: they may be waiting to ship.
 */
function unfulfilledQuantities(
  items: { id: string; quantity?: unknown; detail?: { fulfilled_quantity?: unknown } | null }[],
  existingLineIds: ReadonlySet<string> = new Set()
): { id: string; quantity: number }[] {
  return items
    .filter((i) => !existingLineIds.has(i.id))
    .map((i) => ({ id: i.id, quantity: toNumber(i.quantity) - toNumber(i.detail?.fulfilled_quantity) }))
    .filter((i) => i.quantity > 0);
}

/**
 * Hands over the lines a post-sale change added: fulfils them at this till's
 * stock location and marks that fulfilment delivered, like a sale at checkout.
 * Nothing else on the order is fulfilled or marked delivered.
 */
async function fulfilNewItems(orderId: string, existingLineIds: ReadonlySet<string>): Promise<void> {
  const sdk = getSdk();
  const { order } = await sdk.admin.order.retrieve(orderId, {
    fields: "id,*items,*items.detail,*fulfillments",
  });
  const items = unfulfilledQuantities(order.items ?? [], existingLineIds);
  if (items.length === 0) return;
  const fulfilmentsBefore = new Set((order.fulfillments ?? []).map((f) => f.id));

  const locationId = await storage.getItem("stock_location_id");
  await sdk.admin.order.createFulfillment(orderId, {
    items,
    no_notification: true,
    ...(locationId ? { location_id: locationId } : {}),
  });

  const { order: fulfilled } = await sdk.admin.order.retrieve(orderId, { fields: "id,*fulfillments" });
  for (const f of fulfilled.fulfillments ?? []) {
    if (!fulfilmentsBefore.has(f.id) && !f.delivered_at && !f.canceled_at) {
      await sdk.admin.order.markAsDelivered(orderId, f.id);
    }
  }
}

export {
  fulfilNewItems,
  unfulfilledQuantities,
  processPaymentCollection,
  processFulfillment,
  settleCollection,
  settleOutstanding,
  findOutstandingCollection,
  findOpenCollection,
  collectionHasSettledMoney,
};
