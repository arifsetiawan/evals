import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  salesOrderFindFirst: vi.fn(),
  transaction: vi.fn(),
  txSalesOrderUpdateMany: vi.fn(),
  txSalesOrderFindFirst: vi.fn(),
  txProductFindMany: vi.fn(),
  txSalesOrderItemDeleteMany: vi.fn(),
  txSalesOrderItemCreateMany: vi.fn(),
  txOrganizationFindUnique: vi.fn(),
  txInvoiceFindFirst: vi.fn(),
  applySalesOrderStock: vi.fn(),
  createInvoice: vi.fn(),
  transitionInvoiceToSent: vi.fn(),
}));

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/db', () => ({
  prisma: {
    salesOrder: { findFirst: mocks.salesOrderFindFirst },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/sales/stock', () => ({
  InsufficientStockError: class MockInsufficientStockError extends Error {
    constructor(public readonly productName: string, public readonly available: number) {
      super(`Insufficient stock for ${productName}`);
      this.name = 'InsufficientStockError';
    }
  },
  applySalesOrderStock: mocks.applySalesOrderStock,
}));
vi.mock('@/lib/services/invoices', () => ({ createInvoice: mocks.createInvoice }));
vi.mock('@/lib/invoicing/invoiceLedgerEmit', () => ({ transitionInvoiceToSent: mocks.transitionInvoiceToSent }));
vi.mock('@/lib/money', () => ({ calculateCommercialLines: vi.fn(), totalsToNumber: vi.fn() }));
vi.mock('@/lib/inventory/itemCostSnapshot', () => ({ addUnitCostSnapshots: vi.fn() }));
vi.mock('uuidv7', () => ({ uuidv7: () => 'uuid-1' }));

import { GET, PATCH } from '../src/[id]__route';

