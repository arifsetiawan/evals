import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type MockTransaction = {
  id: string;
  number: string;
  status: string;
  paymentStatus: string;
  sessionId: string;
  orderSource: string;
};

type MockTransactionItem = {
  id: string;
  productId: string;
  quantity: number;
  kdsStatus: string;
};

type MockConsumptionArgs = {
  requestedLines: Array<{ productId: string; quantity: number }>;
};

type MockConsumptionPlan = {
  productId: string;
  quantity: number;
  warehouseId: string;
  unitCost: number;
  productName: string;
};

// The POS-sale create path (POST /api/v2/pos/transactions) is the money-in
// front door for the counter. These tests lock down the two guards that must
// hold BEFORE any stock/GL/ledger write, plus one minimal cash happy path:
//   1. sessionId + items are required (no session, no sale)
//   2. the session lookup is org-scoped + status OPEN — a session from another
//      org (or a closed one) is 404, and nothing gets written
//   3. a minimal cash sale creates a POS transaction under the caller's org
// Only the ledger/journal machinery is stubbed; the assertions still fail if
// the validation, org-scoping, or create wiring regresses.

const mocks = vi.hoisted(() => ({
  PosInventoryError: class PosInventoryError extends Error {
    status: number;
    details: Record<string, unknown>;
    constructor(
      message: string,
      status = 400,
      details: Record<string, unknown> = {},
    ) {
      super(message);
      this.status = status;
      this.details = details;
    }
  },
  ctx: { userId: "user-1", organizationId: "org-1", app: "pos" },
  posSessionFindFirst: vi.fn(),
  posTxCreate: vi.fn(),
  posTxFindFirst: vi.fn(async (): Promise<MockTransaction | null> => null),
  posTxItemFindMany: vi.fn(async (): Promise<MockTransactionItem[]> => []),
  stockMovementFindMany: vi.fn(async () => []),
  posTxUpdateMany: vi.fn(async () => ({ count: 1 })),
  posTxFindFirstOrThrow: vi.fn(async () => ({})),
  posTxItemDeleteMany: vi.fn(async () => ({ count: 0 })),
  posTxItemCreateMany: vi.fn(async () => ({ count: 0 })),
  diningTableFindFirst: vi.fn(async () => null),
  orgPaymentMethodFindFirst: vi.fn(async () => ({ id: "pm-cash" })),
  contactFindFirst: vi.fn(async () => null),
  crmAccountFindFirst: vi.fn(async () => null),
  crmAccountUnitFindFirst: vi.fn(async () => null),
  kdsStationFindMany: vi.fn(async () => []),
  loyaltyProgramFindFirst: vi.fn(async () => null),
  transactionFn: vi.fn(),
  generateResourceCode: vi.fn(async () => "TXN-1"),
  buildPosConsumptionPlans: vi.fn(
    async (_args: MockConsumptionArgs): Promise<MockConsumptionPlan[]> => [],
  ),
  applyPosConsumptionPlans: vi.fn(async () => 0),
  releasePosReservationPlans: vi.fn(async () => undefined),
  resolvePaymentMethod: vi.fn(async () => ({
    methodCode: "CASH",
    cashAccountId: "acct-cash",
    feeAccountId: null,
    feePercent: 0,
    feeFixed: 0,
  })),
  normalizeMethodCode: vi.fn(() => "cash"),
  getOrgRoundingSettings: vi.fn(async () => ({
    posCashRoundingMode: "NONE",
    posCashRoundingIncrement: 0,
  })),
  calculatePosCashRounding: vi.fn((base: number) => ({
    total: Math.round(base * 100) / 100,
    amount: 0,
  })),
  findSystemAccounts: vi.fn(async () => ({ SALES_REVENUE: "acct-rev" })),
  hasChartOfAccounts: vi.fn(async () => false),
  getOrCreateWalkInContactId: vi.fn(async () => "walkin-1"),
}));

