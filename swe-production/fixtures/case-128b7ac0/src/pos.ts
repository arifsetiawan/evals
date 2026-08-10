/**
 * POS module adapter — AI tools for the POS module.
 *
 *  Slice 1: `create_inbox_order`, `list_stores`, `find_nearest_store`.
 * -02 (this slice):
 *   - Adds transaction reads (`list_pos_transactions`, `get_pos_transaction`,
 *     `get_daily_sales_summary`) and shift reads
 *     (`list_shifts`, `get_current_shift_summary`).
 *   - Inherits the four menu-analytics tools from the old resto adapter
 *     (`analyze_menu_performance`, `analyze_menu_profitability`,
 *     `get_menu_recommendations`, `analyze_sales_by_time`) — they query
 *     `POSTransaction`, the data lives here, not in resto.
 *
 * Org isolation: every read/write filters by `ctx.organizationId` (CLAUDE.md hard rule).
 */

import { uuidv7 } from 'uuidv7';
import { MCPAdapter, Tool, AdapterContext } from '../base';
import { generateResourceCode } from '../../identifierGenerator';
import { emitPosOrderEvent } from '../../events/posOrderEvents';
import { decryptCredentials } from '../../encryption';
import {
  computeReservationExpiry,
  readReservationPolicy,
  type StockReservationLine,
} from '../../lib/ai-inbox-reservation';

type InboxOrderItemInput = {
  name: string;
  productId?: string;
  quantity: number;
  unitPrice: number;
  unit?: string;
  notes?: string;
};

type StoreCoords = {
  latitude: number;
  longitude: number;
};

const EARTH_RADIUS_KM = 6371;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function haversineDistanceKm(a: StoreCoords, b: StoreCoords): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  return EARTH_RADIUS_KM * c;
}

function pickContactCoords(addresses: Array<{ coordinates: unknown }>): StoreCoords | null {
  for (const addr of addresses) {
    const coords = addr?.coordinates;
    if (coords && typeof coords === 'object' && !Array.isArray(coords)) {
      const obj = coords as Record<string, unknown>;
      const latRaw = obj.latitude ?? obj.lat;
      const lngRaw = obj.longitude ?? obj.lng ?? obj.lon ?? obj.long;
      const lat = typeof latRaw === 'number' ? latRaw : Number(latRaw);
      const lng = typeof lngRaw === 'number' ? lngRaw : Number(lngRaw);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { latitude: lat, longitude: lng };
      }
    }
  }
  return null;
}

