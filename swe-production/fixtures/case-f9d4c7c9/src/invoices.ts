import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import type { InvoiceLineItemInput } from '@/lib/invoicing/lineItem';
import { logActivity } from '@/lib/audit';
import { dispatchWebhookEvent } from '@/lib/api/webhook-delivery';
import { WEBHOOK_EVENTS } from '@/lib/api/webhook-events';
import { fireNotificationEvent } from '@/lib/notifications/rule-engine';
import { formatDateField, formatLocalDate, getOrgToday, parseDateField } from '@/lib/utils/timezone';
import { getOrgTimezone } from '@/lib/utils/org-timezone';
import { generateResourceCode } from '@/lib/identifierGenerator';
import { draftInvoiceNumber } from '@/lib/invoicing/invoiceNumber';
import { parseCurrency } from '@/lib/money/currency';
import { requestDocumentVoid } from '@/lib/finance/requestDocumentVoid';
import {
  transitionInvoiceToSent,
  transitionInvoiceToPaid,
} from '@/lib/invoicing/invoiceLedgerEmit';
import { findUnavailableCatalogItemIds } from '@/lib/catalog/catalogItem';

export interface ListInvoicesInput {
  organizationId: string;
  page?: number;
  perPage?: number;
  status?: string;
}

export interface ListResult<T> {
  data: T[];
  meta: { page: number; perPage: number; total: number; totalPages: number };
}

export async function listInvoices(input: ListInvoicesInput): Promise<ListResult<any>> {
  const timezone = await getOrgTimezone(input.organizationId);
  const today = getOrgToday(timezone);
  const page = input.page || 1;
  const perPage = Math.min(input.perPage || 25, 100);
  const skip = (page - 1) * perPage;

  const where: any = {
    organizationId: input.organizationId,
    deletedAt: null,
  };
  if (input.status) where.status = input.status;

  const [invoiceRows, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: {
        contact: { select: { id: true, name: true, email: true, phoneNumber: true, npwp: true } },
        // : Invoice.order relation removed. salesOrderId stays for B2B-derived invoices;
        // standalone invoices have it null. Caller surfaces no longer expose orderNumber.
        paymentTerms: { orderBy: { sequence: 'asc' } },
        payments: { orderBy: { paidAt: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: perPage,
    }),
    prisma.invoice.count({ where }),
  ]);

  const data = invoiceRows.map((inv) => {
    const items = (inv.items as any[]) || [];
    const subtotal = items.reduce((sum: number, item: any) => {
      return sum + Number(item.quantity || 0) * Number(item.unitPrice || 0);
    }, 0);
    const taxTotal = items.reduce((sum: number, item: any) => {
      const qty = Number(item.quantity || 0);
      const price = Number(item.unitPrice || 0);
      const disc = Number(item.discount || 0);
      const tax = Number(item.tax || 0);
      const afterDisc = qty * price * (1 - disc / 100);
      return sum + afterDisc * (tax / 100);
    }, 0);
    const discountTotal = items.reduce((sum: number, item: any) => {
      const qty = Number(item.quantity || 0);
      const price = Number(item.unitPrice || 0);
      const disc = Number(item.discount || 0);
      return sum + qty * price * (disc / 100);
    }, 0);
    const grandTotal = Number(inv.totalAmount);
    const paidAmount = inv.payments.reduce((sum: number, payment: any) => sum + Number(payment.amount), 0);
    const dueAmount = Math.max(0, grandTotal - paidAmount);

    let displayStatus = inv.status;
    if (inv.status === 'SENT' && inv.dueDate && inv.dueDate < today) {
      displayStatus = 'OVERDUE' as any;
    }

    const meta = (inv.metadata as any) || {};
    const ppnAmount = meta.ppnAmount ? Number(meta.ppnAmount) : 0;

    return {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      contactId: inv.contactId,
      contactName: inv.contact?.name || 'Unknown',
      contactEmail: inv.contact?.email || null,
      contactNpwp: inv.contact?.npwp || null,
      // : orderId/orderNumber removed (generic Order dropped). Use salesOrderId for B2B linkage.
      salesOrderId: inv.salesOrderId,
      status: displayStatus,
      items,
      subtotal,
      taxTotal,
      discountTotal,
      ppnAmount,
      applyPpn: meta.applyPpn ?? ppnAmount > 0,
      grandTotal,
      paidAmount,
      dueAmount,
      issueDate: inv.createdAt.toISOString(),
      dueDate: inv.dueDate?.toISOString() || null,
      paidDate: inv.paidAt?.toISOString() || null,
      notes: inv.notes,
      paymentTerms: inv.paymentTerms.map((term: any) => ({
        id: term.id,
        sequence: term.sequence,
        label: term.label,
        amount: Number(term.amount),
        paidAmount: Number(term.paidAmount),
        dueAmount: Math.max(0, Number(term.amount) - Number(term.paidAmount)),
        dueDate: term.dueDate?.toISOString() || null,
        status: term.status,
      })),
      payments: inv.payments.map((payment: any) => ({
        id: payment.id,
        invoiceId: payment.invoiceId,
        termId: payment.termId,
        amount: Number(payment.amount),
        method: payment.paymentMethod,
        reference: payment.reference,
        notes: payment.notes,
        paidAt: payment.paidAt.toISOString(),
        createdAt: payment.createdAt.toISOString(),
      })),
      createdAt: inv.createdAt.toISOString(),
      updatedAt: inv.updatedAt.toISOString(),
    };
  });

  return {
    data,
    meta: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
  };
}

