import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { uuidv7 } from 'uuidv7';
import { calculateCommercialLines, totalsToNumber } from '@/lib/money';
import { addUnitCostSnapshots } from '@/lib/inventory/itemCostSnapshot';
import { applySalesOrderStock, InsufficientStockError } from '@/lib/sales/stock';
import { createInvoice } from '@/lib/services/invoices';
import { transitionInvoiceToSent } from '@/lib/invoicing/invoiceLedgerEmit';
import { syncSalesOrderItems } from 'database/lib/salesOrderItemsWrite.js';

type OrderInvoiceSummary = {
  id: string;
  invoiceNumber: string | null;
  number: string | null;
  status: string;
  totalAmount: number | string | null;
};

const INVOICE_TOTAL_EXCLUDED_STATUSES = new Set(['CANCELLED', 'VOID']);

// GET /api/sales/orders/[id] — fetch a single sales order
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;

    const order = await (prisma.salesOrder as any).findFirst({
      where: { id, organizationId: session.user.organizationId, deletedAt: null },
      include: {
        contact: { select: { id: true, name: true, email: true, phoneNumber: true, creditTermDays: true } },
        account: { select: { id: true, name: true, creditTermDays: true } },
        accountUnit: { select: { id: true, name: true, creditTermDays: true } },
        invoices: {
          where: { deletedAt: null },
          select: { id: true, invoiceNumber: true, number: true, status: true, totalAmount: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        },
        deliveryOrders: {
          where: { deletedAt: null },
          select: { id: true, number: true, status: true, items: true, deliveryDate: true, deliveredAt: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        },
        lines: {
          select: { id: true, productId: true, variantId: true, description: true, sku: true, unit: true, quantity: true, unitPrice: true, discountPercent: true, taxPercent: true, total: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // Reconstruct the line shape the order page reads (it indexes lines
    // positionally via DeliveryOrder.soItemIndex, so sortOrder order matters).
    const items = (order.lines ?? []).map((l: any) => ({
      id: l.id,
      productId: l.productId,
      variantId: l.variantId,
      name: l.description,
      description: l.description,
      sku: l.sku,
      unit: l.unit,
      quantity: Number(l.quantity),
      unitPrice: Number(l.unitPrice),
      discount: Number(l.discountPercent),
      tax: Number(l.taxPercent),
      total: Number(l.total),
    }));
    const allInvoices: OrderInvoiceSummary[] = Array.isArray(order.invoices) ? order.invoices : [];
    const invoicedTotal = allInvoices
      .filter((inv) => !INVOICE_TOTAL_EXCLUDED_STATUSES.has(inv.status))
      .reduce((sum, inv) => sum + Number(inv.totalAmount || 0), 0);
    // Keep convertedInvoice for backward compat (first/latest invoice)
    const convertedInvoice = allInvoices.length > 0 ? allInvoices[0] : null;
    return NextResponse.json({
      id: order.id,
      number: order.number,
      orderNumber: order.number,
      contactId: order.contactId,
      contactName: order.contact?.name ?? null,
      contactEmail: order.contact?.email ?? null,
      contactPhone: order.contact?.phoneNumber ?? null,
      accountId: order.accountId ?? null,
      accountName: order.account?.name ?? null,
      accountUnitId: order.accountUnitId ?? null,
      accountUnitName: order.accountUnit?.name ?? null,
      // Customer payment term for invoice defaults (unit -> account -> contact).
      creditTermDays: order.accountUnit?.creditTermDays ?? order.account?.creditTermDays ?? order.contact?.creditTermDays ?? null,
      leadId: order.leadId ?? null,
      quoteId: order.quoteId ?? null,
      status: order.status,
      items,
      itemCount: items.length,
      subtotal: Number(order.subtotal),
      taxTotal: Number(order.taxTotal),
      discountTotal: Number(order.discountTotal),
      shippingCost: Number(order.shippingCost ?? 0),
      grandTotal: Number(order.grandTotal),
      currency: order.currency,
      shippingAddress: order.shippingAddress ?? null,
      expectedDelivery: order.expectedDelivery ? order.expectedDelivery.toISOString() : null,
      metadata: order.metadata ?? null,
      notes: order.notes ?? null,
      convertedInvoice: convertedInvoice
        ? {
            id: convertedInvoice.id,
            number: convertedInvoice.invoiceNumber || convertedInvoice.number,
            status: convertedInvoice.status,
          }
        : null,
      invoices: allInvoices.map((inv: any) => ({
        id: inv.id,
        number: inv.invoiceNumber || inv.number,
        status: inv.status,
        totalAmount: Number(inv.totalAmount || 0),
      })),
      invoicedTotal,
      remainingTotal: Number(order.grandTotal) - invoicedTotal,
      deliveryOrders: (Array.isArray(order.deliveryOrders) ? order.deliveryOrders : []).map((d: any) => ({
        id: d.id,
        number: d.number,
        status: d.status,
        items: Array.isArray(d.items) ? d.items : [],
        deliveryDate: d.deliveryDate?.toISOString() ?? null,
        deliveredAt: d.deliveredAt?.toISOString() ?? null,
        createdAt: d.createdAt.toISOString(),
      })),
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error('[sales/orders/[id] GET] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH /api/sales/orders/[id] — update status
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;
    const body = await req.json();

    const order = await (prisma.salesOrder as any).findFirst({
      where: { id, organizationId: session.user.organizationId, deletedAt: null },
      include: {
        contact: { select: { creditTermDays: true } },
        account: { select: { creditTermDays: true } },
        accountUnit: { select: { creditTermDays: true } },
      },
    });

    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    const updateData: Record<string, any> = { updatedBy: session.user.id };
    if (body.status) updateData.status = body.status;
    if (body.notes !== undefined) updateData.notes = body.notes;
    if (body.shippingAddress !== undefined) updateData.shippingAddress = body.shippingAddress;
    // Order date is stored as createdAt (matching the POST route's parsedOrderDate).
    if (body.orderDate) {
      const parsedOrderDate = new Date(body.orderDate);
      if (!isNaN(parsedOrderDate.getTime())) updateData.createdAt = parsedOrderDate;
    }

    // Line items are editable only while the order is still a Draft. Recalculate
    // totals server-side so the stored figures always match the items.
    if (body.items !== undefined) {
      if (order.status !== 'DRAFT') {
        return NextResponse.json({ error: 'Items can only be edited while the order is in Draft' }, { status: 400 });
      }
      const orderDiscountAmt = Math.max(0, Number(body.orderDiscount) || 0);
      const shippingCostAmt = Math.max(0, Number(body.shippingCost) || 0);
      const ppnRateNum = Math.max(0, Number(body.ppnRate) || 0);
      const prepared = await addUnitCostSnapshots({
        db: prisma,
        organizationId: session.user.organizationId,
        items: (Array.isArray(body.items) ? body.items : []).map((it: any) => ({ id: it.id || uuidv7(), ...it })),
      });
      const calculated = calculateCommercialLines(prepared, {
        orderDiscount: orderDiscountAmt,
        shippingCost: shippingCostAmt,
        applyPpn: ppnRateNum > 0,
        ppnRate: ppnRateNum,
      });
      const totals = totalsToNumber(calculated);
      updateData.items = calculated.items;
      updateData.subtotal = totals.subtotal;
      updateData.discountTotal = totals.discountTotal;
      updateData.taxTotal = (totals.taxTotal || 0) + (totals.ppnAmount || 0);
      updateData.shippingCost = shippingCostAmt;
      updateData.grandTotal = totals.grandTotal;
      updateData.metadata = {
        ...(order.metadata && typeof order.metadata === 'object' ? order.metadata : {}),
        orderDiscount: orderDiscountAmt,
        ppnRate: ppnRateNum,
        ppnAmount: totals.ppnAmount || 0,
      };
    }

    const orgIdForStock = session.user.organizationId;
    const becameConfirmed = body.status === 'CONFIRMED' && order.status !== 'CONFIRMED';
    const becameDelivered = body.status === 'DELIVERED' && order.status !== 'DELIVERED';
    // Persist the change and sync stock in ONE transaction so an oversell on a
    // deduct transition (CONFIRMED/PROCESSING/SHIPPED/DELIVERED/COMPLETED) rolls
    // the status change back instead of leaving a committed order with no stock
    // or required receivable invoice.
    // Idempotent (gated by net OUT−IN), so it also catches direct jumps like
    // DRAFT→DELIVERED that the old CONFIRMED-only check missed.
    let updated: any = null;
    let stockOut = 0;
    let stockIn = 0;
    let invoiceId: string | null = null;
    try {
      await prisma.$transaction(async (tx) => {
        await (tx.salesOrder as any).updateMany({
          where: { id, organizationId: orgIdForStock, deletedAt: null },
          data: updateData,
        });
        updated = await (tx.salesOrder as any).findFirst({
          where: { id, organizationId: orgIdForStock, deletedAt: null },
        });
        if (!updated) throw new Error('SO_NOT_FOUND');
        //  dual-write. Unconditional: an edit that only reorders or drops
        // a line still has to converge, and this path writes through `as any`, so
        // a missed row would surface as nothing at all.
        await syncSalesOrderItems(tx, updated, uuidv7);
        if (body.status && body.status !== order.status) {
          const res = await applySalesOrderStock({
            organizationId: orgIdForStock,
            orderId: id,
            orderNumber: updated.number,
            items: updated.items,
            oldStatus: order.status,
            newStatus: body.status,
            userId: session.user.id!,
            db: tx,
          });
          stockOut = res.stockOut;
          stockIn = res.stockIn;
        }

        // Auto-invoice per the org's sales invoicing policy. On the matching
        // status transition, generate the SO's invoice once and send it so the
        // sale is tracked as a receivable (piutang). This is intentionally in
        // the same transaction as the status + stock writes: if invoice creation,
        // issue-journal posting, or the RevenueEvent emit fails, the SO status
        // rolls back instead of leaving a delivered/confirmed order off-ledger.
        if (becameConfirmed || becameDelivered) {
          const org = await tx.organization.findUnique({
            where: { id: orgIdForStock },
            select: { salesInvoicePolicy: true, defaultCreditTermDays: true } as any,
          });
          const policy = (org as any)?.salesInvoicePolicy ?? 'ON_DELIVERY';
          const policyFires =
            (policy === 'ON_DELIVERY' && becameDelivered) ||
            (policy === 'ON_CONFIRM' && becameConfirmed);
          if (policyFires) {
            if (!updated.contactId && !updated.accountId) {
              throw new Error('SO_AUTO_INVOICE_CUSTOMER_REQUIRED');
            }

            const existingInvoice = await tx.invoice.findFirst({
              where: {
                salesOrderId: id,
                organizationId: orgIdForStock,
                deletedAt: null,
                status: { notIn: ['CANCELLED', 'VOID'] as any },
              },
              select: { id: true },
            });
            if (existingInvoice) {
              invoiceId = existingInvoice.id;
              return;
            }

            const invoiceItems = (Array.isArray(updated.items) ? (updated.items as any[]) : [])
              .map((it) => ({
                description: it.name || it.description || 'Item',
                quantity: Number(it.quantity) || 0,
                unitPrice: Number(it.unitPrice ?? it.price) || 0,
                discount: Number(it.discount ?? 0) || 0,
                tax: Number(it.tax ?? 0) || 0,
              }))
              .filter((it) => it.quantity > 0);
            if (invoiceItems.length === 0) {
              throw new Error('SO_AUTO_INVOICE_ITEMS_REQUIRED');
            }

            const rawTermDays = order.accountUnit?.creditTermDays
              ?? order.account?.creditTermDays
              ?? order.contact?.creditTermDays
              ?? (org as any)?.defaultCreditTermDays
              ?? 7;
            const termDays = Number.isInteger(Number(rawTermDays)) && Number(rawTermDays) >= 0
              ? Number(rawTermDays)
              : 7;
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + termDays);
            const created = await createInvoice(
              orgIdForStock,
              session.user.id!,
              {
                contactId: updated.contactId ?? undefined,
                accountId: updated.accountId ?? undefined,
                accountUnitId: updated.accountUnitId ?? undefined,
                salesOrderId: id,
                items: invoiceItems,
                // Force the invoice total to match the SO grand total exactly
                // (covers order-level discount, shipping, and tax).
                grandTotalOverride: Number(updated.grandTotal) || undefined,
                dueDate: dueDate.toISOString(),
                notes: `Auto-invoice SO ${updated.number}`,
              },
              tx,
              { emitSideEffects: false },
            );
            await transitionInvoiceToSent({
              invoiceId: created.id,
              organizationId: orgIdForStock,
              actorId: session.user.id!,
              db: tx,
            });
            invoiceId = created.id;
          }
        }
      });
    } catch (e) {
      if (e instanceof InsufficientStockError) {
        return NextResponse.json({ error: e.message, available: e.available }, { status: 400 });
      }
      if (e instanceof Error && e.message === 'SO_NOT_FOUND') {
        return NextResponse.json({ error: 'Order not found' }, { status: 404 });
      }
      if (e instanceof Error && e.message === 'SO_AUTO_INVOICE_CUSTOMER_REQUIRED') {
        return NextResponse.json({ error: 'Sales invoicing policy requires a customer/account before confirming or delivering this order' }, { status: 400 });
      }
      if (e instanceof Error && e.message === 'SO_AUTO_INVOICE_ITEMS_REQUIRED') {
        return NextResponse.json({ error: 'Sales invoicing policy requires at least one billable item before confirming or delivering this order' }, { status: 400 });
      }
      throw e;
    }

    return NextResponse.json({ id: updated.id, status: updated.status, stockOut, stockIn, invoiceId });
  } catch (error) {
    console.error('[sales/orders/[id] PATCH] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