vi.mock("@/lib/api/appAuth", () => ({
  withAppAuth: (
    _req: unknown,
    cb: (ctx: typeof mocks.ctx) => Promise<Response>,
  ) => cb(mocks.ctx),
}));
vi.mock("@/lib/api/cors", () => ({
  handleCorsOptions: () => undefined,
  withCors: (_req: unknown, res: Response) => res,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    pOSSession: { findFirst: mocks.posSessionFindFirst },
    pOSTransaction: {
      create: mocks.posTxCreate,
      findFirst: mocks.posTxFindFirst,
      updateMany: mocks.posTxUpdateMany,
      findFirstOrThrow: mocks.posTxFindFirstOrThrow,
    },
    pOSTransactionItem: {
      findMany: mocks.posTxItemFindMany,
      deleteMany: mocks.posTxItemDeleteMany,
      createMany: mocks.posTxItemCreateMany,
    },
    stockMovement: {
      findMany: mocks.stockMovementFindMany,
    },
    diningTable: { findFirst: mocks.diningTableFindFirst },
    orgPaymentMethod: { findFirst: mocks.orgPaymentMethodFindFirst },
    contact: { findFirst: mocks.contactFindFirst },
    crmAccount: { findFirst: mocks.crmAccountFindFirst },
    crmAccountUnit: { findFirst: mocks.crmAccountUnitFindFirst },
    kDSStation: { findMany: mocks.kdsStationFindMany },
    loyaltyProgram: { findFirst: mocks.loyaltyProgramFindFirst },
    $transaction: mocks.transactionFn,
  },
}));

// Route-level imports stubbed so the module resolves; the guard tests never
// reach them and the happy path drives them through the mocks above.
vi.mock("@/lib/identifierGenerator", () => ({
  generateResourceCode: mocks.generateResourceCode,
}));
vi.mock("@/lib/accounting", () => ({
  postJournalEntry: vi.fn(),
  findSystemAccounts: mocks.findSystemAccounts,
}));
vi.mock("@/lib/accounting/accountingEnabled", () => ({
  hasChartOfAccounts: mocks.hasChartOfAccounts,
}));
vi.mock("@/lib/accounting/roundingThreshold", () => ({
  calculatePosCashRounding: mocks.calculatePosCashRounding,
  getOrgRoundingSettings: mocks.getOrgRoundingSettings,
}));
vi.mock("@/lib/utils/timezone", () => ({
  getDateOnlyRangeInTimeZone: vi.fn(() => ({
    start: new Date(),
    end: new Date(),
  })),
  getOrgToday: vi.fn(() => new Date()),
}));
vi.mock("@/lib/utils/warehouse", () => ({
  resolveStoreWarehouseIds: vi.fn(async () => []),
}));
vi.mock("@/lib/ledger/revenue-ledger", () => ({
  recordRevenueAffectingChange: vi.fn(),
}));
vi.mock("@/lib/ledger/payment-ledger", () => ({
  recordPaymentReceived: vi.fn(),
}));
vi.mock("@/lib/credit/accountUnits", () => ({
  resolveCustomerCredit: vi.fn(),
}));
vi.mock("@/lib/pos/journalLines", () => ({
  buildPosSaleJournalLines: vi.fn(() => []),
}));
vi.mock("@/lib/pos/walkInContact", () => ({
  getOrCreateWalkInContactId: mocks.getOrCreateWalkInContactId,
}));
vi.mock("@/lib/services/invoices", () => ({ createInvoice: vi.fn() }));
vi.mock("@/lib/invoicing/invoiceLedgerEmit", () => ({
  transitionInvoiceToSent: vi.fn(),
}));
vi.mock("@/lib/pos/inventoryConsumption", () => ({
  applyPosConsumptionPlans: mocks.applyPosConsumptionPlans,
  buildPosConsumptionPlans: mocks.buildPosConsumptionPlans,
  releasePosReservationPlans: mocks.releasePosReservationPlans,
  PosInventoryError: mocks.PosInventoryError,
}));
vi.mock("@/lib/payments/resolveMethodAccount", () => ({
  resolvePaymentMethod: mocks.resolvePaymentMethod,
}));
vi.mock("@/lib/payment-methods", () => ({
  normalizeMethodCode: mocks.normalizeMethodCode,
}));
vi.mock("@/lib/notifications/rule-engine", () => ({
  fireNotificationEvent: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/api/webhook-events", () => ({
  WEBHOOK_EVENTS: { POS_TRANSACTION_COMPLETED: "pos.completed" },
}));
vi.mock("ioredis", () => ({ default: class {} }));
vi.mock("uuidv7", () => ({ uuidv7: () => "uuid-1" }));

