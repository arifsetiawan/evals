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
 *  — a customer who asks about a product and goes quiet, with
 * no order ever placed, must get exactly one nudge. Things this pins down:
 * (1) nudging someone who already converted — via the dashboard's manual
 * order flow (SalesOrder, marks the linked Lead WON) or via the AI agent's
 * own create_inbox_order (AIInboxOrder — a distinct model that never becomes
 * a SalesOrder; now also marks the linked Lead WON, see pos.ts) — must never
 * happen. All signals (Lead status, SalesOrder, AIInboxOrder) are checked
 * independently, since a missing leadId or a lost race can make any one of
 * them alone unreliable.
 * (2) the nudge itself must reference the actual product discussed and
 * re-send its photo as real media when one exists, not a generic text ping —
 * that's the whole point of this job over a plain "are you still there?".
 */
function makePrisma(params: {
  leadId?: string | null;
  leadStatus?: string;
  hasOrderSinceLastMessage?: boolean;
  hasInboxOrderSinceLastMessage?: boolean;
  lastProductMessage?: { productId: string } | null;
  product?: { id: string; name: string; sellPrice: number; imageUrl: string | null } | null;
  agentId?: string | null;
  transcript?: Array<{ content: string; participantType: string }>;
  followupCount?: number | null;
  lastFollowupAt?: Date | null;
  hoursSinceLastMessage?: number;
  cadenceHours?: number[];
}) {
  const hoursAgo = params.hoursSinceLastMessage ?? 999; // default: comfortably past any cadence step
  const conversation = {
    id: 'conv-1',
    contactId: 'contact-1',
    lastCustomerMessageAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
    lastFollowupAt: params.lastFollowupAt ?? null,
    leadId: params.leadId ?? null,
    followupCount: params.followupCount ?? null,
  };

  // Cadence config lives on OrgCronJob.config (Settings → Automation), not
  // features.leadFollowUp — translate the test's array shape into the fixed
  // touch1Hours/touch2Hours/touch3Hours shape the job actually reads.
  const jobConfig = params.cadenceHours !== undefined
    ? {
        touch1Hours: params.cadenceHours[0] ?? null,
        touch2Hours: params.cadenceHours[1] ?? null,
        touch3Hours: params.cadenceHours[2] ?? null,
      }
    : null;

  return {
    conversation,
    prisma: {
      organization: {
        findUnique: vi.fn(async () => ({
          features: { leadFollowUp: { enabled: true, coldReengageHours: 24 } },
        })),
      },
      orgCronJob: {
        findUnique: vi.fn(async () => (jobConfig ? { config: jobConfig } : null)),
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
      aIInboxOrder: {
        findFirst: vi.fn(async () => (params.hasInboxOrderSinceLastMessage ? { id: 'aiord-1' } : null)),
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

  it('does not nudge when a SalesOrder exists even if the Lead was never marked WON (a lost race, not the common path)', async () => {
    const { prisma } = makePrisma({ leadId: 'lead-1', leadStatus: 'NEW_LEAD', hasOrderSinceLastMessage: true });
    await runSalesColdFollowup(prisma);
    expect(mocks.dispatchToChannel).not.toHaveBeenCalled();
  });

  it('does not nudge when an AIInboxOrder exists since the customer last messaged, even with no leadId ', async () => {
    const { prisma } = makePrisma({ leadId: null, hasInboxOrderSinceLastMessage: true });
    await runSalesColdFollowup(prisma);
    expect(mocks.dispatchToChannel).not.toHaveBeenCalled();
  });

  it('does not nudge when an AIInboxOrder exists even if the Lead was never marked WON — the common WA-order path ', async () => {
    const { prisma } = makePrisma({ leadId: 'lead-1', leadStatus: 'NEW_LEAD', hasInboxOrderSinceLastMessage: true });
    await runSalesColdFollowup(prisma);
    expect(mocks.dispatchToChannel).not.toHaveBeenCalled();
  });

  it('nudges when there is no leadId and no order of either kind at all', async () => {
    const { prisma } = makePrisma({ leadId: null, hasOrderSinceLastMessage: false, hasInboxOrderSinceLastMessage: false });
    await runSalesColdFollowup(prisma);
    expect(mocks.dispatchToChannel).toHaveBeenCalledTimes(1);
  });

  it('scopes the sales-order and inbox-order lookups to the organization and contact', async () => {
    const { prisma } = makePrisma({ leadId: 'lead-1', leadStatus: 'NEW_LEAD' });
    await runSalesColdFollowup(prisma);
    expect((prisma.salesOrder.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0].where).toMatchObject({
      organizationId: 'org-1',
      contactId: 'contact-1',
    });
    expect((prisma.aIInboxOrder.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0].where).toMatchObject({
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

    it('reverts the claim to its exact prior state (not a hardcoded 0) when the image dispatch fails', async () => {
      mocks.dispatchMediaToChannel.mockResolvedValue({ ok: false, error: 'provider timeout' });
      const priorLastFollowupAt = new Date('2026-07-20T02:00:00.000Z');
      const { prisma } = makePrisma({
        leadId: 'lead-1',
        leadStatus: 'NEW_LEAD',
        lastProductMessage: { productId: 'prod-1' },
        product: { id: 'prod-1', name: 'Lampu Tidur LED', sellPrice: 65000, imageUrl: 'https://x/photo.webp' },
        cadenceHours: [24, 72, 168],
        followupCount: 1, // mid-cadence (touch 2 of 3) — a fresh conversation would be null, not 0
        lastFollowupAt: priorLastFollowupAt,
      });
      await runSalesColdFollowup(prisma);

      expect((prisma.conversation.update as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
        where: { id: 'conv-1' },
        data: { followupCount: 1, lastFollowupAt: priorLastFollowupAt },
      });
    });
  });

  describe('configurable multi-touch cadence  v3)', () => {
    it('does not fire touch 2 until its own configured delay has elapsed, even though touch 1\'s delay already has', async () => {
      const { prisma } = makePrisma({
        leadId: 'lead-1',
        leadStatus: 'NEW_LEAD',
        cadenceHours: [24, 72, 168], // Day+1 / Day+3 / Day+7
        followupCount: 1, // touch 1 already sent, waiting on touch 2's 72h
        hoursSinceLastMessage: 30, // past touch 1's 24h, nowhere near touch 2's 72h
      });
      await runSalesColdFollowup(prisma);

      expect(mocks.dispatchToChannel).not.toHaveBeenCalled();
      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    });

    it('fires touch 2 once its own configured delay has elapsed', async () => {
      const { prisma } = makePrisma({
        leadId: 'lead-1',
        leadStatus: 'NEW_LEAD',
        cadenceHours: [24, 72, 168],
        followupCount: 1,
        hoursSinceLastMessage: 80, // past touch 2's 72h threshold
      });
      await runSalesColdFollowup(prisma);

      expect(mocks.dispatchToChannel).toHaveBeenCalledTimes(1);
      expect((prisma.conversation.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toMatchObject({ followupCount: 2 });
    });

    it('never fires again once the cadence is exhausted', async () => {
      const { prisma } = makePrisma({
        leadId: 'lead-1',
        leadStatus: 'NEW_LEAD',
        cadenceHours: [24, 72, 168],
        followupCount: 3, // already sent all 3 touches
        hoursSinceLastMessage: 999,
      });
      await runSalesColdFollowup(prisma);

      expect(mocks.dispatchToChannel).not.toHaveBeenCalled();
      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    });

    it('falls back to a single touch at the legacy coldReengageHours when cadenceHours is not configured', async () => {
      const { prisma } = makePrisma({ leadId: 'lead-1', leadStatus: 'NEW_LEAD', hoursSinceLastMessage: 30 });
      await runSalesColdFollowup(prisma);

      expect(mocks.dispatchToChannel).toHaveBeenCalledTimes(1);
      expect((prisma.conversation.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toMatchObject({ followupCount: 1 });
    });
  });

  describe('discount/offer guidance defers to the agent\'s own instructions  v3)', () => {
    // No maxDiscountPct/discountOfferNote knob exists — the job has no way
    // to know what a merchant's actual policy is, so it never hands the AI a
    // number. It only tells the AI which touch this is; buildSystemPrompt()
    // (an internal module) already loads the agent's own configured
    // Instructions into every invokeAgentOnce call, so a real policy written
    // there (same surface as brand voice and the bulk-pricing guardrail)
    // reaches the AI without this job needing to read or resolve it itself.
    it('tells the AI not to mention any offer on the first touch', async () => {
      const { prisma } = makePrisma({
        leadId: 'lead-1', leadStatus: 'NEW_LEAD', agentId: 'agent-1',
        cadenceHours: [24, 72, 168], followupCount: 0, hoursSinceLastMessage: 30,
      });
      await runSalesColdFollowup(prisma);

      const [, , , prompt] = mocks.invokeAgentOnce.mock.calls[0];
      expect(prompt).toMatch(/do not mention any discount or offer yet/i);
    });

    it('tells the AI to keep any offer modest on a mid-cadence touch, deferring to its own instructions', async () => {
      const { prisma } = makePrisma({
        leadId: 'lead-1', leadStatus: 'NEW_LEAD', agentId: 'agent-1',
        cadenceHours: [24, 72, 168], followupCount: 1, hoursSinceLastMessage: 80,
      });
      await runSalesColdFollowup(prisma);

      const [, , , prompt] = mocks.invokeAgentOnce.mock.calls[0];
      expect(prompt).toMatch(/instructions or knowledge base describe a discount/i);
      expect(prompt).toMatch(/keep any offer modest at this stage/i);
      expect(prompt).not.toMatch(/%/); // never hands the AI a number — it has none to give
    });

    it('tells the AI it may lead with its strongest configured offer only on the final touch', async () => {
      const { prisma } = makePrisma({
        leadId: 'lead-1', leadStatus: 'NEW_LEAD', agentId: 'agent-1',
        cadenceHours: [24, 72, 168], followupCount: 2, hoursSinceLastMessage: 200,
      });
      await runSalesColdFollowup(prisma);

      const [, , , prompt] = mocks.invokeAgentOnce.mock.calls[0];
      expect(prompt).toMatch(/final follow-up in the cadence/i);
      expect(prompt).toMatch(/time-limited/i);
    });
  });
});
