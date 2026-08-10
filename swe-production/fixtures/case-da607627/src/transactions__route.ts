import { NextRequest } from "next/server";
import { withAppAuth } from "@/lib/api/appAuth";
import { handleCorsOptions, withCors } from "@/lib/api/cors";
import { prisma } from "@/lib/db";
import { uuidv7 } from "uuidv7";
import { getDateOnlyRangeInTimeZone, getOrgToday } from "@/lib/utils/timezone";
import { generateResourceCode } from "@/lib/identifierGenerator";
import { postJournalEntry, findSystemAccounts } from "@/lib/accounting";
import { hasChartOfAccounts } from "@/lib/accounting/accountingEnabled";
import Redis from "ioredis";
import { fireNotificationEvent } from "@/lib/notifications/rule-engine";
import { WEBHOOK_EVENTS } from "@/lib/api/webhook-events";
import { resolveStoreWarehouseIds } from "@/lib/utils/warehouse";
import { recordRevenueAffectingChange } from "@/lib/ledger/revenue-ledger";
import { recordPaymentReceived } from "@/lib/ledger/payment-ledger";
import { resolveCustomerCredit } from "@/lib/credit/accountUnits";
import { buildPosSaleJournalLines } from "@/lib/pos/journalLines";
import { getOrCreateWalkInContactId } from "@/lib/pos/walkInContact";
import { createInvoice } from "@/lib/services/invoices";
import { transitionInvoiceToSent } from "@/lib/invoicing/invoiceLedgerEmit";
import {
  applyPosConsumptionPlans,
  buildPosConsumptionPlans,
  PosInventoryError,
  releasePosReservationPlans,
} from "@/lib/pos/inventoryConsumption";
import { resolvePaymentMethod } from "@/lib/payments/resolveMethodAccount";
import { normalizeMethodCode } from "@/lib/payment-methods";
import {
  calculatePosCashRounding,
  getOrgRoundingSettings,
} from "@/lib/accounting/roundingThreshold";

const POS_TRANSACTION_ALREADY_FINALIZED = "POS_TRANSACTION_ALREADY_FINALIZED";
const POS_TRANSACTION_ITEMS_CHANGED = "POS_TRANSACTION_ITEMS_CHANGED";

function getRedis() {
  return new Redis(
    process.env.REDIS_URL ||
      `redis://${process.env.REDIS_HOST || "localhost"}:${process.env.REDIS_PORT || 6379}`,
  );
}

function mapOrderType(orderType: string): string {
  if (orderType === "Makan di Tempat") return "DINE_IN";
  if (orderType === "Take Away") return "TAKEAWAY";
  if (orderType === "Delivery") return "DELIVERY";
  return "DINE_IN";
}

type IncomingPosItem = {
  productId?: string;
  product?: { id?: string; price?: number };
  qty?: number;
  quantity?: number;
  unitPrice?: number;
  discountPercent?: number;
  discountAmount?: number;
  note?: string;
  notes?: string;
};

type NormalizedPosItem = {
  productId: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  discountAmount: number;
  note: string | null;
};

export async function OPTIONS(req: NextRequest) {
  return handleCorsOptions(req) ?? new Response(null, { status: 204 });
}

