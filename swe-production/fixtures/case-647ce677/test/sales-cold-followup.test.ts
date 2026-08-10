import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOptedInOrgIds: vi.fn(),
  dispatchToChannel: vi.fn(),
  dispatchMediaToChannel: vi.fn(),
  invokeAgentOnce: vi.fn(),
}));

vi.mock('../lib/cron-opt-in', () => ({ getOptedInOrgIds: mocks.getOptedInOrgIds }));
vi.mock('../channel-dispatch', () => ({
  dispatchToChannel: mocks.dispatchToChannel,
  dispatchMediaToChannel: mocks.dispatchMediaToChannel,
}));
vi.mock('../lib/sdr-agent-invoke', () => ({ invokeAgentOnce: mocks.invokeAgentOnce }));
vi.mock('uuidv7', () => ({ uuidv7: () => 'new-message-id' }));

import { runSalesColdFollowup } from '../src/sales-cold-followup';

/**
 *  — a customer who asks about a product and goes quiet, with no
 * order ever placed, must get exactly one nudge. Two things this pins down:
 * (1) nudging someone who already converted — via the dashboard's manual
 * order flow (marks the linked Lead WON) or via the AI agent's own
 * create_inbox_order (does NOT mark the Lead WON, only leaves a SalesOrder
 * row) — must never happen, both signals are checked independently.
 * (2) the nudge itself must reference the actual product discussed and
 * re-send its photo as real media when one exists, not a generic text ping —
 * that's the whole point of this job over a plain "are you still there?".
 */
