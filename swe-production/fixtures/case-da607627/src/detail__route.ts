import { NextRequest } from "next/server";
import { withAppAuth } from "@/lib/api/appAuth";
import { handleCorsOptions, withCors } from "@/lib/api/cors";
import { prisma } from "@/lib/db";

export async function OPTIONS(req: NextRequest) {
  return handleCorsOptions(req) ?? new Response(null, { status: 204 });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const optRes = handleCorsOptions(req);
  if (optRes) return optRes;
  const { id } = await params;

  const response = await withAppAuth(req, async (ctx) => {
    if (!id) {
      return Response.json({ error: "Missing id" }, { status: 400 });
    }
    const receipt = await prisma.pOSTransaction.findFirst({
      where: {
        id,
        organizationId: ctx.organizationId,
      },
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true } },
          },
        },
        session: { select: { status: true } },
      },
    });
    if (!receipt) {
      return Response.json({ error: "Receipt not found" }, { status: 404 });
    }

    const diningTable = receipt.tableId
      ? await prisma.diningTable.findFirst({
          where: { id: receipt.tableId, organizationId: ctx.organizationId },
          select: { tableNumber: true },
        })
      : null;

    const customer = receipt.customerId
      ? await prisma.contact.findFirst({
          where: { id: receipt.customerId, organizationId: ctx.organizationId },
          select: { name: true },
        })
      : null;

    return Response.json({
      data: {
        id: receipt.id,
        number: receipt.number,
        receiptNumber: receipt.number,
        total: Number(receipt.total),
        amountPaid: Number(receipt.amountPaid),
        changeAmount: Number(receipt.changeAmount),
        paymentMethod: receipt.paymentMethod,
        orderType: receipt.orderType,
        createdAt: receipt.createdAt,
        subtotal: Number(receipt.subtotal),
        discountAmount: Number(receipt.discountAmount),
        taxAmount: Number(receipt.taxAmount),
        shippingCost: Number(receipt.shippingCost),
        roundingAmount: Number(receipt.roundingAmount),
        sessionStatus: receipt.session?.status,
        items: receipt.items.map((item) => ({
          id: item.product?.id,
          name: item.product?.name || "Unknown Product",
          qty: Number(item.quantity) || 0,
          unitPrice: Number(item.unitPrice),
          total: Number(item.total),
          notes: item.notes,
        })),
        notes: receipt.notes,
        customerId: receipt.customerId ?? null,
        customerName: receipt.customerName ?? customer?.name ?? null,
        table: diningTable ? { tableNumber: diningTable.tableNumber } : undefined,
      },
    });
  });

  return withCors(req, response);
}
