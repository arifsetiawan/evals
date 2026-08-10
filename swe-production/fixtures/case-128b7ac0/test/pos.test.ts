import { describe, expect, it, vi } from 'vitest';
import { markLeadWonForConversation } from '../src/pos';

/**
 *  — create_inbox_order (the AI agent's own WhatsApp/chat order tool)
 * creates an AIInboxOrder, a model distinct from SalesOrder that never
 * converts to one. Before this fix, placing an order this way left the
 * linked Lead open forever: invisible on the sales pipeline as "won", and
 * indistinguishable from a still-open prospect to any code that checks Lead
 * status (e.g. sales-cold-followup.ts, or a later recurring visit's
 * ensureOpenProspectOpportunity, which only starts a fresh Lead once the old
 * one is WON/LOST). This pins down that an inbox order now closes the Lead
 * the same way the dashboard's manual order-create route already does.
 */
function makePrisma(params: { leadId?: string | null; leadStatus?: string }) {
  return {
    conversation: {
      findFirst: vi.fn(async () => (params.leadId !== undefined ? { leadId: params.leadId } : null)),
    },
    lead: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  } as never;
}

describe('markLeadWonForConversation', () => {
  it('marks the linked Lead WON when the conversation has one', async () => {
    const prisma = makePrisma({ leadId: 'lead-1' });
    const now = new Date('2026-07-29T00:00:00Z');
    await markLeadWonForConversation(prisma, 'org-1', 'conv-1', 240000, now);

    expect((prisma as never as { lead: { updateMany: ReturnType<typeof vi.fn> } }).lead.updateMany).toHaveBeenCalledWith({
      where: { id: 'lead-1', organizationId: 'org-1', deletedAt: null, status: { notIn: ['WON', 'LOST'] } },
      data: { status: 'WON', convertedAt: now, actualCloseDate: now, quotedAmount: 240000 },
    });
  });

  it('does nothing when there is no conversationId', async () => {
    const prisma = makePrisma({ leadId: 'lead-1' });
    await markLeadWonForConversation(prisma, 'org-1', null, 100, new Date());
    expect((prisma as never as { conversation: { findFirst: ReturnType<typeof vi.fn> } }).conversation.findFirst).not.toHaveBeenCalled();
  });

  it('does nothing when the conversation has no linked leadId', async () => {
    const prisma = makePrisma({ leadId: null });
    await markLeadWonForConversation(prisma, 'org-1', 'conv-1', 100, new Date());
    expect((prisma as never as { lead: { updateMany: ReturnType<typeof vi.fn> } }).lead.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing when the conversation itself is not found', async () => {
    const prisma = makePrisma({});
    await markLeadWonForConversation(prisma, 'org-1', 'conv-missing', 100, new Date());
    expect((prisma as never as { lead: { updateMany: ReturnType<typeof vi.fn> } }).lead.updateMany).not.toHaveBeenCalled();
  });

  it('scopes the update by organizationId and excludes already-closed leads (idempotent on repeat orders)', async () => {
    const prisma = makePrisma({ leadId: 'lead-1' });
    await markLeadWonForConversation(prisma, 'org-1', 'conv-1', 50000, new Date());
    const call = (prisma as never as { lead: { updateMany: ReturnType<typeof vi.fn> } }).lead.updateMany.mock.calls[0][0];
    expect(call.where.organizationId).toBe('org-1');
    expect(call.where.status).toEqual({ notIn: ['WON', 'LOST'] });
  });
});