export async function getInvoice(organizationId: string, id: string) {
  const inv = await prisma.invoice.findFirst({
    where: { id, organizationId, deletedAt: null },
    include: {
      contact: { select: { id: true, name: true, email: true, phoneNumber: true, npwp: true } },
      // : Invoice.order relation removed.
      paymentTerms: { orderBy: { sequence: 'asc' } },
      payments: { orderBy: { paidAt: 'desc' } },
    },
  });
  return inv || null;
}

export interface CreateInvoiceData {
  contactId?: string;
  contactName?: string;
  accountId?: string;
  accountUnitId?: string;
  orderId?: string;
  salesOrderId?: string; // link the invoice to its source Sales Order (B2B linkage / auto-invoice)
  posTransactionId?: string; // : link to source POS credit sale
  grandTotalOverride?: number; // : force total to match an already-totalled source (POS)
  //  Phase 2 — canonical line contract. `catalogItemId`/`source`/`sourceId`/
  // `sessionId` let the generic invoice service bill any non-inventory sellable
  // (class, service, …) and stamp its provenance for revenue-by-sellable reporting.
  items: InvoiceLineItemInput[];
  dueDate?: string;
  notes?: string;
  terms?: string;
  applyPpn?: boolean;
  ppnRate?: number;
  paymentTerms?: Array<{
    label?: string;
    amount: number;
    dueDate?: string;
  }>;
}