export class POSAdapter implements MCPAdapter {
  getMCPTools(): Tool[] {
    return [
      {
        name: 'create_inbox_order',
        description:
          'Create an AI inbox order (AIInboxOrder) for a customer ordering via WhatsApp, Telegram, or web chat — pesanan masuk, order via WA/chat. Use only after the customer has confirmed all items, fulfillment type (PICKUP or DELIVERY), and the target store; call `list_stores` or `find_nearest_store` first if the store is not yet chosen. Automatically reserves stock for any line item with a productId. Returns order id, number, total, and payment status.',
        inputSchema: {
          type: 'object',
          properties: {
            contactId: { type: 'string', description: 'Customer Contact ID (must already exist in this org).' },
            accountId: { type: 'string', description: 'Optional bill-to CRM account ID when the customer buys for a company.' },
            accountUnitId: { type: 'string', description: 'Optional consuming unit under the bill-to account.' },
            items: {
              type: 'array',
              description: 'Line items the customer agreed to.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Display name of the item.' },
                  productId: { type: 'string', description: 'Optional Product ID when known from inventory lookup.' },
                  quantity: { type: 'number', description: 'Quantity ordered.' },
                  unitPrice: { type: 'number', description: 'Price per unit in IDR (or order currency).' },
                  unit: { type: 'string', description: 'Selected unit, e.g. botol, dus, pack.' },
                  notes: { type: 'string', description: 'Optional per-line notes.' },
                },
                required: ['name', 'quantity', 'unitPrice'],
              },
            },
            fulfillmentType: {
              type: 'string',
              enum: ['PICKUP', 'DELIVERY'],
              description: 'How the customer will receive the order.',
            },
            storeId: { type: 'string', description: 'Store ID the order is routed to (must belong to this org).' },
            notes: { type: 'string', description: 'Optional order-level notes (delivery instructions, etc.).' },
          },
          required: ['contactId', 'items', 'fulfillmentType', 'storeId'],
        },
      },
      {
        name: 'send_inbox_order_payment_link',
        description:
          "Generate a Xendit payment link for an existing AIInboxOrder so the customer can pay online — kirim link pembayaran, bayar online. Use after the order is confirmed and the customer wants to pay digitally; not needed if they will pay cash at pickup or counter. Requires an active Xendit integration — returns an error otherwise. The order moves to AWAITING_PAYMENT and becomes PAID automatically when Xendit confirms (do not mark it paid yourself).",
        inputSchema: {
          type: 'object',
          properties: {
            orderId: { type: 'string', description: 'AIInboxOrder ID to bill.' },
          },
          required: ['orderId'],
        },
      },
      {
        name: 'list_stores',
        description:
          'List all active Store records for this organization — daftar toko, daftar cabang, outlet tersedia. Use when the customer needs to choose a pickup or delivery store; if the customer has shared their location, use `find_nearest_store` instead to return only the single closest store.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'find_nearest_store',
        description:
          'Find the single Store nearest to given GPS coordinates or to a contact\'s saved address — toko terdekat, cabang paling dekat. Use when the customer shares their location and you want to suggest a specific store; use `list_stores` when no coordinates are available or the customer wants to see all options. Returns storeId, store name, and distance_km, or null if no stores have coordinates configured.',
        inputSchema: {
          type: 'object',
          properties: {
            latitude: { type: 'number', description: 'Customer latitude (use this OR contactId).' },
            longitude: { type: 'number', description: 'Customer longitude (use this OR contactId).' },
            contactId: { type: 'string', description: 'Resolve coords from this contact\'s primary address.' },
          },
        },
      },
      // ── Transactions ─────────────────────────────────────────────
      {
        name: 'list_pos_transactions',
        description:
          'List POSTransaction records with filters for date range, store, shift, status, and payment status — daftar transaksi kasir, riwayat penjualan POS, cari struk. Default: last 30 days, COMPLETED only, up to 50 rows. For pre-aggregated daily totals use `get_daily_sales_summary`; to read one transaction with its line items use `get_pos_transaction`.',
        inputSchema: {
          type: 'object',
          properties: {
            startDate: { type: 'string', description: 'YYYY-MM-DD (inclusive).' },
            endDate: { type: 'string', description: 'YYYY-MM-DD (inclusive).' },
            storeId: { type: 'string', description: 'Filter to one store.' },
            sessionId: { type: 'string', description: 'Filter to one shift.' },
            status: { type: 'string', enum: ['COMPLETED', 'VOIDED', 'REFUNDED'], description: 'Default COMPLETED.' },
            paymentStatus: { type: 'string', enum: ['PAID', 'PARTIAL', 'UNPAID'] },
            limit: { type: 'number', description: 'Max rows (default 50, max 200).' },
          },
        },
      },
      {
        name: 'get_pos_transaction',
        description: 'Fetch a single POSTransaction by ID with full detail: line items (product, qty, price) and payment records — detail struk, detail transaksi kasir. Use when you have a specific transactionId and need the complete breakdown; to search or list multiple transactions use `list_pos_transactions`.',
        inputSchema: {
          type: 'object',
          properties: {
            transactionId: { type: 'string', description: 'POSTransaction id.' },
          },
          required: ['transactionId'],
        },
      },
      {
        name: 'get_daily_sales_summary',
        description:
          'Return POS revenue aggregated by day, store, and payment method for a date range — omzet harian, rekap penjualan kasir, ringkasan pendapatan. Includes total revenue, transaction count, and average ticket per day (default: last 7 days, COMPLETED transactions only). For raw transaction rows use `list_pos_transactions`; for hourly or day-of-week patterns use `analyze_sales_by_time`.',
        inputSchema: {
          type: 'object',
          properties: {
            startDate: { type: 'string', description: 'YYYY-MM-DD. Default: 7 days ago.' },
            endDate: { type: 'string', description: 'YYYY-MM-DD. Default: today.' },
            storeId: { type: 'string', description: 'Filter to one store.' },
          },
        },
      },
      // ── Shifts ────────────────────────────────────────────────────
      {
        name: 'list_shifts',
        description: 'List POS cashier shift records (POSSession) with optional filters for status, cashier, terminal, and date range — daftar shift kasir, riwayat shift, rekap shift. Default: most recent 25 shifts. For a live view of currently open shifts with running revenue totals use `get_current_shift_summary` instead.',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['OPEN', 'CLOSED'], description: 'Filter by status.' },
            cashierId: { type: 'string', description: 'Filter to one cashier.' },
            terminalId: { type: 'string', description: 'Filter to one terminal.' },
            startDate: { type: 'string', description: 'YYYY-MM-DD; openedAt >=.' },
            endDate: { type: 'string', description: 'YYYY-MM-DD; openedAt <=.' },
            limit: { type: 'number', description: 'Max rows (default 25, max 100).' },
          },
        },
      },
      {
        name: 'get_current_shift_summary',
        description:
          'Summarize all currently OPEN POS sessions by terminal: cashier name, opening cash, transaction count so far, and running revenue totals — shift aktif, shift yang sedang berjalan, kas berjalan hari ini. Use for real-time shift status during the day; for historical or closed shift data use `list_shifts` with status=CLOSED.',
        inputSchema: {
          type: 'object',
          properties: {
            terminalId: { type: 'string', description: 'Optional — restrict to one terminal.' },
          },
        },
      },
      // ── Menu analytics (relocated from resto adapter) ─────────────
      {
        name: 'analyze_menu_performance',
        description:
          'Analyze POS sales volume and revenue per product over a date range, ranked by top sellers — produk terlaris, menu terlaris, performa penjualan produk. Reads POSTransaction line items; works for both F&B menus and retail products. For profit margins and HPP use `analyze_menu_profitability`; for hourly or day-of-week patterns use `analyze_sales_by_time`.',
        inputSchema: {
          type: 'object',
          properties: {
            startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
            endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
            limit: { type: 'number', description: 'Top N items (default 20)' },
          },
        },
      },
      {
        name: 'analyze_menu_profitability',
        description:
          'Compare sell price vs cost price (HPP from BOM template) for all active products and classify each into margin bands — margin produk, HPP, profitabilitas menu, keuntungan per item. Does not filter by date; reflects current prices and costs. For sales volume and revenue rankings use `analyze_menu_performance`.',
        inputSchema: {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Filter by product category.' },
          },
        },
      },
      {
        name: 'get_menu_recommendations',
        description:
          'Generate rule-based pricing and menu optimization recommendations by combining recent sales volume and current profit-margin data — rekomendasi menu, optimasi harga, item yang perlu dinaikkan harga atau dihapus. Flags items needing a price increase (popular but low-margin), items to promote (high-margin but low sales), and items to remove or revise (low-margin and rarely sold). For the underlying data call `analyze_menu_performance` or `analyze_menu_profitability` directly.',
        inputSchema: {
          type: 'object',
          properties: {
            startDate: { type: 'string', description: 'Analysis period start (YYYY-MM-DD)' },
            endDate: { type: 'string', description: 'Analysis period end (YYYY-MM-DD)' },
          },
        },
      },
      {
        name: 'analyze_sales_by_time',
        description:
          'Analyze POS transaction patterns broken down by hour of day (0–23) and day of week — jam tersibuk, pola penjualan per jam/hari, peak hours, hari paling ramai. Returns peak hours and peak days with revenue and transaction counts, plus a staffing suggestion. For daily totals by calendar date use `get_daily_sales_summary`.',
        inputSchema: {
          type: 'object',
          properties: {
            startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
            endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
          },
        },
      },
    ];
  }

  async executeMCPTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: AdapterContext,
  ): Promise<unknown> {
    switch (toolName) {
      case 'send_inbox_order_payment_link':
        return this.executeSendInboxOrderPaymentLink(args, ctx);
      case 'create_inbox_order':
        return this.executeCreateInboxOrder(args, ctx);
      case 'list_stores':
        return this.executeListStores(ctx);
      case 'find_nearest_store':
        return this.executeFindNearestStore(args, ctx);
      case 'list_pos_transactions':
        return this.listPosTransactions(args, ctx);
      case 'get_pos_transaction':
        return this.getPosTransaction(args, ctx);
      case 'get_daily_sales_summary':
        return this.getDailySalesSummary(args, ctx);
      case 'list_shifts':
        return this.listShifts(args, ctx);
      case 'get_current_shift_summary':
        return this.getCurrentShiftSummary(args, ctx);
      case 'analyze_menu_performance':
        return this.analyzeMenuPerformance(args, ctx);
      case 'analyze_menu_profitability':
        return this.analyzeMenuProfitability(args, ctx);
      case 'get_menu_recommendations':
        return this.getMenuRecommendations(args, ctx);
      case 'analyze_sales_by_time':
        return this.analyzeSalesByTime(args, ctx);
      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  }

  private async executeListStores(ctx: AdapterContext): Promise<unknown> {
    const stores = await ctx.prisma.store.findMany({
      where: { organizationId: ctx.organizationId, isActive: true },
      select: {
        id: true,
        name: true,
        address: true,
        latitude: true,
        longitude: true,
        metadata: true,
        isActive: true,
      },
      orderBy: { name: 'asc' },
    });

    return {
      stores: stores.map(s => {
        const meta = (s.metadata as Record<string, unknown> | null) || null;
        const hours = meta && (meta.hours ?? meta.openingHours ?? meta.businessHours);
        return {
          id: s.id,
          name: s.name,
          address: s.address,
          latitude: s.latitude,
          longitude: s.longitude,
          hours: hours ?? null,
          isActive: s.isActive,
        };
      }),
    };
  }

  private async executeFindNearestStore(
    args: Record<string, unknown>,
    ctx: AdapterContext,
  ): Promise<unknown> {
    let coords: StoreCoords | null = null;

    if (typeof args.latitude === 'number' && typeof args.longitude === 'number') {
      coords = { latitude: args.latitude, longitude: args.longitude };
    } else if (typeof args.contactId === 'string' && args.contactId) {
      const contact = await ctx.prisma.contact.findFirst({
        where: { id: args.contactId, organizationId: ctx.organizationId, deletedAt: null },
        select: {
          addresses: {
            where: { deletedAt: null },
            orderBy: { isDefault: 'desc' },
            take: 5,
            select: { coordinates: true },
          },
        },
      });
      if (!contact) return { error: 'Contact not found' };
      coords = pickContactCoords(contact.addresses || []);
    } else {
      return { error: 'Provide either {latitude, longitude} or contactId' };
    }

    if (!coords) {
      return { storeId: null, distance_km: null, reason: 'No coordinates available for the contact' };
    }

    const stores = await ctx.prisma.store.findMany({
      where: {
        organizationId: ctx.organizationId,
        isActive: true,
        latitude: { not: null },
        longitude: { not: null },
      },
      select: { id: true, name: true, latitude: true, longitude: true },
    });

    let best: { storeId: string; name: string; distanceKm: number } | null = null;
    for (const store of stores) {
      if (store.latitude == null || store.longitude == null) continue;
      const distanceKm = haversineDistanceKm(coords, {
        latitude: store.latitude,
        longitude: store.longitude,
      });
      if (!best || distanceKm < best.distanceKm) {
        best = { storeId: store.id, name: store.name, distanceKm };
      }
    }

    if (!best) {
      return { storeId: null, distance_km: null, reason: 'No stores have coordinates set' };
    }

    return {
      storeId: best.storeId,
      name: best.name,
      distance_km: Number(best.distanceKm.toFixed(3)),
    };
  }

  private async executeCreateInboxOrder(
    args: Record<string, unknown>,
    ctx: AdapterContext,
  ): Promise<unknown> {
    const contactId = args.contactId as string | undefined;
    const requestedAccountId = args.accountId as string | undefined;
    const requestedAccountUnitId = args.accountUnitId as string | undefined;
    const storeId = args.storeId as string | undefined;
    const fulfillmentType = args.fulfillmentType as string | undefined;
    const items = args.items as InboxOrderItemInput[] | undefined;
    const notes = (args.notes as string | undefined) ?? null;

    if (!contactId) return { error: 'contactId is required' };
    if (!storeId) return { error: 'storeId is required' };
    if (!fulfillmentType || !['PICKUP', 'DELIVERY'].includes(fulfillmentType)) {
      return { error: 'fulfillmentType must be PICKUP or DELIVERY' };
    }
    if (!Array.isArray(items) || items.length === 0) {
      return { error: 'At least one item is required' };
    }

    // Validate store belongs to org and is active
    const store = await ctx.prisma.store.findFirst({
      where: { id: storeId, organizationId: ctx.organizationId, isActive: true },
      select: { id: true, name: true }, // : name needed for SSE slip payload
    });
    if (!store) return { error: 'Store not found or not active for this org' };

    // Validate contact belongs to org
    const contact = await ctx.prisma.contact.findFirst({
      where: { id: contactId, organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true, name: true, companyId: true, accountUnitId: true }, // : name needed for SSE slip payload
    });
    if (!contact) return { error: 'Contact not found' };
    let resolvedAccountId = requestedAccountId || contact.companyId || null;
    let resolvedAccountUnitId = requestedAccountUnitId || contact.accountUnitId || null;
    if (resolvedAccountUnitId) {
      const unit = await ctx.prisma.crmAccountUnit.findFirst({
        where: {
          id: resolvedAccountUnitId,
          organizationId: ctx.organizationId,
          deletedAt: null,
          ...(resolvedAccountId ? { accountId: resolvedAccountId } : {}),
        },
        select: { id: true, accountId: true },
      });
      if (!unit) return { error: 'Account unit not found for this customer account' };
      resolvedAccountId = resolvedAccountId || unit.accountId;
    }
    if (resolvedAccountId) {
      const account = await ctx.prisma.crmAccount.findFirst({
        where: { id: resolvedAccountId, organizationId: ctx.organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!account) return { error: 'Account not found' };
    }

    // Normalize items + compute totals (basic math; extend with  helpers in later slice)
    const normalizedItems = items.map(item => ({
      name: item.name,
      productId: item.productId ?? null,
      quantity: Number(item.quantity) || 0,
      unitPrice: Number(item.unitPrice) || 0,
      unit: item.unit ?? null,
      notes: item.notes ?? null,
      total: (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0),
    }));
    const subtotal = normalizedItems.reduce((sum, item) => sum + item.total, 0);
    const taxAmount = 0; // v1 — extend later
    const discountAmount = 0;
    const total = subtotal + taxAmount - discountAmount;

    const terminal = await ctx.prisma.pOSTerminal.findFirst({
      where: {
        organizationId: ctx.organizationId,
        storeId: store.id,
        isActive: true,
        deletedAt: null,
      },
      orderBy: { updatedAt: 'desc' },
      select: { settings: true },
    });
    const reservationPolicy = readReservationPolicy(terminal?.settings);
    const now = new Date();
    const reservationExpiresAt = computeReservationExpiry(reservationPolicy, now);

    const number = await generateResourceCode(ctx.organizationId, 'AIORD', { client: ctx.prisma });

    const orderResult = await ctx.prisma.$transaction(async (tx) => {
      const reservationLines: StockReservationLine[] = [];
      const requestedQtyByProduct = new Map<string, number>();
      for (const item of normalizedItems) {
        if (!item.productId || item.quantity <= 0) continue;
        requestedQtyByProduct.set(
          item.productId,
          (requestedQtyByProduct.get(item.productId) ?? 0) + item.quantity,
        );
      }

      if (requestedQtyByProduct.size > 0) {
        const storeWarehouses = await tx.warehouse.findMany({
          where: {
            organizationId: ctx.organizationId,
            storeId: store.id,
            isActive: true,
            deletedAt: null,
          },
          select: { id: true },
        });
        const stockRows = await tx.productStock.findMany({
          where: {
            productId: { in: [...requestedQtyByProduct.keys()] },
            ...(storeWarehouses.length > 0
              ? { warehouseId: { in: storeWarehouses.map((warehouse) => warehouse.id) } }
              : {}),
            product: { organizationId: ctx.organizationId, deletedAt: null },
            warehouse: { organizationId: ctx.organizationId, isActive: true, deletedAt: null },
          },
          include: { product: { select: { name: true } } },
          orderBy: [{ quantity: 'desc' }],
        });

        for (const [productId, requiredQty] of requestedQtyByProduct.entries()) {
          const stockRow = stockRows.find(
            (row) => row.productId === productId && Number(row.quantity) - Number(row.reservedQty) >= requiredQty,
          );
          if (!stockRow) {
            throw new Error(
              `Insufficient stock for ${stockRows.find((row) => row.productId === productId)?.product?.name || productId}`,
            );
          }

          const updated = await tx.productStock.updateMany({
            where: {
              id: stockRow.id,
              quantity: { gte: Number(stockRow.reservedQty) + requiredQty },
              reservedQty: stockRow.reservedQty,
            },
            data: { reservedQty: { increment: requiredQty } },
          });
          if (updated.count === 0) {
            throw new Error(`Stock changed while reserving ${stockRow.product?.name || productId}`);
          }
          reservationLines.push({
            productId,
            warehouseId: stockRow.warehouseId,
            quantity: requiredQty,
          });
        }
      }

      return tx.aIInboxOrder.create({
        data: {
          id: uuidv7(),
          number,
          organizationId: ctx.organizationId,
          contactId: contact.id,
          accountId: resolvedAccountId,
          accountUnitId: resolvedAccountUnitId,
          conversationId: ctx.conversationId ?? null,
          channelId: ctx.channelId ?? null,
          storeId: store.id,
          fulfillmentType,
          paymentStatus: 'UNPAID',
          fulfillmentStatus: 'PENDING',
          items: normalizedItems as never,
          subtotal,
          discountAmount,
          taxAmount,
          total,
          currency: 'IDR',
          notes,
          reservationExpiresAt,
          metadata: reservationLines.length > 0
            ? {
                stockReservation: {
                  status: 'RESERVED',
                  lines: reservationLines,
                  reservedAt: now.toISOString(),
                  policy: reservationPolicy,
                },
              } as never
            : undefined,
          createdBy: ctx.userId ?? null,
        },
        select: {
          id: true,
          number: true,
          total: true,
          paymentStatus: true,
          fulfillmentStatus: true,
          fulfillmentType: true,
          storeId: true,
          createdAt: true,
          paymentLinkUrl: true,
        },
      });
    }).catch((err: unknown) => ({
      error: err instanceof Error ? err.message : 'Failed to create AI inbox order',
    }));
    if ('error' in orderResult) return orderResult;
    const order = orderResult;

    // No RevenueEvent / PaymentEvent emit here — those fire later
    // (FULFILLED for delivery, POSTransaction COMPLETED for pickup-handover Path C).

    // Resolve channel type for the SSE slip payload. Channel.type maps to
    // 'WHATSAPP' | 'TELEGRAM' | 'WEBCHAT' | etc. — short-code in the slip
    // header keeps the print footprint small.
    let channelCode: string = 'WA';
    if (ctx.channelId) {
      const ch = await ctx.prisma.channel.findFirst({
        where: { id: ctx.channelId, organizationId: ctx.organizationId },
        select: { type: true },
      });
      if (ch?.type) {
        channelCode =
          ch.type === 'WHATSAPP' ? 'WA' :
          ch.type === 'TELEGRAM' ? 'TG' :
          ch.type === 'WEBCHAT'  ? 'WEB' :
          String(ch.type);
      }
    }

    //  Slice 2: notify subscribed POS terminals at this store via Redis
    // pub/sub. Publish the FULL AIInboxOrderSlipPayload shape so the POS
    // client can render the slip + auto-print directly without a second
    // fetch. SSE handler (`/api/pos/orders/stream`) fans out to clients.
    // Non-fatal: publish errors logged and swallowed inside the helper.
    void emitPosOrderEvent({
      organizationId: ctx.organizationId,
      storeId: order.storeId,
      event: 'aiInboxOrder.created',
      data: {
        id: order.id,
        number: order.number,
        createdAt: order.createdAt.toISOString(),
        paymentStatus: order.paymentStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        fulfillmentType: order.fulfillmentType,
        customerName: contact.name ?? null,
        channel: channelCode,
        storeName: store.name,
        items: normalizedItems.map((item) => ({
          name: item.name,
          qty: item.quantity,
          unitPrice: item.unitPrice,
          total: item.total,
          notes: item.notes,
        })),
        subtotal,
        discountAmount,
        taxAmount,
        total: Number(order.total),
        paymentMethod: null,
        paymentLinkUrl: order.paymentLinkUrl,
        notes: notes ?? null,
      },
    });

    return {
      orderId: order.id,
      number: order.number,
      total: Number(order.total),
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      fulfillmentType: order.fulfillmentType,
      storeId: order.storeId,
      paymentLinkUrl: order.paymentLinkUrl,
      message: `AI inbox order ${order.number} created`,
    };
  }

  // ── Self-fulfillment: payment link  ───────────────────────
  // AI orchestrates the integration; the Xendit webhook completes the status.
  // The AI never marks the order paid itself — it only attaches the link.
  private async executeSendInboxOrderPaymentLink(
    args: Record<string, unknown>,
    ctx: AdapterContext,
  ): Promise<unknown> {
    const orderId = args.orderId as string | undefined;
    if (!orderId) return { error: 'orderId is required' };

    const order = await ctx.prisma.aIInboxOrder.findFirst({
      where: { id: orderId, organizationId: ctx.organizationId, deletedAt: null },
      select: {
        id: true, number: true, total: true, currency: true, paymentStatus: true,
        paymentLinkUrl: true, contact: { select: { name: true, email: true } },
      },
    });
    if (!order) return { error: 'Order not found' };
    if (order.paymentStatus === 'PAID') {
      return { error: 'Order is already paid' };
    }
    if (order.paymentStatus === 'AWAITING_PAYMENT' && order.paymentLinkUrl) {
      return { paymentUrl: order.paymentLinkUrl, message: 'Payment link already issued', alreadyIssued: true };
    }

    // Load the org's active Xendit credential (gate: no Xendit → no link).
    const integ = await ctx.prisma.orgIntegration.findFirst({
      where: { organizationId: ctx.organizationId, provider: 'XENDIT', isActive: true, deletedAt: null },
      select: { credentials: true },
    });
    if (!integ?.credentials) {
      return { error: 'Xendit is not connected for this organization — cannot create a payment link.' };
    }
    const creds = decryptCredentials(integ.credentials as Record<string, unknown>);
    const apiKey = (creds?.apiKey || creds?.api_key) as string | undefined;
    if (!apiKey) return { error: 'Xendit credential is missing an API key.' };

    let invoiceUrl: string;
    let invoiceId: string;
    try {
      const res = await fetch('https://api.xendit.co/v2/invoices', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          external_id: order.id,
          amount: Number(order.total),
          description: `Order ${order.number}`,
          payer_email: order.contact?.email || undefined,
          customer: order.contact?.name ? { given_names: order.contact.name } : undefined,
          currency: order.currency || 'IDR',
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string };
        return { error: err.message || 'Failed to create Xendit payment link' };
      }
      const data = (await res.json()) as { invoice_url: string; id: string };
      invoiceUrl = data.invoice_url;
      invoiceId = data.id;
    } catch {
      return { error: 'Failed to reach Xendit' };
    }

    // paymentReference = Xendit invoice id — the webhook matches the order by it
    // and flips paymentStatus to PAID + emits the PaymentEvent.
    await ctx.prisma.aIInboxOrder.update({
      where: { id: order.id },
      data: { paymentReference: invoiceId, paymentLinkUrl: invoiceUrl, paymentStatus: 'AWAITING_PAYMENT' },
    });

    return {
      orderId: order.id,
      number: order.number,
      paymentUrl: invoiceUrl,
      message: `Payment link created for order ${order.number}. Send this link to the customer; the order will be marked paid automatically once Xendit confirms.`,
    };
  }

  // ── Read tools -02) ─────────────────────────────────────────

  private parseDateRange(args: Record<string, unknown>, defaultDays: number): { start: Date; end: Date } {
    const now = new Date();
    const end = args.endDate
      ? new Date(`${args.endDate as string}T23:59:59Z`)
      : now;
    const start = args.startDate
      ? new Date(args.startDate as string)
      : new Date(now.getTime() - defaultDays * 24 * 60 * 60 * 1000);
    return { start, end };
  }

  private async listPosTransactions(args: Record<string, unknown>, ctx: AdapterContext) {
    const { start, end } = this.parseDateRange(args, 30);
    const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
    const status = (args.status as 'COMPLETED' | 'VOIDED' | 'REFUNDED' | undefined) || 'COMPLETED';

    const txs = await ctx.prisma.pOSTransaction.findMany({
      where: {
        organizationId: ctx.organizationId,
        status,
        createdAt: { gte: start, lte: end },
        ...(args.storeId ? { storeId: args.storeId as string } : {}),
        ...(args.sessionId ? { sessionId: args.sessionId as string } : {}),
        ...(args.paymentStatus ? { paymentStatus: args.paymentStatus as 'PAID' | 'PARTIAL' | 'UNPAID' } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        number: true,
        total: true,
        paymentMethod: true,
        paymentStatus: true,
        amountOutstanding: true,
        status: true,
        customerId: true,
        storeId: true,
        sessionId: true,
        orderType: true,
        createdAt: true,
      },
    });

    return {
      total: txs.length,
      period: { startDate: start.toISOString().split('T')[0], endDate: end.toISOString().split('T')[0] },
      transactions: txs.map((t) => ({
        id: t.id,
        number: t.number,
        total: Number(t.total),
        paymentMethod: t.paymentMethod,
        paymentStatus: t.paymentStatus,
        amountOutstanding: Number(t.amountOutstanding),
        status: t.status,
        customerId: t.customerId,
        storeId: t.storeId,
        sessionId: t.sessionId,
        orderType: t.orderType,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  }

  private async getPosTransaction(args: Record<string, unknown>, ctx: AdapterContext) {
    const transactionId = args.transactionId as string | undefined;
    if (!transactionId) return { error: 'transactionId is required' };

    const tx = await ctx.prisma.pOSTransaction.findFirst({
      where: { id: transactionId, organizationId: ctx.organizationId },
      include: {
        items: { select: { id: true, productId: true, quantity: true, unitPrice: true, total: true, notes: true, product: { select: { name: true, sku: true } } } },
        payments: { select: { id: true, amount: true, paymentMethod: true, paidAt: true } },
      },
    });
    if (!tx) return { error: 'POS transaction not found' };

    return {
      id: tx.id,
      number: tx.number,
      status: tx.status,
      paymentStatus: tx.paymentStatus,
      paymentMethod: tx.paymentMethod,
      orderType: tx.orderType,
      subtotal: Number(tx.subtotal),
      discountAmount: Number(tx.discountAmount),
      taxAmount: Number(tx.taxAmount),
      roundingAmount: Number(tx.roundingAmount),
      total: Number(tx.total),
      amountPaid: Number(tx.amountPaid),
      amountOutstanding: Number(tx.amountOutstanding),
      changeAmount: Number(tx.changeAmount),
      customerId: tx.customerId,
      storeId: tx.storeId,
      sessionId: tx.sessionId,
      tableId: tx.tableId,
      createdAt: tx.createdAt.toISOString(),
      voidedAt: tx.voidedAt?.toISOString() ?? null,
      refundedAt: tx.refundedAt?.toISOString() ?? null,
      items: tx.items.map((it) => ({
        id: it.id,
        productId: it.productId,
        productName: it.product?.name ?? null,
        sku: it.product?.sku ?? null,
        quantity: it.quantity,
        unitPrice: Number(it.unitPrice),
        total: Number(it.total),
        notes: it.notes,
      })),
      payments: tx.payments.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        paymentMethod: p.paymentMethod,
        paidAt: p.paidAt.toISOString(),
      })),
    };
  }

  private async getDailySalesSummary(args: Record<string, unknown>, ctx: AdapterContext) {
    const { start, end } = this.parseDateRange(args, 7);

    const txs = await ctx.prisma.pOSTransaction.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: 'COMPLETED',
        createdAt: { gte: start, lte: end },
        ...(args.storeId ? { storeId: args.storeId as string } : {}),
      },
      select: {
        total: true,
        paymentMethod: true,
        storeId: true,
        createdAt: true,
      },
    });

    type DayBucket = { day: string; txCount: number; revenue: number };
    type StoreBucket = { storeId: string | null; txCount: number; revenue: number };
    type MethodBucket = { method: string; txCount: number; revenue: number };

    const byDay = new Map<string, DayBucket>();
    const byStore = new Map<string, StoreBucket>();
    const byMethod = new Map<string, MethodBucket>();

    for (const tx of txs) {
      const day = tx.createdAt.toISOString().split('T')[0];
      const dayB = byDay.get(day) || { day, txCount: 0, revenue: 0 };
      dayB.txCount++;
      dayB.revenue += Number(tx.total);
      byDay.set(day, dayB);

      const storeKey = tx.storeId || '_none_';
      const storeB = byStore.get(storeKey) || { storeId: tx.storeId, txCount: 0, revenue: 0 };
      storeB.txCount++;
      storeB.revenue += Number(tx.total);
      byStore.set(storeKey, storeB);

      const methodB = byMethod.get(tx.paymentMethod) || { method: tx.paymentMethod, txCount: 0, revenue: 0 };
      methodB.txCount++;
      methodB.revenue += Number(tx.total);
      byMethod.set(tx.paymentMethod, methodB);
    }

    const totalRevenue = txs.reduce((s, t) => s + Number(t.total), 0);
    const totalTx = txs.length;

    return {
      period: { startDate: start.toISOString().split('T')[0], endDate: end.toISOString().split('T')[0] },
      totalTransactions: totalTx,
      totalRevenue,
      averageTicket: totalTx > 0 ? Math.round(totalRevenue / totalTx) : 0,
      byDay: Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day)),
      byStore: Array.from(byStore.values()).sort((a, b) => b.revenue - a.revenue),
      byPaymentMethod: Array.from(byMethod.values()).sort((a, b) => b.revenue - a.revenue),
    };
  }

  private async listShifts(args: Record<string, unknown>, ctx: AdapterContext) {
    const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
    const status = args.status as 'OPEN' | 'CLOSED' | undefined;
    const cashierId = args.cashierId as string | undefined;
    const terminalId = args.terminalId as string | undefined;
    const start = args.startDate ? new Date(args.startDate as string) : undefined;
    const end = args.endDate ? new Date(`${args.endDate as string}T23:59:59Z`) : undefined;

    const sessions = await ctx.prisma.pOSSession.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(status ? { status } : {}),
        ...(cashierId ? { cashierId } : {}),
        ...(terminalId ? { terminalId } : {}),
        ...(start || end ? { openedAt: { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } } : {}),
      },
      orderBy: { openedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        number: true,
        terminalId: true,
        cashierId: true,
        openingCash: true,
        closingCash: true,
        expectedCash: true,
        difference: true,
        status: true,
        openedAt: true,
        closedAt: true,
        terminal: { select: { name: true, location: true } },
      },
    });

    return {
      total: sessions.length,
      shifts: sessions.map((s) => ({
        id: s.id,
        number: s.number,
        terminalId: s.terminalId,
        terminalName: s.terminal?.name ?? null,
        cashierId: s.cashierId,
        openingCash: Number(s.openingCash),
        closingCash: s.closingCash != null ? Number(s.closingCash) : null,
        expectedCash: s.expectedCash != null ? Number(s.expectedCash) : null,
        difference: s.difference != null ? Number(s.difference) : null,
        status: s.status,
        openedAt: s.openedAt.toISOString(),
        closedAt: s.closedAt?.toISOString() ?? null,
      })),
    };
  }

  private async getCurrentShiftSummary(args: Record<string, unknown>, ctx: AdapterContext) {
    const terminalId = args.terminalId as string | undefined;

    const open = await ctx.prisma.pOSSession.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: 'OPEN',
        ...(terminalId ? { terminalId } : {}),
      },
      orderBy: { openedAt: 'desc' },
      include: {
        terminal: { select: { name: true, location: true } },
      },
    });

    const summaries = await Promise.all(
      open.map(async (session) => {
        const txAggregate = await ctx.prisma.pOSTransaction.aggregate({
          where: {
            organizationId: ctx.organizationId,
            sessionId: session.id,
            status: 'COMPLETED',
          },
          _count: true,
          _sum: { total: true, amountPaid: true },
        });
        return {
          sessionId: session.id,
          number: session.number,
          terminalId: session.terminalId,
          terminalName: session.terminal?.name ?? null,
          cashierId: session.cashierId,
          openingCash: Number(session.openingCash),
          openedAt: session.openedAt.toISOString(),
          openMinutes: Math.round((Date.now() - session.openedAt.getTime()) / 60000),
          transactionCount: txAggregate._count,
          totalRevenue: Number(txAggregate._sum.total || 0),
          totalCashIn: Number(txAggregate._sum.amountPaid || 0),
        };
      }),
    );

    return {
      openSessionCount: summaries.length,
      sessions: summaries,
    };
  }

  // ── Menu analytics (relocated from resto adapter) ────────────────

  private async analyzeMenuPerformance(args: Record<string, unknown>, ctx: AdapterContext) {
    const now = new Date();
    const startDate = args.startDate
      ? new Date(args.startDate as string)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = args.endDate
      ? new Date(`${args.endDate as string}T23:59:59Z`)
      : now;
    const limit = Math.min(Number(args.limit) || 20, 50);

    const transactions = await ctx.prisma.pOSTransaction.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: 'COMPLETED',
        createdAt: { gte: startDate, lte: endDate },
      },
      select: {
        items: {
          select: {
            productId: true,
            quantity: true,
            total: true,
            product: { select: { name: true, category: true } },
          },
        },
      },
    });

    const productStats = new Map<
      string,
      { name: string; category: string | null; qtySold: number; revenue: number; txCount: number }
    >();
    for (const tx of transactions) {
      for (const item of tx.items) {
        const key = item.productId;
        const qty = Number(item.quantity);
        const revenue = Number(item.total);
        const existing = productStats.get(key);
        if (existing) {
          existing.qtySold += qty;
          existing.revenue += revenue;
          existing.txCount++;
        } else {
          productStats.set(key, {
            name: item.product.name,
            category: item.product.category,
            qtySold: qty,
            revenue,
            txCount: 1,
          });
        }
      }
    }

    const sorted = Array.from(productStats.entries())
      .map(([id, stats]) => ({ productId: id, ...stats, avgPrice: stats.revenue / stats.qtySold }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);

    const totalRevenue = sorted.reduce((sum, s) => sum + s.revenue, 0);
    const totalQty = sorted.reduce((sum, s) => sum + s.qtySold, 0);

    return {
      period: { startDate: startDate.toISOString().split('T')[0], endDate: endDate.toISOString().split('T')[0] },
      totalTransactions: transactions.length,
      totalRevenue,
      totalItemsSold: totalQty,
      topItems: sorted.map((item, i) => ({
        rank: i + 1,
        name: item.name,
        category: item.category || '-',
        qtySold: item.qtySold,
        revenue: item.revenue,
        revenueShare: totalRevenue > 0 ? Math.round((item.revenue / totalRevenue) * 100) : 0,
        avgPrice: Math.round(item.avgPrice),
      })),
    };
  }

  private async analyzeMenuProfitability(args: Record<string, unknown>, ctx: AdapterContext) {
    const where: Record<string, unknown> = {
      organizationId: ctx.organizationId,
      isActive: true,
      deletedAt: null,
    };
    if (args.category) where.category = { contains: args.category as string, mode: 'insensitive' };

    const products = await ctx.prisma.product.findMany({
      where,
      select: { id: true, name: true, sellPrice: true, costPrice: true, category: true, sku: true },
      orderBy: { name: 'asc' },
    });

    const skus = products.map((p) => p.sku).filter(Boolean) as string[];
    const boms = await ctx.prisma.bOMTemplate.findMany({
      where: { organizationId: ctx.organizationId, sku: { in: skus }, deletedAt: null },
      select: { sku: true, totalCost: true },
    });

    const bomCostMap = new Map<string, number>();
    for (const bom of boms) {
      if (bom.sku && bom.totalCost) bomCostMap.set(bom.sku, Number(bom.totalCost));
    }

    const analysis = products.map((p) => {
      const sellPrice = Number(p.sellPrice || 0);
      const bomCost = p.sku ? bomCostMap.get(p.sku) : undefined;
      const costPrice = bomCost ?? Number(p.costPrice || 0);
      const margin = sellPrice > 0 ? ((sellPrice - costPrice) / sellPrice) * 100 : 0;
      const profit = sellPrice - costPrice;
      return {
        name: p.name,
        category: p.category || '-',
        sellPrice,
        costPrice,
        bomCost: bomCost ?? null,
        profit,
        marginPercent: Math.round(margin),
        marginCategory:
          margin >= 70 ? 'EXCELLENT' :
          margin >= 50 ? 'GOOD' :
          margin >= 30 ? 'FAIR' : 'LOW',
      };
    });

    analysis.sort((a, b) => b.marginPercent - a.marginPercent);
    const avgMargin = analysis.length > 0
      ? Math.round(analysis.reduce((sum, a) => sum + a.marginPercent, 0) / analysis.length)
      : 0;

    return {
      totalProducts: analysis.length,
      averageMargin: avgMargin,
      marginDistribution: {
        excellent: analysis.filter((a) => a.marginCategory === 'EXCELLENT').length,
        good: analysis.filter((a) => a.marginCategory === 'GOOD').length,
        fair: analysis.filter((a) => a.marginCategory === 'FAIR').length,
        low: analysis.filter((a) => a.marginCategory === 'LOW').length,
      },
      items: analysis,
    };
  }

  private async getMenuRecommendations(args: Record<string, unknown>, ctx: AdapterContext) {
    const now = new Date();
    const startDate = args.startDate
      ? new Date(args.startDate as string)
      : new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    const endDate = args.endDate
      ? new Date(`${args.endDate as string}T23:59:59Z`)
      : now;

    const [perfData, profData] = await Promise.all([
      this.analyzeMenuPerformance(
        { startDate: startDate.toISOString().split('T')[0], endDate: endDate.toISOString().split('T')[0], limit: 50 },
        ctx,
      ),
      this.analyzeMenuProfitability({}, ctx),
    ]);

    const perf = perfData as { topItems: Array<{ name: string; qtySold: number; revenue: number; revenueShare: number }> };
    const prof = profData as {
      items: Array<{ name: string; marginPercent: number; sellPrice: number; costPrice: number; profit: number }>;
    };

    const recommendations: Array<{ type: string; item: string; suggestion: string; impact: string }> = [];

    for (const item of perf.topItems.slice(0, 10)) {
      const profItem = prof.items.find((p) => p.name === item.name);
      if (!profItem) continue;
      if (profItem.marginPercent < 30 && item.qtySold > 5) {
        const suggestedPrice = Math.ceil(profItem.costPrice / 0.5 / 1000) * 1000;
        recommendations.push({
          type: 'PRICE_INCREASE',
          item: item.name,
          suggestion: `Naikkan harga dari Rp ${profItem.sellPrice.toLocaleString('id-ID')} ke Rp ${suggestedPrice.toLocaleString('id-ID')} (target margin 50%)`,
          impact: `Item populer (${item.qtySold} terjual) tapi margin rendah (${profItem.marginPercent}%). Kenaikan harga bisa menambah profit Rp ${((suggestedPrice - profItem.sellPrice) * item.qtySold).toLocaleString('id-ID')}/periode.`,
        });
      }
    }

    for (const profItem of prof.items) {
      if (profItem.marginPercent >= 60) {
        const perfItem = perf.topItems.find((p) => p.name === profItem.name);
        if (!perfItem || perfItem.qtySold < 3) {
          recommendations.push({
            type: 'PROMOTE',
            item: profItem.name,
            suggestion: `Promosikan ${profItem.name} — margin tinggi (${profItem.marginPercent}%) tapi penjualan rendah`,
            impact: `Setiap unit terjual menghasilkan profit Rp ${profItem.profit.toLocaleString('id-ID')}. Buat promo atau highlight di menu.`,
          });
        }
      }
    }

    for (const profItem of prof.items) {
      if (profItem.marginPercent < 20) {
        const perfItem = perf.topItems.find((p) => p.name === profItem.name);
        if (!perfItem || perfItem.qtySold <= 1) {
          recommendations.push({
            type: 'REMOVE_OR_REVISE',
            item: profItem.name,
            suggestion: `Pertimbangkan hapus/revisi ${profItem.name} — margin rendah (${profItem.marginPercent}%) dan jarang terjual`,
            impact: 'Item ini tidak menguntungkan. Ganti dengan item baru atau naikkan harga.',
          });
        }
      }
    }

    return {
      period: { startDate: startDate.toISOString().split('T')[0], endDate: endDate.toISOString().split('T')[0] },
      totalRecommendations: recommendations.length,
      recommendations: recommendations.slice(0, 15),
      summary: recommendations.length > 0
        ? `Ditemukan ${recommendations.length} rekomendasi untuk optimasi menu.`
        : 'Menu sudah cukup optimal. Tidak ada rekomendasi mendesak.',
    };
  }

  private async analyzeSalesByTime(args: Record<string, unknown>, ctx: AdapterContext) {
    const now = new Date();
    const startDate = args.startDate
      ? new Date(args.startDate as string)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = args.endDate
      ? new Date(`${args.endDate as string}T23:59:59Z`)
      : now;

    const transactions = await ctx.prisma.pOSTransaction.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: 'COMPLETED',
        createdAt: { gte: startDate, lte: endDate },
      },
      select: { total: true, createdAt: true },
    });

    const byHour = new Array(24).fill(0).map((_, hour) => ({ hour, txCount: 0, revenue: 0 }));
    const dayNames = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const byDay = dayNames.map((name, day) => ({ day, name, txCount: 0, revenue: 0 }));

    for (const tx of transactions) {
      const d = new Date(tx.createdAt);
      const hour = d.getHours();
      const day = d.getDay();
      const amount = Number(tx.total);
      byHour[hour].txCount++;
      byHour[hour].revenue += amount;
      byDay[day].txCount++;
      byDay[day].revenue += amount;
    }

    const peakHours = [...byHour].sort((a, b) => b.revenue - a.revenue).slice(0, 3);
    const peakDays = [...byDay].sort((a, b) => b.revenue - a.revenue).slice(0, 3);

    return {
      period: { startDate: startDate.toISOString().split('T')[0], endDate: endDate.toISOString().split('T')[0] },
      totalTransactions: transactions.length,
      byHour: byHour.filter((h) => h.txCount > 0),
      byDay,
      peakHours: peakHours.map((h) => `${String(h.hour).padStart(2, '0')}:00 (${h.txCount} tx, Rp ${h.revenue.toLocaleString('id-ID')})`),
      peakDays: peakDays.map((d) => `${d.name} (${d.txCount} tx, Rp ${d.revenue.toLocaleString('id-ID')})`),
      insights: {
        busiestHour: peakHours[0]?.hour,
        busiestDay: dayNames[peakDays[0]?.day],
        suggestion: peakHours[0]
          ? `Jam tersibuk: ${String(peakHours[0].hour).padStart(2, '0')}:00. Pastikan staf cukup dan stok bahan baku siap.`
          : 'Belum cukup data untuk analisis.',
      },
    };
  }

  getPromptInstructions(): string {
    return [
      'POS / AI INBOX ORDERS:',
      '- Use create_inbox_order ONLY after the customer has confirmed items, fulfillmentType (PICKUP or DELIVERY), and chosen store.',
      '- Never invent a storeId. Use list_stores to show options to the customer, or find_nearest_store when their coordinates / address are known.',
      '- For single-store orgs, list_stores returns one store and you can use that storeId without asking.',
      '- create_inbox_order does NOT take a source parameter — source is bound to AI server-side.',
      '- Xendit payment links/webhooks only work when the organization has an active Xendit integration with valid credentials. If Xendit tools are unavailable, do not promise online payment; tell the customer the order is UNPAID and payment must be handled by cashier/pickup or by an admin enabling Xendit.',
      '- After creating the order, the order stays UNPAID until the system confirms payment. Do not claim payment is received unless the system confirms it.',
      'POS REPORTING:',
      '- list_pos_transactions and get_daily_sales_summary read store-level cash/card revenue (POSTransaction). For piutang/credit, use customer_piutang_summary view via the finance adapter.',
      '- get_current_shift_summary lists OPEN POSSession rows; close-of-day reconciliation should use list_shifts with status=CLOSED.',
      '- Menu analytics (analyze_menu_performance / _profitability / _by_time, get_menu_recommendations) work for both retail and F&B since they read POSTransaction line items.',
    ].join('\n');
  }
}