const tx = {
  salesOrder: {
    updateMany: mocks.txSalesOrderUpdateMany,
    findFirst: mocks.txSalesOrderFindFirst,
  },
  product: { findMany: mocks.txProductFindMany },
  salesOrderItem: {
    deleteMany: mocks.txSalesOrderItemDeleteMany,
    createMany: mocks.txSalesOrderItemCreateMany,
  },
  organization: { findUnique: mocks.txOrganizationFindUnique },
  invoice: { findFirst: mocks.txInvoiceFindFirst },
};

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/sales/orders/so-1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const params = { params: Promise.resolve({ id: 'so-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerSession.mockResolvedValue({ user: { id: 'user-1', organizationId: 'org-1' } });
  mocks.transaction.mockImplementation((cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));
  mocks.txSalesOrderUpdateMany.mockResolvedValue({ count: 1 });
  mocks.txProductFindMany.mockResolvedValue([]);
  mocks.txSalesOrderItemDeleteMany.mockResolvedValue({ count: 0 });
  mocks.txSalesOrderItemCreateMany.mockResolvedValue({ count: 1 });
  mocks.applySalesOrderStock.mockResolvedValue({ stockOut: 0, stockIn: 0 });
  mocks.txOrganizationFindUnique.mockResolvedValue({ salesInvoicePolicy: 'ON_DELIVERY', defaultCreditTermDays: 7 });
  mocks.txInvoiceFindFirst.mockResolvedValue(null);
  mocks.createInvoice.mockResolvedValue({ id: 'inv-1', invoiceNumber: 'INV-1' });
  mocks.transitionInvoiceToSent.mockResolvedValue({ updated: true });
});

describe('GET /api/sales/orders/[id]', () => {
  it('serializes relational SalesOrderItem rows with the legacy item shape', async () => {
    mocks.salesOrderFindFirst.mockResolvedValue({
      id: 'so-1',
      number: 'SO-1',
      organizationId: 'org-1',
      contactId: 'contact-1',
      contact: { id: 'contact-1', name: 'Acme', email: 'user@example.com', phoneNumber: '0812', creditTermDays: 14 },
      accountId: null,
      account: null,
      accountUnitId: null,
      accountUnit: null,
      leadId: null,
      quoteId: null,
      status: 'DRAFT',
      items: [{ id: 'json-line-1', description: 'Stale Json line', quantity: 99 }],
      lines: [{
        id: 'line-1',
        productId: 'product-1',
        variantId: 'variant-1',
        description: 'Relational line',
        sku: 'SKU-1',
        unit: 'pcs',
        quantity: 2,
        unitPrice: 12500,
        discountPercent: 5,
        taxPercent: 11,
        total: 26362.5,
      }],
      invoices: [],
      deliveryOrders: [],
      subtotal: 25000,
      taxTotal: 2612.5,
      discountTotal: 1250,
      shippingCost: 0,
      grandTotal: 26362.5,
      currency: 'IDR',
      shippingAddress: null,
      expectedDelivery: null,
      metadata: null,
      notes: null,
      createdAt: new Date('2026-07-20T01:00:00.000Z'),
      updatedAt: new Date('2026-07-20T01:30:00.000Z'),
    });

    const res = await GET(new NextRequest('http://localhost/api/sales/orders/so-1'), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items).toEqual([{
      id: 'line-1',
      productId: 'product-1',
      variantId: 'variant-1',
      name: 'Relational line',
      description: 'Relational line',
      sku: 'SKU-1',
      unit: 'pcs',
      quantity: 2,
      unitPrice: 12500,
      discount: 5,
      tax: 11,
      total: 26362.5,
    }]);
    expect(body.itemCount).toBe(1);
  });

  it('excludes void and cancelled invoices from invoiced and remaining totals', async () => {
    mocks.salesOrderFindFirst.mockResolvedValue({
      id: 'so-1',
      number: 'SO-1',
      organizationId: 'org-1',
      contactId: 'contact-1',
      contact: { id: 'contact-1', name: 'Acme', email: null, phoneNumber: null, creditTermDays: null },
      accountId: null,
      account: null,
      accountUnitId: null,
      accountUnit: null,
      leadId: null,
      quoteId: null,
      status: 'CONFIRMED',
      lines: [],
      invoices: [
        { id: 'inv-valid', invoiceNumber: 'INV-1', number: 'INV-1', status: 'SENT', totalAmount: 40000, createdAt: new Date('2026-07-20T03:00:00.000Z') },
        { id: 'inv-void', invoiceNumber: 'INV-2', number: 'INV-2', status: 'VOID', totalAmount: 25000, createdAt: new Date('2026-07-20T02:00:00.000Z') },
        { id: 'inv-cancelled', invoiceNumber: 'INV-3', number: 'INV-3', status: 'CANCELLED', totalAmount: 35000, createdAt: new Date('2026-07-20T01:00:00.000Z') },
      ],
      deliveryOrders: [],
      subtotal: 100000,
      taxTotal: 0,
      discountTotal: 0,
      shippingCost: 0,
      grandTotal: 100000,
      currency: 'IDR',
      shippingAddress: null,
      expectedDelivery: null,
      metadata: null,
      notes: null,
      createdAt: new Date('2026-07-20T01:00:00.000Z'),
      updatedAt: new Date('2026-07-20T01:30:00.000Z'),
    });

    const res = await GET(new NextRequest('http://localhost/api/sales/orders/so-1'), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.invoicedTotal).toBe(40000);
    expect(body.remainingTotal).toBe(60000);
    expect(body.invoices).toEqual([
      expect.objectContaining({ id: 'inv-valid', status: 'SENT', totalAmount: 40000 }),
      expect.objectContaining({ id: 'inv-void', status: 'VOID', totalAmount: 25000 }),
      expect.objectContaining({ id: 'inv-cancelled', status: 'CANCELLED', totalAmount: 35000 }),
    ]);
  });
});

describe('PATCH /api/sales/orders/[id]', () => {
  it('creates and sends the required auto-invoice inside the status transaction using the updated SO row', async () => {
    mocks.salesOrderFindFirst.mockResolvedValue({
      id: 'so-1',
      number: 'SO-1',
      status: 'DRAFT',
      contactId: 'contact-1',
      accountId: null,
      accountUnitId: null,
      items: [{ name: 'Old item', quantity: 1, unitPrice: 100 }],
      grandTotal: 100,
      contact: { creditTermDays: 3 },
      account: null,
      accountUnit: null,
    });
    mocks.txSalesOrderFindFirst.mockResolvedValue({
      id: 'so-1',
      number: 'SO-1',
      status: 'DELIVERED',
      contactId: 'contact-1',
      accountId: null,
      accountUnitId: null,
      items: [{ name: 'Updated item', quantity: 2, unitPrice: 250 }],
      grandTotal: 500,
    });

    const res = await PATCH(req({ status: 'DELIVERED' }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.invoiceId).toBe('inv-1');
    expect(mocks.txSalesOrderItemDeleteMany).toHaveBeenCalledWith({ where: { salesOrderId: 'so-1' } });
    expect(mocks.txSalesOrderItemCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          salesOrderId: 'so-1',
          sortOrder: 0,
          description: 'Updated item',
          quantity: 2,
          unitPrice: 250,
        }),
      ],
    });
    expect(mocks.createInvoice).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      expect.objectContaining({
        contactId: 'contact-1',
        salesOrderId: 'so-1',
        grandTotalOverride: 500,
        items: [expect.objectContaining({ description: 'Updated item', quantity: 2, unitPrice: 250 })],
      }),
      tx,
      { emitSideEffects: false },
    );
    expect(mocks.transitionInvoiceToSent).toHaveBeenCalledWith({
      invoiceId: 'inv-1',
      organizationId: 'org-1',
      actorId: 'user-1',
      db: tx,
    });
  });

  it('preserves a zero grand total override for fully discounted sales order auto-invoices', async () => {
    mocks.salesOrderFindFirst.mockResolvedValue({
      id: 'so-1',
      number: 'SO-1',
      status: 'DRAFT',
      contactId: 'contact-1',
      accountId: null,
      accountUnitId: null,
      items: [{ name: 'Old item', quantity: 1, unitPrice: 100 }],
      grandTotal: 100,
      contact: { creditTermDays: 3 },
      account: null,
      accountUnit: null,
    });
    mocks.txSalesOrderFindFirst.mockResolvedValue({
      id: 'so-1',
      number: 'SO-1',
      status: 'DELIVERED',
      contactId: 'contact-1',
      accountId: null,
      accountUnitId: null,
      items: [{ name: 'Fully discounted item', quantity: 1, unitPrice: 100, discount: 100 }],
      grandTotal: 0,
    });

    const res = await PATCH(req({ status: 'DELIVERED' }), params);

    expect(res.status).toBe(200);
    expect(mocks.createInvoice).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      expect.objectContaining({
        salesOrderId: 'so-1',
        grandTotalOverride: 0,
        items: [expect.objectContaining({ description: 'Fully discounted item', quantity: 1, unitPrice: 100, discount: 100 })],
      }),
      tx,
      { emitSideEffects: false },
    );
  });

  it('rejects a policy-triggering status change when there is no bill-to customer/account', async () => {
    mocks.salesOrderFindFirst.mockResolvedValue({
      id: 'so-1',
      number: 'SO-1',
      status: 'DRAFT',
      contactId: null,
      accountId: null,
      accountUnitId: null,
      items: [{ name: 'Item', quantity: 1, unitPrice: 100 }],
      grandTotal: 100,
      contact: null,
      account: null,
      accountUnit: null,
    });
    mocks.txSalesOrderFindFirst.mockResolvedValue({
      id: 'so-1',
      number: 'SO-1',
      status: 'DELIVERED',
      contactId: null,
      accountId: null,
      accountUnitId: null,
      items: [{ name: 'Item', quantity: 1, unitPrice: 100 }],
      grandTotal: 100,
    });

    const res = await PATCH(req({ status: 'DELIVERED' }), params);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('requires a customer/account');
    expect(mocks.createInvoice).not.toHaveBeenCalled();
    expect(mocks.transitionInvoiceToSent).not.toHaveBeenCalled();
  });
});