export async function createInvoice(
  organizationId: string,
  userId: string,
  data: CreateInvoiceData,
  // : pass an interactive-transaction client to create the invoice atomically
  // with its source (e.g. a POS credit sale). Defaults to the global prisma.
  db: Prisma.TransactionClient | typeof prisma = prisma,
  options: { emitSideEffects?: boolean } = {},
) {
  const hasContactInput = (typeof data.contactId === 'string' && data.contactId.trim() !== '')
    || (typeof data.contactName === 'string' && data.contactName.trim() !== '');
  const hasAccountInput = typeof data.accountId === 'string' && data.accountId.trim() !== '';
  if (!hasContactInput && !hasAccountInput) {
    throw new Error('contactId/contactName or accountId is required');
  }
  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw new Error('At least one item is required');
  }
  for (const item of data.items) {
    if (typeof item.quantity !== 'number' || item.quantity <= 0) {
      throw new Error('Item quantity must be a positive number');
    }
    if (typeof item.unitPrice !== 'number' || item.unitPrice < 0) {
      throw new Error('Item unit price cannot be negative');
    }
  }
  const unavailableCatalogItemIds = await findUnavailableCatalogItemIds(
    organizationId,
    data.items,
    db,
  );
  if (unavailableCatalogItemIds.length > 0) {
    throw new Error('Catalog item not found or inactive');
  }

  // Resolve contact
  let contact: { id: string; name: string | null; email: string | null; companyId?: string | null; accountUnitId?: string | null } | null = null;
  if (data.contactId) {
    contact = await db.contact.findFirst({
      where: { id: data.contactId, organizationId, deletedAt: null },
      select: { id: true, name: true, email: true, companyId: true, accountUnitId: true },
    });
  } else if (data.contactName) {
    contact = await db.contact.findFirst({
      where: { organizationId, deletedAt: null, name: { contains: data.contactName, mode: 'insensitive' } },
      select: { id: true, name: true, email: true, companyId: true, accountUnitId: true },
    });
  }
  if (hasContactInput && !contact) {
    throw new Error('Contact not found');
  }
  let accountId = data.accountId ?? contact?.companyId ?? null;
  let accountUnitId = data.accountUnitId ?? contact?.accountUnitId ?? null;
  if (accountId) {
    const account = await db.crmAccount.findFirst({
      where: { id: accountId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!account) {
      throw new Error('Account not found');
    }
  }
  if (accountUnitId) {
    const accountUnit = await db.crmAccountUnit.findFirst({
      where: {
        id: accountUnitId,
        organizationId,
        deletedAt: null,
        ...(accountId ? { accountId } : {}),
      },
      select: { id: true, accountId: true },
    });
    if (!accountUnit) {
      throw new Error('Account unit not found');
    }
    accountId = accountId ?? accountUnit.accountId;
    accountUnitId = accountUnit.id;
  }
  if (data.salesOrderId) {
    const salesOrder = await db.salesOrder.findFirst({
      where: { id: data.salesOrderId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!salesOrder) {
      throw new Error('Sales order not found');
    }
  }

  // Calculate totals
  let subtotal = 0;
  let taxTotal = 0;
  let discountTotal = 0;

  const processedItems = data.items.map((item: any) => {
    const itemSubtotal = item.quantity * item.unitPrice;
    const itemDiscount = itemSubtotal * ((item.discount || 0) / 100);
    const itemTax = (itemSubtotal - itemDiscount) * ((item.tax || 0) / 100);
    const itemTotal = itemSubtotal - itemDiscount + itemTax;

    subtotal += itemSubtotal;
    discountTotal += itemDiscount;
    taxTotal += itemTax;

    return { id: uuidv7(), ...item, total: itemTotal };
  });

  const afterDiscount = subtotal - discountTotal;
  const resolvedPpnRate = data.applyPpn && Number.isFinite(Number(data.ppnRate)) ? Number(data.ppnRate) : 0;
  const ppnAmount = data.applyPpn ? afterDiscount * resolvedPpnRate : 0;
  // : when an invoice mirrors an already-totalled source (POS sale), the
  // authoritative total is the source total — order-level discount/tax/shipping
  // don't round-trip through line items. Override keeps invoice AR == sale total.
  const grandTotal = Number.isFinite(Number(data.grandTotalOverride))
    ? Number(data.grandTotalOverride)
    : afterDiscount + taxTotal + ppnAmount;
  const paymentTerms = Array.isArray(data.paymentTerms) && data.paymentTerms.length > 0
    ? data.paymentTerms.map((term, index) => ({
        sequence: index + 1,
        label: term.label?.trim() || `Payment ${index + 1}`,
        amount: Number(term.amount),
        dueDate: term.dueDate || data.dueDate,
      }))
    : [
        {
          sequence: 1,
          label: 'Full payment',
          amount: grandTotal,
          dueDate: data.dueDate,
        },
      ];
  const paymentTermsTotal = paymentTerms.reduce((sum, term) => sum + term.amount, 0);
  if (paymentTerms.some(term => !Number.isFinite(term.amount) || term.amount <= 0)) {
    throw new Error('Payment term amounts must be positive numbers');
  }
  if (Math.abs(paymentTermsTotal - grandTotal) > 0.01) {
    throw new Error('Payment terms must add up to the invoice total');
  }

  // : the internal id follows IDENTIFIER.md; the customer-facing number
  // is NOT taken here. The invoice is created DRAFT, and a draft that is later
  // discarded must not burn a sequence value — `transitionInvoiceToSent` takes
  // the real number at issue.
  const number = await generateResourceCode(organizationId, 'INV', { client: db });
  const invoiceNumber = draftInvoiceNumber(number);
  const invoiceId = uuidv7();

  const invoice = await db.invoice.create({
    data: {
      id: invoiceId,
      number,
      invoiceNumber,
      posTransactionId: data.posTransactionId ?? null,
      organization: { connect: { id: organizationId } },
      ...(contact ? { contact: { connect: { id: contact.id } } } : {}),
      ...(accountId ? { account: { connect: { id: accountId } } } : {}),
      ...(accountUnitId ? { accountUnit: { connect: { id: accountUnitId } } } : {}),
      // : Invoice.order relation removed (generic Order dropped). Use salesOrderId for B2B linkage.
      ...(data.salesOrderId ? { salesOrder: { connect: { id: data.salesOrderId } } } : {}),
      status: 'DRAFT',
      items: processedItems,
      totalAmount: grandTotal,
      notes: data.notes || null,
      metadata: {
        subtotal,
        taxTotal,
        discountTotal,
        ppnAmount,
        applyPpn: !!data.applyPpn,
        ppnRate: resolvedPpnRate,
        terms: data.terms || null,
        createdById: userId,
      },
      dueDate: parseDateField(data.dueDate),
      paymentTerms: {
        create: paymentTerms.map((term) => ({
          id: uuidv7(),
          organization: { connect: { id: organizationId } },
          sequence: term.sequence,
          label: term.label,
          amount: term.amount,
          dueDate: parseDateField(term.dueDate),
        })),
      },
    },
    include: {
      contact: { select: { id: true, name: true, email: true } },
      account: { select: { id: true, name: true } },
      accountUnit: { select: { id: true, name: true } },
    },
  });

  if (options.emitSideEffects !== false) {
    await logActivity({
      organizationId,
      userId,
      actionType: 'CREATE',
      targetModel: 'Invoice',
      targetId: invoice.id,
      details: { invoiceNumber: invoice.invoiceNumber, status: invoice.status, grandTotal },
    });

    dispatchWebhookEvent(organizationId, WEBHOOK_EVENTS.INVOICE_CREATED, {
      id: invoice.id,
      invoice_number: invoice.invoiceNumber,
      contact_id: invoice.contactId,
      account_id: invoice.accountId,
      grand_total: grandTotal,
      status: invoice.status,
    });

    fireNotificationEvent(organizationId, WEBHOOK_EVENTS.INVOICE_CREATED, {
      id: invoice.id,
      invoice_number: invoice.invoiceNumber,
      invoiceNumber: invoice.invoiceNumber,
      contact_id: invoice.contactId,
      account_id: invoice.accountId,
      grand_total: grandTotal,
      amount: grandTotal,
      status: invoice.status,
      createdBy: userId,
    }).catch(() => {});
  }

  return invoice;
}

export interface UpdateInvoiceData {
  status?: string;
  reason?: string | null;
}

export async function updateInvoice(
  organizationId: string,
  userId: string,
  id: string,
  data: UpdateInvoiceData
) {
  if (data.status === 'CANCELLED' || data.status === 'VOID') {
    const result = await requestDocumentVoid({
      organizationId,
      userId,
      targetModel: 'Invoice',
      targetId: id,
      reason: data.reason ?? null,
    });
    if (!result.ok) throw new Error(result.error);
    return result;
  }
  const validStatuses = ['DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'];
  if (data.status && !validStatuses.includes(data.status)) {
    throw new Error('Invalid status');
  }

  const existing = await prisma.invoice.findFirst({
    where: { id, organizationId, deletedAt: null },
  });
  if (!existing) {
    throw new Error('Invoice not found');
  }

  const updateData: Record<string, unknown> = {};
  if (data.status) {
    updateData.status = data.status;
    if (data.status === 'PAID') {
      updateData.paidAt = new Date();
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (data.status === 'SENT') {
      await transitionInvoiceToSent({ invoiceId: id, organizationId, db: tx });
    } else if (data.status === 'PAID') {
      await transitionInvoiceToPaid({
        invoiceId: id,
        organizationId,
        paymentMethod: 'BANK_TRANSFER',
        paidAt: (updateData.paidAt as Date) ?? new Date(),
        db: tx,
      });
    } else {
      await tx.invoice.update({
        where: { id },
        data: updateData,
      });
    }

    return tx.invoice.findUniqueOrThrow({ where: { id } });
  });

  await logActivity({
    organizationId,
    userId,
    actionType: 'UPDATE',
    targetModel: 'Invoice',
    targetId: id,
    details: { status: data.status, invoiceNumber: updated.invoiceNumber },
  });

  if (data.status === 'PAID') {
    dispatchWebhookEvent(organizationId, WEBHOOK_EVENTS.INVOICE_PAID, {
      id: updated.id,
      invoice_number: updated.invoiceNumber,
      contact_id: updated.contactId,
      grand_total: Number(updated.totalAmount),
      paid_at: updated.paidAt?.toISOString(),
    });

    fireNotificationEvent(organizationId, WEBHOOK_EVENTS.INVOICE_PAID, {
      id: updated.id,
      invoice_number: updated.invoiceNumber,
      invoiceNumber: updated.invoiceNumber,
      contact_id: updated.contactId,
      grand_total: Number(updated.totalAmount),
      amount: Number(updated.totalAmount),
      paid_at: updated.paidAt?.toISOString(),
      status: 'PAID',
      createdBy: userId,
    }).catch(() => {});
  } else if (data.status) {
    dispatchWebhookEvent(organizationId, WEBHOOK_EVENTS.INVOICE_UPDATED, {
      id: updated.id,
      invoice_number: updated.invoiceNumber,
      contact_id: updated.contactId,
      grand_total: Number(updated.totalAmount),
      status: updated.status,
    });

    fireNotificationEvent(organizationId, WEBHOOK_EVENTS.INVOICE_UPDATED, {
      id: updated.id,
      invoice_number: updated.invoiceNumber,
      invoiceNumber: updated.invoiceNumber,
      contact_id: updated.contactId,
      grand_total: Number(updated.totalAmount),
      amount: Number(updated.totalAmount),
      status: updated.status,
      createdBy: userId,
    }).catch(() => {});
  }

  return updated;
}

export async function deleteInvoice(
  organizationId: string,
  userId: string,
  id: string
) {
  const existing = await prisma.invoice.findFirst({
    where: { id, organizationId, deletedAt: null },
  });
  if (!existing) {
    throw new Error('Invoice not found');
  }
  if (existing.status !== 'DRAFT') {
    throw new Error('Only draft invoices can be deleted. Void issued invoices instead.');
  }

  await prisma.invoice.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  await logActivity({
    organizationId,
    userId,
    actionType: 'DELETE',
    targetModel: 'Invoice',
    targetId: id,
    details: { invoiceNumber: existing.invoiceNumber },
  });

  return { success: true };
}

export function formatPublicInvoice(invoice: any) {
  const items = (invoice.items as any[]) || [];
  const subtotal = items.reduce((sum: number, item: any) => {
    return sum + Number(item.quantity || 0) * Number(item.unitPrice || 0);
  }, 0);
  const taxTotal = items.reduce((sum: number, item: any) => {
    const qty = Number(item.quantity || 0);
    const price = Number(item.unitPrice || 0);
    const discount = Number(item.discount || 0);
    const tax = Number(item.tax || 0);
    const afterDiscount = qty * price * (1 - discount / 100);
    return sum + afterDiscount * (tax / 100);
  }, 0);
  const discountTotal = items.reduce((sum: number, item: any) => {
    return sum + Number(item.quantity || 0) * Number(item.unitPrice || 0) * (Number(item.discount || 0) / 100);
  }, 0);
  const grandTotal = Number(invoice.totalAmount);
  const paidAmount = Array.isArray(invoice.payments)
    ? invoice.payments.reduce((sum: number, payment: any) => sum + Number(payment.amount), 0)
    : invoice.paidAt ? grandTotal : 0;
  const dueAmount = Math.max(0, grandTotal - paidAmount);

  let displayStatus = invoice.status;
  if (invoice.status === 'SENT' && invoice.dueDate && invoice.dueDate < new Date()) {
    displayStatus = 'OVERDUE';
  }

  return {
    id: invoice.id,
    invoice_number: invoice.invoiceNumber,
    short_code: invoice.number,
    contact_id: invoice.contactId,
    contact_name: invoice.contact?.name || null,
    contact_email: invoice.contact?.email || null,
    account_id: invoice.accountId ?? null,
    account_name: invoice.account?.name ?? null,
    account_unit_id: invoice.accountUnitId ?? null,
    account_unit_name: invoice.accountUnit?.name ?? null,
    order_id: null,
    status: displayStatus,
    items,
    subtotal,
    tax_total: taxTotal,
    discount_total: discountTotal,
    grand_total: grandTotal,
    paid_amount: paidAmount,
    due_amount: dueAmount,
    currency: invoice.currency,
    issue_date: invoice.createdAt.toISOString(),
    due_date: formatDateField(invoice.dueDate),
    paid_date: invoice.paidAt?.toISOString() || null,
    notes: invoice.notes,
    created_at: invoice.createdAt.toISOString(),
    updated_at: invoice.updatedAt.toISOString(),
  };
}

const PUBLIC_INVOICE_INCLUDE = {
  contact: { select: { id: true, name: true, email: true } },
  account: { select: { id: true, name: true } },
  accountUnit: { select: { id: true, name: true } },
  payments: { where: { voidedAt: null }, select: { amount: true } },
} as const;

export async function listPublicInvoices(input: {
  organizationId: string;
  page: number;
  perPage: number;
  status?: string | null;
  contactId?: string | null;
  accountUnitId?: string | null;
}) {
  const where: Record<string, unknown> = {
    organizationId: input.organizationId,
    deletedAt: null,
  };
  if (input.status) where.status = input.status;
  if (input.contactId) where.contactId = input.contactId;
  if (input.accountUnitId) where.accountUnitId = input.accountUnitId;

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: PUBLIC_INVOICE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip: (input.page - 1) * input.perPage,
      take: input.perPage,
    }),
    prisma.invoice.count({ where }),
  ]);

  return { data: invoices.map(formatPublicInvoice), total };
}