import { POST } from '../src/transactions__route';

function req(body: unknown = {}): NextRequest {
  return new NextRequest("http://localhost/api/v2/pos/transactions", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.diningTableFindFirst.mockResolvedValue(null);
  mocks.orgPaymentMethodFindFirst.mockResolvedValue({ id: "pm-cash" });
  mocks.contactFindFirst.mockResolvedValue(null);
  mocks.kdsStationFindMany.mockResolvedValue([]);
  mocks.loyaltyProgramFindFirst.mockResolvedValue(null);
  mocks.generateResourceCode.mockResolvedValue("TXN-1");
  mocks.buildPosConsumptionPlans.mockResolvedValue([]);
  mocks.applyPosConsumptionPlans.mockResolvedValue(0);
  mocks.releasePosReservationPlans.mockResolvedValue(undefined);
  mocks.normalizeMethodCode.mockReturnValue("cash");
  mocks.resolvePaymentMethod.mockResolvedValue({
    methodCode: "CASH",
    cashAccountId: "acct-cash",
    feeAccountId: null,
    feePercent: 0,
    feeFixed: 0,
  });
  mocks.getOrgRoundingSettings.mockResolvedValue({
    posCashRoundingMode: "NONE",
    posCashRoundingIncrement: 0,
  });
  mocks.calculatePosCashRounding.mockImplementation((base: number) => ({
    total: Math.round(base * 100) / 100,
    amount: 0,
  }));
  mocks.findSystemAccounts.mockResolvedValue({ SALES_REVENUE: "acct-rev" });
  mocks.hasChartOfAccounts.mockResolvedValue(false);
  mocks.getOrCreateWalkInContactId.mockResolvedValue("walkin-1");
  // $transaction runs the callback with a minimal tx that only needs create.
  mocks.transactionFn.mockImplementation(
    async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ pOSTransaction: { create: mocks.posTxCreate } }),
  );
});