function makePrisma(params: {
  leadId?: string | null;
  leadStatus?: string;
  hasOrderSinceLastMessage?: boolean;
  lastProductMessage?: { productId: string } | null;
  product?: { id: string; name: string; sellPrice: number; imageUrl: string | null } | null;
  agentId?: string | null;
  transcript?: Array<{ content: string; participantType: string }>;
}) {
  const conversation = {
    id: 'conv-1',
    contactId: 'contact-1',
    lastCustomerMessageAt: new Date('2026-07-27T00:00:00Z'),
    leadId: params.leadId ?? null,
  };

  return {
    conversation,
    prisma: {
      organization: {
        findUnique: vi.fn(async () => ({
          features: { leadFollowUp: { enabled: true, coldReengageHours: 24 } },
        })),
      },
      conversation: {
        findMany: vi.fn(async () => [conversation]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => ({})),
      },
      lead: {
        findUnique: vi.fn(async () => (params.leadId ? { status: params.leadStatus } : null)),
      },
      salesOrder: {
        findFirst: vi.fn(async () => (params.hasOrderSinceLastMessage ? { id: 'so-1' } : null)),
      },
      message: {
        findFirst: vi.fn(async () =>
          params.lastProductMessage ? { metadata: { sentViaTool: 'send_product_photo', productId: params.lastProductMessage.productId } } : null,
        ),
        // fetchRecentTranscript reverses this (queried desc, displayed chronological) —
        // return it already reversed so callers can pass transcript in natural
        // reading order and this mock still round-trips correctly.
        findMany: vi.fn(async () => [...(params.transcript ?? [])].reverse()),
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
      product: {
        findFirst: vi.fn(async () => params.product ?? null),
      },
      aIAgentExecution: {
        findFirst: vi.fn(async () => (params.agentId ? { aiAgentId: params.agentId } : null)),
      },
    } as never,
  };
}

describe('sales-cold-followup — who gets nudged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOptedInOrgIds.mockResolvedValue(['org-1']);
    mocks.dispatchToChannel.mockResolvedValue(true);
    mocks.dispatchMediaToChannel.mockResolvedValue({ ok: true });
    mocks.invokeAgentOnce.mockResolvedValue(null); // default: AI drafting unavailable, falls back to static
  });

  it('nudges a genuinely cold, unconverted conversation', async () => {
    const { prisma } = makePrisma({ leadId: 'lead-1', leadStatus: 'NEW_LEAD' });
    await runSalesColdFollowup(prisma);
    expect(mocks.dispatchToChannel).toHaveBeenCalledTimes(1);
  });

  it('does not nudge when the linked Lead is WON', async () => {
    const { prisma } = makePrisma({ leadId: 'lead-1', leadStatus: 'WON' });
    await runSalesColdFollowup(prisma);
    expect(mocks.dispatchToChannel).not.toHaveBeenCalled();
    expect(mocks.dispatchMediaToChannel).not.toHaveBeenCalled();
  });

  it('does not nudge when the linked Lead is LOST', async () => {
    const { prisma } = makePrisma({ leadId: 'lead-1', leadStatus: 'LOST' });
    await runSalesColdFollowup(prisma);
    expect(mocks.dispatchToChannel).not.toHaveBeenCalled();
  });

  it('does not nudge when an order exists since the customer last messaged, even with no leadId', async () => {
    const { prisma } = makePrisma({ leadId: null, hasOrderSinceLastMessage: true });
    await runSalesColdFollowup(prisma);
    expect(mocks.dispatchToChannel).not.toHaveBeenCalled();
  });

  it('does not nudge when an order exists even if the Lead was never marked WON (create_inbox_order gap)', async () => {
    const { prisma } = makePrisma({ leadId: 'lead-1', leadStatus: 'NEW_LEAD', hasOrderSinceLastMessage: true });
    await runSalesColdFollowup(prisma);
    expect(mocks.dispatchToChannel).not.toHaveBeenCalled();
  });

  it('nudges when there is no leadId and no order at all', async () => {
    const { prisma } = makePrisma({ leadId: null, hasOrderSinceLastMessage: false });
    await runSalesColdFollowup(prisma);
    expect(mocks.dispatchToChannel).toHaveBeenCalledTimes(1);
  });

  it('scopes the sales-order lookup to the organization and contact', async () => {
    const { prisma } = makePrisma({ leadId: 'lead-1', leadStatus: 'NEW_LEAD' });
    await runSalesColdFollowup(prisma);
    expect((prisma.salesOrder.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0].where).toMatchObject({
      organizationId: 'org-1',
      contactId: 'contact-1',
    });
  });

  it('only selects and claims open conversations for automated nudges', async () => {
    const { prisma } = makePrisma({ leadId: 'lead-1', leadStatus: 'NEW_LEAD' });
    await runSalesColdFollowup(prisma);

    expect((prisma.conversation.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where).toMatchObject({
      status: 'OPEN',
    });
    expect((prisma.conversation.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where).toMatchObject({
      status: 'OPEN',
    });
  });

  describe('product context and photo  v2)', () => {
    it('sends the product photo as real media when the last-discussed product has one', async () => {
      const { prisma } = makePrisma({
        leadId: 'lead-1',
        leadStatus: 'NEW_LEAD',
        lastProductMessage: { productId: 'prod-1' },
        product: { id: 'prod-1', name: 'Lampu Tidur LED', sellPrice: 65000, imageUrl: 'https://x/photo.webp' },
      });
      await runSalesColdFollowup(prisma);

      expect(mocks.dispatchMediaToChannel).toHaveBeenCalledTimes(1);
      expect(mocks.dispatchMediaToChannel).toHaveBeenCalledWith(
        prisma, 'org-1', 'conv-1', 'https://x/photo.webp', 'image', expect.objectContaining({ caption: expect.any(String) }),
      );
      expect(mocks.dispatchToChannel).not.toHaveBeenCalled();
      expect((prisma.message.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toMatchObject({
        conversationId: 'conv-1',
        contentType: 'image',
        mediaUrls: ['https://x/photo.webp'],
      });
      expect((prisma.product.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0].where).toMatchObject({
        id: 'prod-1',
        organizationId: 'org-1',
        deletedAt: null,
      });
    });

    it('falls back to a text-only nudge when the last-discussed product has no photo', async () => {
      const { prisma } = makePrisma({
        leadId: 'lead-1',
        leadStatus: 'NEW_LEAD',
        lastProductMessage: { productId: 'prod-1' },
        product: { id: 'prod-1', name: 'Lampu Tidur LED', sellPrice: 65000, imageUrl: null },
      });
      await runSalesColdFollowup(prisma);

      expect(mocks.dispatchToChannel).toHaveBeenCalledTimes(1);
      expect(mocks.dispatchMediaToChannel).not.toHaveBeenCalled();
    });

    it('falls back to a generic static message — not the classes job\'s "kelas kami" default — when there is no product/agent to draft with', async () => {
      const { prisma } = makePrisma({ leadId: 'lead-1', leadStatus: 'NEW_LEAD', lastProductMessage: null, agentId: null });
      await runSalesColdFollowup(prisma);

      expect(mocks.invokeAgentOnce).not.toHaveBeenCalled();
      const [sentMessage] = (mocks.dispatchToChannel.mock.calls[0] as unknown[])[3] as string[];
      expect(sentMessage).toMatch(/masih berminat/);
      expect(sentMessage).not.toMatch(/kelas/i);
    });

    it('uses the AI-drafted message over the static fallback when drafting succeeds', async () => {
      mocks.invokeAgentOnce.mockResolvedValue('Halo! Lampu Tidur LED-nya masih ready, masih tertarik kah?');
      const { prisma } = makePrisma({
        leadId: 'lead-1',
        leadStatus: 'NEW_LEAD',
        lastProductMessage: { productId: 'prod-1' },
        product: { id: 'prod-1', name: 'Lampu Tidur LED', sellPrice: 65000, imageUrl: null },
        agentId: 'agent-1',
      });
      await runSalesColdFollowup(prisma);

      expect(mocks.invokeAgentOnce).toHaveBeenCalledWith(prisma, 'org-1', 'agent-1', expect.stringContaining('Lampu Tidur LED'));
      expect(mocks.dispatchToChannel).toHaveBeenCalledWith(prisma, 'org-1', 'conv-1', [
        'Halo! Lampu Tidur LED-nya masih ready, masih tertarik kah?',
      ]);
    });

    it('falls back to static copy when AI drafting rejects instead of losing the claimed conversation', async () => {
      mocks.invokeAgentOnce.mockRejectedValue(new Error('agent runtime down'));
      const { prisma } = makePrisma({
        leadId: 'lead-1',
        leadStatus: 'NEW_LEAD',
        lastProductMessage: { productId: 'prod-1' },
        product: { id: 'prod-1', name: 'Lampu Tidur LED', sellPrice: 65000, imageUrl: null },
        agentId: 'agent-1',
      });
      await runSalesColdFollowup(prisma);

      expect(mocks.dispatchToChannel).toHaveBeenCalledTimes(1);
      const [sentMessage] = (mocks.dispatchToChannel.mock.calls[0] as unknown[])[3] as string[];
      expect(sentMessage).toMatch(/masih berminat/);
      expect(prisma.conversation.update).not.toHaveBeenCalled();
    });

    it('finds the product via SKU mentioned in the transcript when send_product_photo was never called', async () => {
      const { prisma } = makePrisma({
        leadId: 'lead-1',
        leadStatus: 'NEW_LEAD',
        lastProductMessage: null,
        product: { id: 'prod-2', name: 'Blender Portable', sellPrice: 175000, imageUrl: 'https://x/blender.webp' },
        transcript: [
          { content: 'Ada blender gak?', participantType: 'CUSTOMER' },
          { content: 'Untuk **Blender Portable (SKU: 010008) Rp175.000/pcs**, tersedia ya.', participantType: 'AI' },
        ],
      });
      await runSalesColdFollowup(prisma);

      expect((prisma.product.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0].where).toMatchObject({
        sku: '010008',
        organizationId: 'org-1',
      });
      expect(mocks.dispatchMediaToChannel).toHaveBeenCalledWith(
        prisma, 'org-1', 'conv-1', 'https://x/blender.webp', 'image', expect.objectContaining({ caption: expect.any(String) }),
      );
    });

    it('builds transcript/product context only from visible non-failed messages in the organization', async () => {
      const { prisma } = makePrisma({
        leadId: 'lead-1',
        leadStatus: 'NEW_LEAD',
        lastProductMessage: null,
        product: null,
        agentId: 'agent-1',
        transcript: [
          { content: 'Ada blender gak?', participantType: 'CUSTOMER' },
          { content: 'Untuk Blender Portable (SKU 000000) Rp175.000/pcs, tersedia ya.', participantType: 'AI' },
        ],
      });
      await runSalesColdFollowup(prisma);

      expect((prisma.message.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where).toMatchObject({
        conversationId: 'conv-1',
        conversation: { organizationId: 'org-1' },
        isPrivate: false,
        status: { not: 'FAILED' },
      });
      expect((prisma.message.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0].where).toMatchObject({
        conversationId: 'conv-1',
        conversation: { organizationId: 'org-1' },
        isPrivate: false,
        status: { not: 'FAILED' },
      });
    });

    it('feeds the recent transcript into the AI drafting prompt so it can reference what was actually discussed', async () => {
      const { prisma } = makePrisma({
        leadId: 'lead-1',
        leadStatus: 'NEW_LEAD',
        lastProductMessage: null,
        product: null,
        agentId: 'agent-1',
        transcript: [
          { content: 'Ada blender gak?', participantType: 'CUSTOMER' },
          { content: 'Untuk Blender Portable (SKU 000000) Rp175.000/pcs, tersedia ya.', participantType: 'AI' },
        ],
      });
      await runSalesColdFollowup(prisma);

      expect(mocks.invokeAgentOnce).toHaveBeenCalledWith(
        prisma, 'org-1', 'agent-1', expect.stringContaining('Ada blender gak?'),
      );
    });

    it('reverts the claim so the conversation can be retried when the image dispatch fails', async () => {
      mocks.dispatchMediaToChannel.mockResolvedValue({ ok: false, error: 'provider timeout' });
      const { prisma } = makePrisma({
        leadId: 'lead-1',
        leadStatus: 'NEW_LEAD',
        lastProductMessage: { productId: 'prod-1' },
        product: { id: 'prod-1', name: 'Lampu Tidur LED', sellPrice: 65000, imageUrl: 'https://x/photo.webp' },
      });
      await runSalesColdFollowup(prisma);

      expect((prisma.conversation.update as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
        where: { id: 'conv-1' },
        data: { followupCount: 0, lastFollowupAt: null },
      });
    });
  });
});