async function resolvePublicInvoiceAccountContext(
  organizationId: string,
  input: {
    contactId: string;
    accountId?: string | null;
    accountUnitId?: string | null;
  }
) {
  const contact = await prisma.contact.findFirst({
    where: { id: input.contactId, organizationId, deletedAt: null },
    select: { id: true, companyId: true, accountUnitId: true },
  });
  if (!contact) throw new Error('Contact not found');

  let accountId = input.accountId || contact.companyId || null;
  let accountUnitId = input.accountUnitId || contact.accountUnitId || null;

  if (accountId) {
    const account = await prisma.crmAccount.findFirst({
      where: { id: accountId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!account) throw new Error('Account not found');
  }

  if (accountUnitId) {
    const unit = await prisma.crmAccountUnit.findFirst({
      where: {
        id: accountUnitId,
        organizationId,
        deletedAt: null,
        ...(accountId ? { accountId } : {}),
      },
      select: { id: true, accountId: true },
    });
    if (!unit) throw new Error('Account unit not found');
    if (accountId && unit.accountId !== accountId) {
      throw new Error('Account unit does not belong to the selected account');
    }
    accountId = accountId || unit.accountId;
    accountUnitId = unit.id;
  }

  return { accountId, accountUnitId };
}

export async function createPublicInvoice(
  organizationId: string,
  apiKeyId: string,
  data: {
    contactId: string;
    accountId?: string | null;
    accountUnitId?: string | null;
    items: Array<any>;
    dueDate?: string | null;
    notes?: string | null;
    currency?: string;
  }
) {
  const currency = parseCurrency(data.currency, { fallback: 'IDR' });
  const accountContext = await resolvePublicInvoiceAccountContext(organizationId, {
    contactId: data.contactId,
    accountId: data.accountId,
    accountUnitId: data.accountUnitId,
  });

  for (const item of data.items) {
    if (typeof item.quantity !== 'number' || item.quantity <= 0) {
      throw new Error('Item quantity must be a positive number');
    }
    if (typeof item.unitPrice !== 'number' || item.unitPrice < 0) {
      throw new Error('Item unitPrice cannot be negative');
    }
  }
  const unavailableCatalogItemIds = await findUnavailableCatalogItemIds(organizationId, data.items);
  if (unavailableCatalogItemIds.length > 0) {
    throw new Error('Catalog item not found or inactive');
  }

  let subtotal = 0;
  let taxTotal = 0;
  let discountTotal = 0;
  const processedItems = data.items.map((item) => {
    const itemSubtotal = item.quantity * item.unitPrice;
    const itemDiscount = itemSubtotal * ((item.discount || 0) / 100);
    const itemTax = (itemSubtotal - itemDiscount) * ((item.tax || 0) / 100);
    const itemTotal = itemSubtotal - itemDiscount + itemTax;
    subtotal += itemSubtotal;
    discountTotal += itemDiscount;
    taxTotal += itemTax;
    return { id: uuidv7(), ...item, total: itemTotal };
  });
  const grandTotal = subtotal - discountTotal + taxTotal;
  const invoiceId = uuidv7();
  const invoiceInternalNumber = await generateResourceCode(organizationId, 'INV');

  const invoice = await prisma.invoice.create({
    data: {
      id: invoiceId,
      number: invoiceInternalNumber,
      // : real number is taken at issue, not here — see createInvoice above.
      invoiceNumber: draftInvoiceNumber(invoiceInternalNumber),
      organization: { connect: { id: organizationId } },
      contact: { connect: { id: data.contactId } },
      ...(accountContext.accountId ? { account: { connect: { id: accountContext.accountId } } } : {}),
      ...(accountContext.accountUnitId ? { accountUnit: { connect: { id: accountContext.accountUnitId } } } : {}),
      status: 'DRAFT',
      items: processedItems,
      totalAmount: grandTotal,
      currency,
      notes: data.notes || null,
      metadata: {
        subtotal,
        taxTotal,
        discountTotal,
        createdByApiKey: apiKeyId,
      },
      dueDate: parseDateField(data.dueDate),
      paymentTerms: {
        create: {
          id: uuidv7(),
          organization: { connect: { id: organizationId } },
          sequence: 1,
          label: 'Full payment',
          amount: grandTotal,
          dueDate: parseDateField(data.dueDate),
        },
      },
    },
    include: PUBLIC_INVOICE_INCLUDE,
  });

  return formatPublicInvoice(invoice);
}

export async function getPublicInvoice(organizationId: string, id: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id, organizationId, deletedAt: null },
    include: PUBLIC_INVOICE_INCLUDE,
  });
  return invoice ? formatPublicInvoice(invoice) : null;
}