describe("POST /api/v2/pos/transactions — POS sale create", () => {
  it("rejects (400) a request missing sessionId, with no session lookup or write", async () => {
    const res = await POST(
      req({ items: [{ productId: "p1", qty: 1, unitPrice: 10000 }] }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("sessionId and items are required");
    expect(mocks.posSessionFindFirst).not.toHaveBeenCalled();
    expect(mocks.transactionFn).not.toHaveBeenCalled();
    expect(mocks.posTxCreate).not.toHaveBeenCalled();
  });

  it("rejects (400) a request with empty items, with no session lookup or write", async () => {
    const res = await POST(req({ sessionId: "sess-1", items: [] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("items are required");
    expect(mocks.posSessionFindFirst).not.toHaveBeenCalled();
    expect(mocks.transactionFn).not.toHaveBeenCalled();
  });

  it("scopes the session lookup by org + OPEN status and returns 404 for a missing/other-org session, with no write", async () => {
    mocks.posSessionFindFirst.mockResolvedValue(null); // not found under org-1 / not OPEN
    const res = await POST(
      req({
        sessionId: "sess-other-org",
        items: [{ productId: "p1", qty: 1, unitPrice: 10000 }],
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found or closed");
    // The lookup must be constrained by the auth-context org and OPEN status.
    expect(mocks.posSessionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "sess-other-org",
          organizationId: "org-1",
          status: "OPEN",
        }),
      }),
    );
    // No sale / stock / journal writes.
    expect(mocks.transactionFn).not.toHaveBeenCalled();
    expect(mocks.posTxCreate).not.toHaveBeenCalled();
    expect(mocks.applyPosConsumptionPlans).not.toHaveBeenCalled();
  });

  it("creates a POS transaction under the caller org for a minimal cash sale (201)", async () => {
    mocks.posSessionFindFirst.mockResolvedValue({
      id: "sess-1",
      terminal: { storeId: null, warehouseId: null },
    });
    mocks.posTxCreate.mockImplementation(
      async (args: { data: Record<string, unknown> }) => ({
        id: "tx-1",
        number: "TXN-1",
        total: 10000,
        paymentMethod: "CASH",
        storeId: null,
        customerId: "walkin-1",
        createdAt: new Date("2026-07-01T00:00:00Z"),
        organizationId: args.data.organizationId,
        status: args.data.status,
        items: [{ id: "item-1", product: { id: "p1", name: "Kopi" } }],
      }),
    );

    const res = await POST(
      req({
        sessionId: "sess-1",
        items: [{ productId: "p1", qty: 1, unitPrice: 10000 }],
        paymentMethod: "cash",
        amountPaid: 10000,
        subtotal: 10000,
        total: 10000,
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.number).toBe("TXN-1");
    expect(body.transaction.id).toBe("tx-1");

    // The write happened inside a DB transaction, scoped to the caller's org.
    expect(mocks.transactionFn).toHaveBeenCalledTimes(1);
    expect(mocks.posTxCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.posTxCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArg.data.organizationId).toBe("org-1");
    expect(createArg.data.sessionId).toBe("sess-1");
    expect(createArg.data.status).toBe("COMPLETED");
    expect(createArg.data.paymentMethod).toBe("CASH");
    expect(createArg.data.total).toBe(10000);
  });

  it("finalizes a waiter-created transaction (isUpdate=true) and syncs modified items, releasing original reserved stocks", async () => {
    // Mock the session check
    mocks.posSessionFindFirst.mockResolvedValue({
      id: "sess-1",
      terminal: { storeId: null, warehouseId: null },
    });

    // Mock existing transaction lookup
    mocks.posTxFindFirst.mockResolvedValue({
      id: "tx-waiter-1",
      number: "TXN-WAITER-1",
      status: "PENDING",
      paymentStatus: "UNPAID",
      sessionId: "sess-floor-1",
      orderSource: "WAITER",
    });

    // Mock existing transaction items
    mocks.posTxItemFindMany.mockResolvedValue([
      { id: "item-waiter-1", productId: "p1", quantity: 1, kdsStatus: "NEW" },
      { id: "item-waiter-2", productId: "p2", quantity: 2, kdsStatus: "DONE" },
    ]);

    // Mock transaction updates
    mocks.posTxUpdateMany.mockResolvedValue({ count: 1 });
    mocks.posTxFindFirstOrThrow.mockResolvedValue({
      id: "tx-waiter-1",
      number: "TXN-WAITER-1",
      total: 50000,
      paymentMethod: "CASH",
      storeId: null,
      customerId: "walkin-1",
      createdAt: new Date("2026-07-01T00:00:00Z"),
      organizationId: "org-1",
      status: "COMPLETED",
      items: [],
    });

    // $transaction mock for update path
    const mockTxClient = {
      pOSTransaction: {
        findFirst: mocks.posTxFindFirst,
        updateMany: mocks.posTxUpdateMany,
        findFirstOrThrow: mocks.posTxFindFirstOrThrow,
      },
      pOSTransactionItem: {
        findMany: mocks.posTxItemFindMany,
        deleteMany: mocks.posTxItemDeleteMany,
        createMany: mocks.posTxItemCreateMany,
      },
      diningTable: { updateMany: mocks.diningTableFindFirst },
    };
    mocks.transactionFn.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => cb(mockTxClient)
    );

    // Mock consumption plans building
    mocks.buildPosConsumptionPlans.mockImplementation(async (args) => {
      // Return custom plan matching requestedLines
      return args.requestedLines.map((line: { productId: string; quantity: number }) => ({
        productId: line.productId,
        quantity: line.quantity,
        warehouseId: "wh-1",
        unitCost: 5000,
        productName: `Product ${line.productId}`,
      }));
    });

    const res = await POST(
      req({
        transactionId: "tx-waiter-1",
        sessionId: "sess-1", // POS session ID (ignored for sessionIdToUse, but passed in request)
        items: [
          { productId: "p1", qty: 4, unitPrice: 10000 }, // updated from 1 to 4
          { productId: "p2", qty: 2, unitPrice: 10000 }, // stays 2 (already DONE)
          { productId: "p3", qty: 1, unitPrice: 10000 }, // new item added
        ],
        paymentMethod: "cash",
        amountPaid: 70000,
        subtotal: 70000,
        total: 70000,
      }),
    );

    expect(res.status).toBe(201);

    // Assert that the original reserved lines (NEW items only) were resolved for release
    expect(mocks.buildPosConsumptionPlans).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedLines: expect.arrayContaining([
          { productId: "p1", quantity: 1 }
        ]),
      })
    );

    // Assert releasePosReservationPlans was called with the old reserved plan (productId: p1, quantity: 1)
    expect(mocks.releasePosReservationPlans).toHaveBeenCalledWith(
      expect.objectContaining({
        plans: expect.arrayContaining([
          expect.objectContaining({ productId: "p1", quantity: 1 })
        ]),
      })
    );

    // Only KDS-untouched items are replaced; an in-progress/ready/done line
    // keeps its kitchen identity and cannot be removed by checkout edits.
    expect(mocks.posTxItemDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          transactionId: "tx-waiter-1",
          kdsStatus: { in: ["NEW", "QUEUED"] },
        }),
      })
    );

    // The final stock check happens only after this order's reservation is
    // released inside the transaction. Added quantities therefore cannot
    // bypass availability checks, while the original hold remains usable.
    expect(mocks.buildPosConsumptionPlans).toHaveBeenLastCalledWith(
      expect.objectContaining({
        db: mockTxClient,
        bypassStockCheck: false,
      }),
    );

    // Assert new items were created with correct delta/request quantities
    // p1 = 4 total requested - 0 done = 4 new quantity
    // p2 = 2 total requested - 2 done = 0 (omitted from createMany)
    // p3 = 1 total requested - 0 done = 1 new quantity
    expect(mocks.posTxItemCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ productId: "p1", quantity: 4 }),
          expect.objectContaining({ productId: "p3", quantity: 1 }),
        ]),
      })
    );
  });

  it("does not let checkout remove an item already being prepared by KDS", async () => {
    mocks.posSessionFindFirst.mockResolvedValue({
      id: "sess-1",
      terminal: { storeId: null, warehouseId: null },
    });
    mocks.posTxFindFirst.mockResolvedValue({
      id: "tx-waiter-1",
      number: "TXN-WAITER-1",
      status: "PENDING",
      paymentStatus: "UNPAID",
      sessionId: "sess-floor-1",
      orderSource: "WAITER",
    });
    mocks.posTxItemFindMany.mockResolvedValue([
      { id: "item-1", productId: "p1", quantity: 2, kdsStatus: "IN_PROGRESS" },
    ]);

    const res = await POST(
      req({
        transactionId: "tx-waiter-1",
        sessionId: "sess-1",
        items: [{ productId: "p1", qty: 1, unitPrice: 10000 }],
        paymentMethod: "cash",
        amountPaid: 10000,
        subtotal: 10000,
        total: 10000,
      }),
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "KDS_ITEMS_CANNOT_BE_REMOVED",
      productId: "p1",
      lockedQty: 2,
      requestedQty: 1,
    });
    expect(mocks.transactionFn).not.toHaveBeenCalled();
    expect(mocks.posTxUpdateMany).not.toHaveBeenCalled();
  });
});