export async function GET(req: NextRequest) {
  const optRes = handleCorsOptions(req);
  if (optRes) return optRes;

  const response = await withAppAuth(req, async (ctx) => {
    const org = await prisma.organization.findUnique({
      where: { id: ctx.organizationId },
      select: { timezone: true },
    });
    const tz = org?.timezone || "Asia/Jakarta";
    const { start: todayStart, end: todayEnd } = getDateOnlyRangeInTimeZone(
      getOrgToday(tz),
      tz,
    );

    const transactions = await prisma.pOSTransaction.findMany({
      where: {
        organizationId: ctx.organizationId,
        createdAt: { gte: todayStart, lt: todayEnd },
      },
      include: {
        items: {
          include: { product: { select: { id: true, name: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const totalRevenue = transactions
      .filter((t) => t.status === "COMPLETED")
      .reduce((sum, t) => sum + Number(t.total), 0);

    return Response.json({
      transactions,
      summary: {
        totalRevenue,
        totalTransactions: transactions.filter((t) => t.status === "COMPLETED")
          .length,
      },
    });
  });

  return withCors(req, response);
}

export async function POST(req: NextRequest) {
  const optRes = handleCorsOptions(req);
  if (optRes) return optRes;

  const response = await withAppAuth(req, async (ctx) => {
    const body = await req.json();
    const now = new Date();
    const {
      sessionId,
      items,
      paymentMethod,
      paymentMethodId: bodyPaymentMethodId,
      amountPaid,
      discountAmount,
      taxAmount,
      total,
      tableNumber,
      tableId,
      orderType,
      subtotal,
      notes,
      customerId,
      accountId,
      accountUnitId,
      shippingCost,
      transactionId,
    } = body;
    const explicitCustomerId =
      typeof customerId === "string" && customerId.trim()
        ? customerId.trim()
        : null;

    if (!items?.length) {
      return Response.json({ error: "items are required" }, { status: 400 });
    }

    // Resumed waiter orders send transactionId. Only a pending, unpaid
    // transaction may be finalized through this endpoint; anything else is a
    // duplicate/retry or stale client state and must not create a second sale.
    const existingTransaction = transactionId
      ? await prisma.pOSTransaction.findFirst({
          where: { id: transactionId, organizationId: ctx.organizationId },
          select: {
            id: true,
            number: true,
            status: true,
            paymentStatus: true,
            sessionId: true,
          },
        })
      : null;
    if (transactionId && !existingTransaction) {
      return Response.json(
        { error: "TRANSACTION_NOT_FOUND", message: "Transaction not found." },
        { status: 404 },
      );
    }
    if (
      existingTransaction &&
      (existingTransaction.status !== "PENDING" ||
        existingTransaction.paymentStatus !== "UNPAID")
    ) {
      return Response.json(
        {
          error: "TRANSACTION_ALREADY_FINALIZED",
          message: "Transaction was already completed or paid.",
        },
        { status: 409 },
      );
    }

    const isUpdate = Boolean(existingTransaction);
    const sessionIdToUse = isUpdate
      ? existingTransaction!.sessionId
      : sessionId;

    if (!sessionIdToUse || !items?.length) {
      return Response.json(
        { error: "sessionId and items are required" },
        { status: 400 },
      );
    }

    const posSession = await prisma.pOSSession.findFirst({
      where: {
        id: sessionIdToUse,
        organizationId: ctx.organizationId,
        status: "OPEN",
      },
      include: {
        terminal: {
          select: { storeId: true, warehouseId: true },
        },
      },
    });
    if (!posSession) {
      return Response.json(
        { error: "Session not found or closed" },
        { status: 404 },
      );
    }

    const storeWarehouseIds = posSession.terminal?.warehouseId
      ? [posSession.terminal.warehouseId]
      : posSession.terminal?.storeId
        ? await resolveStoreWarehouseIds(
            posSession.terminal.storeId,
            ctx.organizationId,
          )
        : [];

    const diningTable = tableId
      ? await prisma.diningTable.findFirst({
          where: { id: tableId, organizationId: ctx.organizationId },
          select: { id: true },
        })
      : null;
    if (tableId && !diningTable) {
      return Response.json({ error: "Table not found" }, { status: 404 });
    }

    const number =
      existingTransaction?.number ??
      (await generateResourceCode(ctx.organizationId, "TXN"));

    const normalizedItems: NormalizedPosItem[] = (
      items as IncomingPosItem[]
    ).map((item) => {
      const productId = item.productId ?? item.product?.id;
      const quantity = Number(item.qty ?? item.quantity ?? 1);
      const unitPrice = item.unitPrice ?? item.product?.price ?? 0;
      const discountPercent = Math.max(
        0,
        Math.min(100, Number(item.discountPercent ?? 0)),
      );
      const discountAmount = Math.max(0, Number(item.discountAmount ?? 0));
      return {
        productId: productId ?? "",
        quantity,
        unitPrice,
        discountPercent,
        discountAmount,
        note: item.note ?? item.notes ?? null,
      };
    });
    const invalidItem = normalizedItems.find(
      (item) => !item.productId || item.quantity <= 0,
    );
    if (invalidItem) {
      return Response.json(
        {
          error: "INVALID_POS_ITEMS",
          message: "Each item needs a product and positive quantity.",
        },
        { status: 400 },
      );
    }

    // Validate item-level discounts
    for (let idx = 0; idx < normalizedItems.length; idx++) {
      const item = normalizedItems[idx];
      const itemLineTotal = item.quantity * item.unitPrice;
      if (item.discountAmount > itemLineTotal) {
        return Response.json(
          {
            error: "INVALID_ITEM_DISCOUNT",
            message: `Item at index ${idx}: discount amount (${item.discountAmount}) cannot exceed line total (${itemLineTotal})`,
          },
          { status: 400 },
        );
      }
    }

    // Validate transaction-level discount and shipping
    const discountAmountNum = Math.max(0, Number(discountAmount ?? 0));
    const shippingCostNum = Math.max(0, Number(shippingCost ?? 0));
    const taxAmountNum = Math.max(0, Number(taxAmount ?? 0));
    const totalNum = Number(total ?? 0);

    // Validate individual components
    if (discountAmountNum < 0) {
      return Response.json(
        {
          error: "INVALID_DISCOUNT",
          message: "Transaction discount amount cannot be negative",
        },
        { status: 400 },
      );
    }
    if (shippingCostNum < 0) {
      return Response.json(
        {
          error: "INVALID_SHIPPING",
          message: "Shipping cost cannot be negative",
        },
        { status: 400 },
      );
    }

    const calculatedSubtotal = normalizedItems.reduce(
      (sum, item) =>
        sum + (item.quantity * item.unitPrice - item.discountAmount),
      0,
    );
    const submittedSubtotal =
      subtotal == null ? calculatedSubtotal : Number(subtotal);
    const subtotalTolerance = 0.01;
    if (
      !Number.isFinite(submittedSubtotal) ||
      Math.abs(submittedSubtotal - calculatedSubtotal) > subtotalTolerance
    ) {
      return Response.json(
        {
          error: "INVALID_SUBTOTAL",
          message: `Subtotal (${submittedSubtotal}) does not match expected POS subtotal (${calculatedSubtotal}).`,
          expected: calculatedSubtotal,
          received: submittedSubtotal,
        },
        { status: 400 },
      );
    }
    const subtotalNum = Math.round(calculatedSubtotal * 100) / 100;
    if (discountAmountNum > calculatedSubtotal) {
      return Response.json(
        {
          error: "INVALID_DISCOUNT",
          message: `Transaction discount amount (${discountAmountNum}) cannot exceed subtotal (${calculatedSubtotal})`,
        },
        { status: 400 },
      );
    }

    // Base total before POS cash rounding. Payment-method-specific rounding is
    // validated after the method is resolved below.
    const baseExpectedTotal =
      subtotalNum - discountAmountNum + taxAmountNum + shippingCostNum;

    const existingItemsForCheckout = isUpdate
      ? await prisma.pOSTransactionItem.findMany({
          where: { transactionId: existingTransaction!.id },
          select: {
            id: true,
            productId: true,
            quantity: true,
            kdsStatus: true,
          },
        })
      : [];
    const doneQtyByProduct = new Map<string, number>();
    for (const item of existingItemsForCheckout) {
      if (item.kdsStatus !== "DONE") continue;
      doneQtyByProduct.set(
        item.productId,
        (doneQtyByProduct.get(item.productId) ?? 0) + Number(item.quantity),
      );
    }
    const requestedLinesForConsumption = normalizedItems
      .map((item) => {
        const alreadyConsumed = doneQtyByProduct.get(item.productId) ?? 0;
        if (alreadyConsumed <= 0)
          return { productId: item.productId, quantity: item.quantity };
        const remaining = item.quantity - alreadyConsumed;
        doneQtyByProduct.set(
          item.productId,
          Math.max(0, alreadyConsumed - item.quantity),
        );
        return { productId: item.productId, quantity: remaining };
      })
      .filter((item) => item.quantity > 0);
    const doneItemIds = existingItemsForCheckout
      .filter((item) => item.kdsStatus === "DONE")
      .map((item) => item.id);
    const preConsumedMovements =
      doneItemIds.length > 0
        ? await prisma.stockMovement.findMany({
            where: {
              organizationId: ctx.organizationId,
              movementType: "OUT",
              referenceType: "POSTransactionItem",
              referenceId: { in: doneItemIds },
            },
            select: { productId: true, quantity: true, unitCost: true },
          })
        : [];
    const preConsumedCogs = preConsumedMovements.reduce(
      (sum, movement) =>
        sum + Number(movement.quantity) * Number(movement.unitCost ?? 0),
      0,
    );

    let consumptionPlans;
    try {
      consumptionPlans = await buildPosConsumptionPlans({
        db: prisma,
        organizationId: ctx.organizationId,
        storeWarehouseIds,
        requestedLines: requestedLinesForConsumption,
        bypassStockCheck: isUpdate,
      });
    } catch (error) {
      if (error instanceof PosInventoryError) {
        return Response.json(
          { error: error.message, ...error.details },
          { status: error.status },
        );
      }
      throw error;
    }
    // Resolve the configured OrgPaymentMethod (POS surface). The terminal sends
    // a paymentMethodId; legacy callers send a method string which we map to the
    // org's matching method (lowest displayOrder wins for duplicates).
    const incomingCode = normalizeMethodCode(paymentMethod ?? "cash");
    if (!incomingCode) {
      return Response.json(
        {
          error: "INVALID_PAYMENT_METHOD",
          message: "paymentMethod tidak valid.",
        },
        { status: 400 },
      );
    }
    let resolvedPaymentMethodId: string | null =
      typeof bodyPaymentMethodId === "string" && bodyPaymentMethodId.trim()
        ? bodyPaymentMethodId.trim()
        : null;
    if (!resolvedPaymentMethodId) {
      const byCode = await prisma.orgPaymentMethod.findFirst({
        where: {
          organizationId: ctx.organizationId,
          method: incomingCode,
          enabled: true,
          surfaces: { has: "POS" },
        },
        orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
        select: { id: true },
      });
      resolvedPaymentMethodId = byCode?.id ?? null;
    }
    const resolvedMethod = await resolvePaymentMethod(
      ctx.organizationId,
      resolvedPaymentMethodId,
      { surface: "POS" },
    );
    if (!resolvedMethod) {
      return Response.json(
        {
          error: "PAYMENT_METHOD_NOT_CONFIGURED",
          message: "Metode pembayaran belum dikonfigurasi untuk POS.",
        },
        { status: 400 },
      );
    }
    const mappedPaymentMethod = resolvedMethod.methodCode; // snapshot code
    const isCredit = mappedPaymentMethod === "CREDIT";
    const roundingSettings = await getOrgRoundingSettings(ctx.organizationId);
    const cashRounding =
      mappedPaymentMethod === "CASH"
        ? calculatePosCashRounding(baseExpectedTotal, roundingSettings)
        : { total: Math.round(baseExpectedTotal * 100) / 100, amount: 0 };
    const expectedTotal = cashRounding.total;
    const roundingAmount = cashRounding.amount;
    const tolerance = 0.01; // Allow 0.01 rounding difference
    if (Math.abs(totalNum - expectedTotal) > tolerance) {
      return Response.json(
        {
          error: "INVALID_TOTAL",
          message: `Total (${totalNum}) does not match expected POS total (${expectedTotal}).`,
          expected: expectedTotal,
          received: totalNum,
          baseTotal: baseExpectedTotal,
          roundingAmount,
        },
        { status: 400 },
      );
    }
    const changeAmount = Math.max(0, (amountPaid ?? 0) - totalNum);

    let resolvedAccountId: string | null =
      typeof accountId === "string" ? accountId : null;
    let resolvedAccountUnitId: string | null =
      typeof accountUnitId === "string" ? accountUnitId : null;
    const contact = explicitCustomerId
      ? await prisma.contact.findFirst({
          where: { id: explicitCustomerId, organizationId: ctx.organizationId },
          select: { id: true, companyId: true, accountUnitId: true },
        })
      : null;
    resolvedAccountId ||= contact?.companyId ?? null;
    resolvedAccountUnitId ||= contact?.accountUnitId ?? null;

    if (resolvedAccountUnitId) {
      const unit = await prisma.crmAccountUnit.findFirst({
        where: {
          id: resolvedAccountUnitId,
          organizationId: ctx.organizationId,
          deletedAt: null,
        },
        select: { id: true, accountId: true },
      });
      if (!unit) {
        if (typeof accountUnitId === "string") {
          return Response.json(
            {
              error: "INVALID_ACCOUNT_UNIT",
              message: "Selected account unit was not found.",
            },
            { status: 400 },
          );
        }
        resolvedAccountUnitId = null;
      } else if (resolvedAccountId && unit.accountId !== resolvedAccountId) {
        return Response.json(
          {
            error: "UNIT_ACCOUNT_MISMATCH",
            message: "Selected unit does not belong to the selected account.",
          },
          { status: 400 },
        );
      } else {
        resolvedAccountId ||= unit.accountId;
      }
    }
    if (resolvedAccountId) {
      const accountExists = await prisma.crmAccount.findFirst({
        where: {
          id: resolvedAccountId,
          organizationId: ctx.organizationId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!accountExists) {
        if (typeof accountId === "string") {
          return Response.json(
            {
              error: "INVALID_ACCOUNT",
              message: "Selected account was not found.",
            },
            { status: 400 },
          );
        }
        resolvedAccountId = null;
        resolvedAccountUnitId = null;
      }
    }

    // ─── : POS piutang (CREDIT) — three-layer validation ──────────────
    let dueDate: Date | null = null;
    if (isCredit) {
      // Layer 1 — gating
      if (!explicitCustomerId || !contact) {
        return Response.json(
          {
            error: "CREDIT_REQUIRES_CUSTOMER",
            message: "Piutang memerlukan pelanggan terdaftar.",
          },
          { status: 403 },
        );
      }
      const credit = await resolveCustomerCredit(prisma, {
        organizationId: ctx.organizationId,
        contactId: explicitCustomerId,
        accountId: resolvedAccountId,
        accountUnitId: resolvedAccountUnitId,
        amount: totalNum,
      });
      if (!credit.allowed) {
        return Response.json(
          {
            error: credit.reason || "CREDIT_NOT_ALLOWED",
            message:
              credit.message ||
              "Pelanggan ini tidak diizinkan piutang. Hubungi admin untuk mengaktifkan.",
            credit,
          },
          { status: credit.reason?.includes("LIMIT") ? 409 : 403 },
        );
      }
      resolvedAccountId = credit.accountId;
      resolvedAccountUnitId = credit.accountUnitId;
      dueDate = new Date(now.getTime() + credit.termDays * 24 * 60 * 60 * 1000);
    }

    const accts = await findSystemAccounts(ctx.organizationId);
    const acctOn = await hasChartOfAccounts(ctx.organizationId);
    // Debit account comes only from the chosen payment method (no PM_ system-slot
    // or generic CASH/BANK fallback). CREDIT (pay-later) debits Accounts
    // Receivable instead. Fee routing also follows the method.
    const orgPaymentMethod = resolvedMethod;
    const debitAcct = isCredit
      ? accts.ACCOUNTS_RECEIVABLE
      : (orgPaymentMethod.cashAccountId ?? undefined);
    const revenueAcct = accts.SALES_REVENUE;
    const taxAcct = accts.TAX_PAYABLE;
    const inventoryAcct = accts.INVENTORY;
    const cogsAcct = accts.COGS;
    const roundingGainAcct = accts.ROUNDING_GAIN;
    const roundingLossAcct = accts.ROUNDING_LOSS;
    const missingAccounts = [
      ...(debitAcct
        ? []
        : [
            isCredit
              ? "Accounts Receivable (Piutang)"
              : "Cash/Bank or payment-method account",
          ]),
      ...(revenueAcct ? [] : ["Sales Revenue"]),
      ...(Number(taxAmount ?? 0) > 0 && !taxAcct ? ["Tax Payable"] : []),
      ...(roundingAmount > 0 && !roundingGainAcct ? ["Rounding Gain"] : []),
      ...(roundingAmount < 0 && !roundingLossAcct ? ["Rounding Loss"] : []),
      ...(consumptionPlans.length > 0 && !inventoryAcct ? ["Inventory"] : []),
      ...(consumptionPlans.length > 0 && !cogsAcct ? ["COGS"] : []),
    ];
    if (acctOn && missingAccounts.length > 0) {
      return Response.json(
        {
          error: `Accounting mappings are required before posting POS sales: ${missingAccounts.join(", ")}`,
        },
        { status: 400 },
      );
    }

    // Attribute customer-less POS sales to the per-org "Pelanggan Umum" so every
    // transaction surfaces in Sales > POS Orders and the unified reports. Credit
    // and loyalty stay gated on the explicitly-selected customer below.
    const effectiveCustomerId =
      explicitCustomerId ??
      (await getOrCreateWalkInContactId(ctx.organizationId, ctx.userId));
    let txResult;
    try {
      txResult = await prisma.$transaction(async (tx) => {
        let createdTransaction;

        if (isUpdate) {
          const existingItems = await tx.pOSTransactionItem.findMany({
            where: { transactionId: existingTransaction!.id },
            select: {
              id: true,
              productId: true,
              quantity: true,
              unitPrice: true,
              discountAmount: true,
            },
            orderBy: { id: "asc" },
          });
          const lineKey = (line: {
            productId: string;
            quantity: unknown;
            unitPrice: unknown;
            discountAmount: unknown;
          }) =>
            [
              line.productId,
              Number(line.quantity).toFixed(3),
              Number(line.unitPrice).toFixed(2),
              Number(line.discountAmount).toFixed(2),
            ].join(":");
          const existingSignature = existingItems.map(lineKey).sort().join("|");
          const requestedSignature = normalizedItems
            .map((line) => lineKey(line))
            .sort()
            .join("|");
          if (existingSignature !== requestedSignature) {
            throw new Error(POS_TRANSACTION_ITEMS_CHANGED);
          }

          const updateResult = await tx.pOSTransaction.updateMany({
            where: {
              id: existingTransaction!.id,
              organizationId: ctx.organizationId,
              status: "PENDING",
              paymentStatus: "UNPAID",
            },
            data: {
              accountId: resolvedAccountId,
              accountUnitId: resolvedAccountUnitId,
              subtotal: subtotalNum,
              discountAmount: discountAmountNum,
              taxAmount: taxAmountNum,
              shippingCost: shippingCostNum,
              roundingAmount,
              total: totalNum,
              paymentMethod: mappedPaymentMethod,
              paymentMethodId: resolvedPaymentMethodId,
              status: "COMPLETED",
              paymentStatus: isCredit ? "UNPAID" : "PAID",
              dueDate: isCredit ? dueDate : null,
              amountOutstanding: 0,
              amountPaid: isCredit ? 0 : (amountPaid ?? totalNum),
              changeAmount: isCredit ? 0 : changeAmount,
              notes: notes ?? null,
              customerId: effectiveCustomerId,
              metadata: {
                ...(tableNumber ? { tableNumber } : {}),
                ...(roundingAmount !== 0
                  ? {
                      rounding: {
                        baseTotal: baseExpectedTotal,
                        amount: roundingAmount,
                        mode: roundingSettings.posCashRoundingMode,
                        increment: roundingSettings.posCashRoundingIncrement,
                      },
                    }
                  : {}),
                ...(isCredit
                  ? {
                      credit: {
                        accountId: resolvedAccountId,
                        accountUnitId: resolvedAccountUnitId,
                      },
                    }
                  : {}),
              },
            },
          });
          if (updateResult.count !== 1) {
            throw new Error(POS_TRANSACTION_ALREADY_FINALIZED);
          }

          createdTransaction = await tx.pOSTransaction.findFirstOrThrow({
            where: {
              id: existingTransaction!.id,
              organizationId: ctx.organizationId,
            },
            include: {
              items: {
                include: { product: { select: { id: true, name: true } } },
              },
            },
          });
        } else {
          // Create new transaction
          createdTransaction = await tx.pOSTransaction.create({
            data: {
              id: uuidv7(),
              number,
              organizationId: ctx.organizationId,
              sessionId: sessionIdToUse,
              storeId: posSession.terminal?.storeId ?? null,
              accountId: resolvedAccountId,
              accountUnitId: resolvedAccountUnitId,
              subtotal: subtotalNum,
              discountAmount: discountAmountNum,
              taxAmount: taxAmountNum,
              shippingCost: shippingCostNum,
              roundingAmount,
              total: totalNum,
              paymentMethod: mappedPaymentMethod,
              paymentMethodId: resolvedPaymentMethodId,
              amountPaid: isCredit ? 0 : (amountPaid ?? totalNum),
              changeAmount: isCredit ? 0 : changeAmount,
              orderType: mapOrderType(orderType ?? ""),
              kitchenStatus: "NEW",
              status: "COMPLETED",
              paymentStatus: isCredit ? "UNPAID" : "PAID",
              dueDate: isCredit ? dueDate : null,
              // : for credit the receivable lives on the auto-issued invoice,
              // not the POS tx. Keep POS outstanding at 0 so it isn't double-counted
              // in receivables; the invoice carries the amount owed.
              amountOutstanding: 0,
              notes: notes ?? null,
              tableId: tableId ?? null,
              customerId: effectiveCustomerId,
              metadata: {
                ...(tableNumber ? { tableNumber } : {}),
                ...(roundingAmount !== 0
                  ? {
                      rounding: {
                        baseTotal: baseExpectedTotal,
                        amount: roundingAmount,
                        mode: roundingSettings.posCashRoundingMode,
                        increment: roundingSettings.posCashRoundingIncrement,
                      },
                    }
                  : {}),
                ...(isCredit
                  ? {
                      credit: {
                        accountId: resolvedAccountId,
                        accountUnitId: resolvedAccountUnitId,
                      },
                    }
                  : {}),
              },
              items: {
                create: normalizedItems.map((item) => {
                  const lineTotal =
                    item.quantity * item.unitPrice - item.discountAmount;
                  return {
                    id: uuidv7(),
                    productId: item.productId,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice,
                    discountPercent: item.discountPercent,
                    discountAmount: item.discountAmount,
                    total: lineTotal,
                    notes: item.note ?? null,
                  };
                }),
              },
            },
            include: {
              items: {
                include: { product: { select: { id: true, name: true } } },
              },
            },
          });
        }

        if (diningTable) {
          await tx.diningTable.updateMany({
            where: { id: diningTable.id, organizationId: ctx.organizationId },
            data: { status: "OCCUPIED", currentTxId: createdTransaction.id },
          });
        }

        if (isUpdate) {
          await releasePosReservationPlans({ tx, plans: consumptionPlans });
        }
        const totalCogs =
          preConsumedCogs +
          (await applyPosConsumptionPlans({
            tx,
            plans: consumptionPlans,
            organizationId: ctx.organizationId,
            userId: ctx.userId,
            transactionId: createdTransaction.id,
            transactionNumber: number,
          }));

        const txTotal = totalNum;
        // Reuse the validated subtotal (checked above against
        // total = subtotal - discount + tax + shipping) instead of re-deriving it.
        const txSubtotal = subtotalNum;
        const txDiscount = discountAmountNum;
        const txTax = Number(taxAmount ?? 0);
        const txShipping = shippingCostNum;

        //  — compute marketplace/platform fee from OrgPaymentMethod
        // configuration. Fee = txTotal × feePercent% + feeFixed (additive).
        // Skipped for credit-term sales (cash hasn't arrived; fee gets booked
        // at the settlement step instead).
        const feeAcct = !isCredit
          ? orgPaymentMethod?.feeAccountId || accts.PLATFORM_FEE_EXPENSE
          : undefined;
        const feePercentNum = orgPaymentMethod?.feePercent
          ? Number(orgPaymentMethod.feePercent)
          : 0;
        const feeFixedNum = orgPaymentMethod?.feeFixed
          ? Number(orgPaymentMethod.feeFixed)
          : 0;
        const computedFeeAmount = Math.round(
          (txTotal * feePercentNum) / 100 + feeFixedNum,
        );
        const feeAmount =
          !isCredit && (feePercentNum > 0 || feeFixedNum > 0)
            ? Math.min(txTotal, computedFeeAmount)
            : 0;

        if (acctOn) {
          // : both cash and credit sales book the full sale journal on the POS
          // transaction (Dr cash/AR · Cr revenue/tax + Dr COGS · Cr inventory). For
          // credit, debitAcct is Accounts Receivable, so the GL carries the
          // receivable + revenue once, here. The auto-issued invoice below owns the
          // *operational* receivable (amountOutstanding) and the accrual
          // RevenueEvent — it posts no GL of its own, so there is no double posting.
          // Pelunasan later credits AR (Dr cash · Cr AR), netting the receivable to 0.
          const lines = buildPosSaleJournalLines({
            number,
            debitAcct: debitAcct!,
            revenueAcct: revenueAcct!,
            taxAcct,
            inventoryAcct,
            cogsAcct,
            shippingRevenueAcct: accts.SHIPPING_REVENUE,
            salesDiscountAcct: accts.SALES_DISCOUNT,
            feeAcct,
            feeAmount,
            roundingGainAcct,
            roundingLossAcct,
            roundingAmount,
            txTotal,
            txSubtotal,
            txDiscount,
            txTax,
            txShipping,
            totalCogs,
          });

          await postJournalEntry({
            organizationId: ctx.organizationId,
            date: createdTransaction.createdAt,
            description: isCredit
              ? `POS Credit Sale - ${number}`
              : `POS Sale - ${number}`,
            referenceType: "POSTransaction",
            referenceId: createdTransaction.id,
            createdBy: ctx.userId,
            lines,
            tx,
          });
        }

        // : auto-issue an invoice for credit sales — the invoice OWNS the
        // operational receivable (amountOutstanding) and emits the INVOICE_SENT
        // RevenueEvent (accrual ledger). The GL revenue + AR are posted above on
        // the POS transaction (Dr AR · Cr Sales), so transitionInvoiceToSent posts
        // no GL here — no double posting. Created inside this tx so a credit sale
        // can never commit without its invoice. Works with accounting off.
        let createdInvoice: { id: string; invoiceNumber: string } | null = null;
        if (isCredit) {
          const invoiceItems = createdTransaction.items.map((it) => {
            const quantity = Number(it.quantity);
            const unitPrice = Number(it.unitPrice);
            const discountAmount = Number(it.discountAmount);
            const lineGross = quantity * unitPrice;
            const discountPercent =
              lineGross > 0
                ? Math.min(100, Math.max(0, (discountAmount / lineGross) * 100))
                : Number(it.discountPercent);

            return {
              description: it.product?.name || "Item",
              discount: discountPercent,
              discountPercent,
              discountAmount,
              quantity,
              unitPrice,
            };
          });
          createdInvoice = await createInvoice(
            ctx.organizationId,
            ctx.userId,
            {
              contactId: createdTransaction.customerId ?? undefined,
              items: invoiceItems,
              grandTotalOverride: txTotal,
              dueDate: createdTransaction.dueDate
                ? createdTransaction.dueDate.toISOString()
                : undefined,
              notes: `Auto-invoice POS ${number}`,
              posTransactionId: createdTransaction.id,
            },
            tx,
            { emitSideEffects: false },
          );
          await transitionInvoiceToSent({
            invoiceId: createdInvoice.id,
            organizationId: ctx.organizationId,
            db: tx,
          });
        }

        // ─── : dual-ledger emit ─────────────────────────────────────────
        // RevenueEvent: economic value earned at completion. For credit, the
        // invoice's INVOICE_SENT event represents the revenue  — skip here
        // to avoid double-counting.
        if (!isCredit) {
          await recordRevenueAffectingChange({
            tx,
            organizationId: ctx.organizationId,
            source: "POS",
            sourceTable: "POSTransaction",
            sourceId: createdTransaction.id,
            eventType: "POS_COMPLETED",
            idempotencyKey: `POSTransaction:${createdTransaction.id}:POS_COMPLETED`,
            contactId: createdTransaction.customerId,
            storeId: createdTransaction.storeId,
            amount: createdTransaction.total,
            currency: "IDR",
            occurredAt: createdTransaction.createdAt,
            metadata: { paymentMethod: mappedPaymentMethod },
          });
        }

        // PaymentEvent: cash arrived now (instant-pay only). For CREDIT, no cash
        // is received yet — pelunasan flow emits POS_PIUTANG_PAID later.
        if (!isCredit) {
          await recordPaymentReceived({
            tx,
            organizationId: ctx.organizationId,
            source: "POS",
            sourceTable: "POSTransaction",
            sourceId: createdTransaction.id,
            eventType: "POS_INSTANT_PAID",
            idempotencyKey: `POSTransaction:${createdTransaction.id}:POS_INSTANT_PAID`,
            contactId: createdTransaction.customerId,
            storeId: createdTransaction.storeId,
            amount: createdTransaction.total,
            currency: "IDR",
            paymentMethod: mappedPaymentMethod,
            occurredAt: createdTransaction.createdAt,
          });
        }

        return {
          transaction: createdTransaction,
          totalCogs,
          invoice: createdInvoice,
        };
      });
    } catch (error) {
      console.error(
        `[v2/pos/transactions] Error ${isUpdate ? "updating" : "creating"} transaction for ${number}:`,
        error,
      );
      if (
        error instanceof Error &&
        error.message === POS_TRANSACTION_ALREADY_FINALIZED
      ) {
        return Response.json(
          {
            error: "TRANSACTION_ALREADY_FINALIZED",
            message: "Transaction was already completed or paid.",
          },
          { status: 409 },
        );
      }
      if (
        error instanceof Error &&
        error.message === POS_TRANSACTION_ITEMS_CHANGED
      ) {
        return Response.json(
          {
            error: "TRANSACTION_ITEMS_CHANGED",
            message: "Reload the waiter order before completing payment.",
          },
          { status: 409 },
        );
      }
      if (error instanceof PosInventoryError) {
        return Response.json(
          { error: error.message, ...error.details },
          { status: error.status },
        );
      }
      throw error;
    }
    const transaction = txResult.transaction;

    // Real-time marketplace stock push for the products this sale consumed. The
    // 15-min marketplace-stock-reconcile sweep is the backstop; this keeps linked
    // marketplace listings fresh on the high-frequency counter-sale path so we do
    // not oversell between sweeps. Fire-and-forget: a Redis/enqueue hiccup must
    // never fail an already-committed sale.
    const consumedProductIds = [
      ...new Set([
        ...consumptionPlans.map((p) => p.productId).filter(Boolean),
        ...preConsumedMovements.map((m) => m.productId).filter(Boolean),
      ]),
    ];
    if (consumedProductIds.length > 0) {
      void (async () => {
        const linkedProducts = await prisma.marketplaceProductLink.findMany({
          where: {
            organizationId: ctx.organizationId,
            productId: { in: consumedProductIds },
            status: "CONFIRMED",
            syncStock: true,
            integration: { isActive: true, provider: "SHOPEE" },
          },
          select: { productId: true },
          distinct: ["productId"],
        });
        const productIdsToSync = linkedProducts
          .map((link) => link.productId)
          .filter((productId): productId is string => Boolean(productId));
        if (productIdsToSync.length === 0) return;

        const { enqueueMarketplaceStockSync } = await import(
          "@/lib/marketplace/outbound"
        );
        await Promise.all(
          productIdsToSync.map((productId) =>
            enqueueMarketplaceStockSync(ctx.organizationId, productId),
          ),
        );
      })().catch((err) =>
        console.error("[pos] marketplace stock sync enqueue failed:", err),
      );
    }

    // KDS routing. Resumed waiter orders are already routed when the waiter
    // creates the pending order; payment finalization must not enqueue a second
    // kitchen ticket.
    if (!isUpdate) {
      try {
        const stations = await prisma.kDSStation.findMany({
          where: { organizationId: ctx.organizationId, isActive: true },
        });

        if (stations.length > 0) {
          const productIds = normalizedItems.map((i) => i.productId);
          const products = await prisma.product.findMany({
            where: {
              id: { in: productIds },
              organizationId: ctx.organizationId,
            },
            select: { id: true, name: true, category: true },
          });
          const productMap = new Map(products.map((p) => [p.id, p]));

          function findStation(category: string | null) {
            if (category) {
              const match = stations.find(
                (s) =>
                  s.categoryIds.length > 0 && s.categoryIds.includes(category),
              );
              if (match) return match;
            }
            return (
              stations.find((s) => s.isDefault) ||
              stations.find((s) => s.categoryIds.length === 0) ||
              null
            );
          }

          const stationItemsMap = new Map<string, any[]>();
          const transactionItemIds = transaction.items.map((i) => i.id);
          for (let idx = 0; idx < normalizedItems.length; idx++) {
            const normItem = normalizedItems[idx];
            const product = productMap.get(normItem.productId);
            const station = findStation(product?.category ?? null);
            const txItemId = transactionItemIds[idx];
            if (txItemId && station) {
              await prisma.pOSTransactionItem.updateMany({
                where: { id: txItemId, transactionId: transaction.id },
                data: {
                  kdsStationId: station.id,
                  kdsStatus: "QUEUED",
                  kdsQueuedAt: now,
                },
              });
              if (!stationItemsMap.has(station.id))
                stationItemsMap.set(station.id, []);
              stationItemsMap.get(station.id)!.push({
                id: txItemId,
                productId: normItem.productId,
                productName: product?.name ?? "",
                quantity: normItem.quantity,
                notes: normItem.note ?? null,
              });
            }
          }

          if (stationItemsMap.size > 0) {
            const pub = getRedis();
            try {
              for (const [
                stationId,
                stationItems,
              ] of stationItemsMap.entries()) {
                await pub.publish(
                  `kds:${ctx.organizationId}:${stationId}`,
                  JSON.stringify({
                    type: "ticket",
                    transactionId: transaction.id,
                    number,
                    tableId: tableId ?? null,
                    items: stationItems,
                  }),
                );
              }
            } finally {
              await pub.quit();
            }
          }
        }
      } catch (kdsErr) {
        console.error(
          `[v2/pos/transactions] KDS routing error for ${number}:`,
          kdsErr,
        );
      }
    }

    const totalCogs = txResult.totalCogs;

    // Auto-earn loyalty points
    let loyaltyPointsEarned = 0;
    let loyaltyNewBalance: number | null = null;

    if (explicitCustomerId && totalNum > 0) {
      try {
        const loyaltyProgram = await prisma.loyaltyProgram.findFirst({
          where: { organizationId: ctx.organizationId, isActive: true },
          include: { tiers: { orderBy: { minPoints: "desc" } } },
        });

        if (loyaltyProgram) {
          let loyaltyCard = await prisma.loyaltyCard.findFirst({
            where: {
              programId: loyaltyProgram.id,
              contactId: explicitCustomerId,
              isActive: true,
            },
          });

          if (!loyaltyCard) {
            const cardId = uuidv7();
            loyaltyCard = await prisma.loyaltyCard.create({
              data: {
                id: cardId,
                number: `LC-${cardId.slice(0, 8).toUpperCase()}`,
                organizationId: ctx.organizationId,
                programId: loyaltyProgram.id,
                contactId: explicitCustomerId,
                cardNumber: `LC${Date.now().toString().slice(-8)}`,
                points: 0,
                lifetimePoints: 0,
                totalSpent: 0,
                isActive: true,
              },
            });
          }

          let multiplier = 1;
          if (
            loyaltyProgram.tierEnabled &&
            loyaltyCard.currentTier &&
            loyaltyProgram.tiers.length > 0
          ) {
            const tierMatch = loyaltyProgram.tiers.find(
              (t) => t.name === loyaltyCard!.currentTier,
            );
            if (tierMatch) multiplier = Number(tierMatch.multiplier);
          }

          const txAmount = totalNum;
          const pointsEarned = Math.floor(
            txAmount * Number(loyaltyProgram.pointsPerIDR) * multiplier,
          );

          if (pointsEarned > 0) {
            const newPoints = loyaltyCard.points + pointsEarned;
            const newLifetime = loyaltyCard.lifetimePoints + pointsEarned;
            const newTotalSpent = Number(loyaltyCard.totalSpent) + txAmount;

            let newTier = loyaltyCard.currentTier;
            if (loyaltyProgram.tierEnabled && loyaltyProgram.tiers.length > 0) {
              const eligibleTier = loyaltyProgram.tiers.find(
                (t) => newLifetime >= t.minPoints,
              );
              if (eligibleTier) newTier = eligibleTier.name;
            }

            await prisma.$transaction([
              prisma.loyaltyCard.updateMany({
                where: {
                  id: loyaltyCard.id,
                  organizationId: ctx.organizationId,
                  contactId: explicitCustomerId,
                  isActive: true,
                },
                data: {
                  points: newPoints,
                  lifetimePoints: newLifetime,
                  totalSpent: newTotalSpent,
                  currentTier: newTier ?? undefined,
                },
              }),
              prisma.loyaltyTransaction.create({
                data: {
                  id: uuidv7(),
                  cardId: loyaltyCard.id,
                  type: "EARN",
                  points: pointsEarned,
                  balanceAfter: newPoints,
                  posTransactionId: transaction.id,
                  notes: `Earned from POS sale ${number}`,
                },
              }),
            ]);

            loyaltyPointsEarned = pointsEarned;
            loyaltyNewBalance = newPoints;
          }
        }
      } catch (loyaltyErr) {
        console.error(
          `[v2/pos/transactions] Loyalty earn error for ${number}:`,
          loyaltyErr,
        );
      }
    }

    fireNotificationEvent(
      ctx.organizationId,
      WEBHOOK_EVENTS.POS_TRANSACTION_COMPLETED,
      {
        id: transaction.id,
        short_code: number,
        total: Number(transaction.total),
        payment_method: transaction.paymentMethod,
        createdBy: ctx.userId,
      },
    ).catch(() => {});

    return Response.json(
      { transaction, number, loyaltyPointsEarned, loyaltyNewBalance },
      { status: 201 },
    );
  });

  return withCors(req, response);
}