async function resolvePublicApiActor(organizationId: string, apiKeyId: string) {
  const apiKey = await prisma.apiKey.findFirst({
    where: { id: apiKeyId, organizationId, deletedAt: null, isActive: true },
    select: { createdBy: true },
  });
  const creatorMembership = apiKey
    ? await prisma.userOrganization.findFirst({
        where: { organizationId, userId: apiKey.createdBy, isActive: true },
        select: { userId: true },
      })
    : null;
  const fallbackMembership = creatorMembership
    ? null
    : await prisma.userOrganization.findFirst({
        where: { organizationId, isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { userId: true },
      });
  return creatorMembership?.userId || fallbackMembership?.userId || null;
}

export async function updatePublicInvoice(
  organizationId: string,
  id: string,
  data: {
    status?: string;
    notes?: string | null;
    dueDate?: string | null;
    apiKeyId?: string;
  }
) {
  if (data.status === 'CANCELLED' || data.status === 'VOID') {
    if (!data.apiKeyId) {
      throw new Error('API key actor is required to request invoice void approval');
    }
    const actorUserId = await resolvePublicApiActor(organizationId, data.apiKeyId);
    if (!actorUserId) {
      throw new Error('No active user is available to request invoice void approval');
    }
    const result = await requestDocumentVoid({
      organizationId,
      userId: actorUserId,
      targetModel: 'Invoice',
      targetId: id,
      reason: data.notes ?? null,
    });
    if (!result.ok) {
      if (result.status === 404) return null;
      throw new Error(result.error);
    }
    return result;
  }

  const existing = await prisma.invoice.findFirst({
    where: { id, organizationId, deletedAt: null },
  });
  if (!existing) return null;

  const updateData: Record<string, unknown> = {};
  if (data.status) {
    updateData.status = data.status;
    if (data.status === 'PAID') updateData.paidAt = new Date();
  }
  if (data.notes !== undefined) updateData.notes = data.notes;
  if (data.dueDate !== undefined) updateData.dueDate = parseDateField(data.dueDate);

  const updated = await prisma.$transaction(async (tx) => {
    if (data.status === 'SENT') {
      await transitionInvoiceToSent({ invoiceId: id, organizationId, db: tx });
    } else if (data.status === 'PAID') {
      await transitionInvoiceToPaid({
        invoiceId: id,
        organizationId,
        paymentMethod: 'BANK_TRANSFER',
        paidAt: (updateData.paidAt as Date) ?? new Date(),
        db: tx,
      });
    } else {
      await tx.invoice.update({
        where: { id },
        data: updateData,
      });
    }

    if (data.status === 'SENT' || data.status === 'PAID') {
      const postTransitionData: Record<string, unknown> = {};
      if (data.notes !== undefined) postTransitionData.notes = data.notes;
      if (data.dueDate !== undefined) postTransitionData.dueDate = parseDateField(data.dueDate);
      if (Object.keys(postTransitionData).length > 0) {
        await tx.invoice.update({
          where: { id },
          data: postTransitionData,
        });
      }
    }

    return tx.invoice.findUniqueOrThrow({
      where: { id },
      include: PUBLIC_INVOICE_INCLUDE,
    });
  });

  return formatPublicInvoice(updated);
}

export async function deletePublicInvoice(organizationId: string, id: string) {
  const existing = await prisma.invoice.findFirst({
    where: { id, organizationId, deletedAt: null },
  });
  if (!existing) return null;
  if (existing.status !== 'DRAFT') {
    throw new Error('Only draft invoices can be deleted. Void issued invoices instead.');
  }

  await prisma.invoice.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return { id, deleted: true };
}
