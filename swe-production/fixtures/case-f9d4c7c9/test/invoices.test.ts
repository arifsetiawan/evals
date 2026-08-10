import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoiceCreate: vi.fn(async (args) => args.data),
  findFirstContact: vi.fn(async () => ({ id: 'contact-1', name: 'Test Contact' })),
  findFirstCrmAccount: vi.fn(async () => null),
  findFirstSalesOrder: vi.fn(async () => null),
  findUnavailableCatalogItemIds: vi.fn(async () => []),
  generateResourceCode: vi.fn(async () => 'INV-001'),
  logActivity: vi.fn(async () => undefined),
  dispatchWebhookEvent: vi.fn(() => undefined),
  fireNotificationEvent: vi.fn(async () => undefined),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    invoice: { create: mocks.invoiceCreate },
    contact: { findFirst: mocks.findFirstContact },
    crmAccount: { findFirst: mocks.findFirstCrmAccount },
    salesOrder: { findFirst: mocks.findFirstSalesOrder },
  },
}));

vi.mock('@/lib/catalog/catalogItem', () => ({
  findUnavailableCatalogItemIds: mocks.findUnavailableCatalogItemIds,
}));

vi.mock('@/lib/identifierGenerator', () => ({
  generateResourceCode: mocks.generateResourceCode,
}));

vi.mock('@/lib/utils/timezone', () => ({
  formatDateField: (date: Date | string | null | undefined) => date,
  formatLocalDate: (date: Date | string | null | undefined) => date,
  getOrgToday: () => new Date('2026-08-04T00:00:00.000Z'),
  parseDateField: (value: string | Date | null | undefined) => (value ? new Date(value) : null),
}));

vi.mock('@/lib/utils/org-timezone', () => ({
  getOrgTimezone: vi.fn(async () => 'Asia/Jakarta'),
}));

vi.mock('@/lib/invoicing/invoiceNumber', () => ({
  draftInvoiceNumber: (number: string) => `DRAFT-${number}`,
}));

vi.mock('@/lib/money/currency', () => ({
  parseCurrency: (currency: string | null | undefined, options?: { fallback?: string }) => currency || options?.fallback || 'IDR',
}));

vi.mock('@/lib/finance/requestDocumentVoid', () => ({
  requestDocumentVoid: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/lib/invoicing/invoiceLedgerEmit', () => ({
  transitionInvoiceToSent: vi.fn(async () => undefined),
  transitionInvoiceToPaid: vi.fn(async () => undefined),
}));

vi.mock('@/lib/audit', () => ({
  logActivity: mocks.logActivity,
}));

vi.mock('@/lib/api/webhook-delivery', () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}));

vi.mock('@/lib/api/webhook-events', () => ({
  WEBHOOK_EVENTS: {
    INVOICE_CREATED: 'invoice.created',
    INVOICE_PAID: 'invoice.paid',
    INVOICE_UPDATED: 'invoice.updated',
  },
}));

vi.mock('@/lib/notifications/rule-engine', () => ({
  fireNotificationEvent: mocks.fireNotificationEvent,
}));

import { createInvoice } from '../src/invoices';

describe('createInvoice with 0 total', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates invoice with empty payment terms if grandTotal is 0', async () => {
    // 1 item with price 0 -> totalAmount 0
    const invoiceData = {
      contactId: 'contact-1',
      items: [
        {
          quantity: 1,
          unitPrice: 0,
          discount: 0,
          tax: 0,
        },
      ],
      dueDate: '2026-08-04T12:00:00Z',
    };

    mocks.invoiceCreate.mockImplementation(async (args) => {
      // Return a simulated created invoice including the payment terms details
      return {
        id: args.data.id,
        totalAmount: args.data.totalAmount,
        paymentTerms: args.data.paymentTerms?.create || [],
      };
    });

    const result = await createInvoice('org-1', 'user-1', invoiceData);

    expect(result.totalAmount).toBe(0);
    // paymentTerms should be empty since grandTotal <= 0
    const paymentTerms0 = (result as any).paymentTerms;
    expect(paymentTerms0).toEqual([]);
    expect(mocks.invoiceCreate).toHaveBeenCalled();
  });

  it('creates invoice with default payment terms if grandTotal is positive', async () => {
    const invoiceData = {
      contactId: 'contact-1',
      items: [
        {
          quantity: 1,
          unitPrice: 10000,
          discount: 0,
          tax: 0,
        },
      ],
      dueDate: '2026-08-04T12:00:00Z',
    };

    mocks.invoiceCreate.mockImplementation(async (args) => {
      return {
        id: args.data.id,
        totalAmount: args.data.totalAmount,
        paymentTerms: args.data.paymentTerms?.create || [],
      };
    });

    const result = await createInvoice('org-1', 'user-1', invoiceData);

    expect(result.totalAmount).toBe(10000);
    const paymentTerms1 = (result as any).paymentTerms;
    expect(paymentTerms1).toHaveLength(1);
    expect(paymentTerms1[0].amount).toBe(10000);
  });
});
