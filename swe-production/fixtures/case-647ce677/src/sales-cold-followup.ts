
import { Queue, Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { ensurePatternJobScheduler, getRedisConnection } from '../queue';
import { getOptedInOrgIds } from '../lib/cron-opt-in';
import { orgReengageConfig } from './wa-cold-reengagement';
import { invokeAgentOnce } from '../lib/sdr-agent-invoke';

export const SALES_COLD_FOLLOWUP_QUEUE = 'sales-cold-followup';

const MAX_NUDGES = 1; // hard cap — one re-engagement per conversation, ever.
const AI_DRAFT_MAX_LENGTH = 500;
// Only used if AI drafting is unavailable or fails (see draftColdFollowupMessage)
// — generic on purpose, this job runs for any org, not just classes-adjacent
// ones. Do not reuse wa-cold-reengagement's "kelas kami" default here.
const GENERIC_DEFAULT_MESSAGE =
  'Halo Kak, apakah masih berminat dengan produk yang ditanyakan sebelumnya? Kalau ada yang bisa kami bantu, kabari saja ya.';

function formatIdr(value: unknown): string {
  return `Rp${Number(value || 0).toLocaleString('id-ID')}`;
}

type ProductContext = { id: string; name: string; sellPrice: unknown; imageUrl: string | null } | null;

async function findLastProductContext(
  prisma: PrismaClient,
  organizationId: string,
  conversationId: string,
): Promise<ProductContext> {
  const msg = await prisma.message.findFirst({
    where: {
      conversationId,
      metadata: { path: ['sentViaTool'], equals: 'send_product_photo' },
    },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true },
  });
  const productId = msg?.metadata && typeof msg.metadata === 'object' && !Array.isArray(msg.metadata)
    ? (msg.metadata as Record<string, unknown>).productId
    : null;
  if (typeof productId !== 'string' || !productId) return null;

  return prisma.product.findFirst({
    where: { id: productId, organizationId, deletedAt: null },
    select: { id: true, name: true, sellPrice: true, imageUrl: true },
  });
}

async function resolveConversationAgentId(prisma: PrismaClient, conversationId: string): Promise<string | null> {
  const exec = await prisma.aIAgentExecution.findFirst({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    select: { aiAgentId: true },
  });
  return exec?.aiAgentId ?? null;
}

async function draftColdFollowupMessage(
  prisma: PrismaClient,
  organizationId: string,
  agentId: string | null,
  product: ProductContext,
  staticFallback: string,
): Promise<string> {
  if (!agentId) return staticFallback;

  const prompt = [
    'Draft a short, warm WhatsApp check-in for a customer who asked about a product and then went quiet, in the tone you normally use.',
    product
      ? `Product they asked about: ${product.name} (${formatIdr(product.sellPrice)}, already shared with them).`
      : 'No specific product is on record for this conversation — keep it general and ask what they were looking for.',
    'Ask if they are still interested. You may restate the price since it was already shared, and you may invite them to ask about bulk/special pricing, but do not invent or promise a specific discount amount.',
    'Keep it under 400 characters, one message only.',
  ].join('\n');

  try {
    const draft = await invokeAgentOnce(prisma, organizationId, agentId, prompt);
    return draft && draft.length > 0 && draft.length <= AI_DRAFT_MAX_LENGTH ? draft : staticFallback;
  } catch (err) {
    console.error('[Sales Cold Followup] AI drafting failed:', err instanceof Error ? err.message : err);
    return staticFallback;
  }
}

async function sendColdFollowup(
  prisma: PrismaClient,
  organizationId: string,
  conversationId: string,
  message: string,
  product: ProductContext,
): Promise<boolean> {
  if (product?.imageUrl) {
    const { dispatchMediaToChannel } = await import('../channel-dispatch');
    const msgNumber = `MSG-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const messageId = uuidv7();
    await prisma.message.create({
      data: {
        id: messageId,
        number: msgNumber,
        conversationId,
        content: message,
        contentType: 'image',
        participantType: 'AI',
        status: 'SENT',
        mediaUrls: [product.imageUrl],
        metadata: { caption: message, sentViaTool: 'sales_cold_followup', productId: product.id },
      },
    });
    const result = await dispatchMediaToChannel(prisma, organizationId, conversationId, product.imageUrl, 'image', { caption: message });
    if (!result.ok) {
      await prisma.message.update({
        where: { id: messageId },
        data: { status: 'FAILED', providerStatus: result.error?.slice(0, 500) ?? 'dispatch failed' },
      });
      return false;
    }
    return true;
  }

  const { dispatchToChannel } = await import('../channel-dispatch');
  return dispatchToChannel(prisma, organizationId, conversationId, [message]);
}

export async function runSalesColdFollowup(prisma: PrismaClient) {
  const orgIds = await getOptedInOrgIds(prisma, SALES_COLD_FOLLOWUP_QUEUE);
  if (!orgIds.length) return;
  const now = new Date();

  for (const organizationId of orgIds) {
    try {
      const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { features: true } });
      const cfg = orgReengageConfig(org?.features, GENERIC_DEFAULT_MESSAGE);
      if (!cfg) continue;

      const cutoff = new Date(now.getTime() - cfg.coldHours * 60 * 60 * 1000);
      const conversations = await prisma.conversation.findMany({
        where: {
          organizationId,
          deletedAt: null,
          status: 'OPEN',
          channel: { type: 'WHATSAPP' },
          lastCustomerMessageAt: { not: null, lt: cutoff }, // customer went quiet
          OR: [{ followupCount: null }, { followupCount: { lt: MAX_NUDGES } }], // not already nudged
        },
        select: { id: true, contactId: true, lastCustomerMessageAt: true, leadId: true },
        take: 100,
      });

      for (const convo of conversations) {
        if (!convo.contactId || !convo.lastCustomerMessageAt) continue;

        //  — check both conversion signals, skip on either. The
        // Conversation now links to the open Lead ensureOpenProspectOpportunity
        // finds-or-creates for the contact (webhookUtils.ts
        // findOrCreateConversation), but create_inbox_order (an internal module,
        // the AI agent's own order-taking tool) does not mark that Lead WON
        // when the order completes — only the dashboard's manual order-create
        // route does. So a WON/LOST Lead is a reliable "don't nudge" signal,
        // but its absence is not proof they're still unconverted — the direct
        // SalesOrder check catches an AI-taken order that never touched the
        // Lead at all.
        if (convo.leadId) {
          const lead = await prisma.lead.findUnique({
            where: { id: convo.leadId },
            select: { status: true },
          });
          if (lead && (lead.status === 'WON' || lead.status === 'LOST')) continue;
        }
        const convertedSince = await prisma.salesOrder.findFirst({
          where: {
            organizationId,
            contactId: convo.contactId,
            createdAt: { gte: convo.lastCustomerMessageAt },
          },
          select: { id: true },
        });
        if (convertedSince) continue;

        const claimed = await prisma.conversation.updateMany({
          where: {
            id: convo.id,
            organizationId,
            deletedAt: null,
            status: 'OPEN',
            lastCustomerMessageAt: { not: null, lt: cutoff },
            OR: [{ followupCount: null }, { followupCount: { lt: MAX_NUDGES } }],
          },
          data: { followupCount: MAX_NUDGES, lastFollowupAt: now },
        });
        if (claimed.count !== 1) continue; // lost the race (or another job already claimed it)

        const [product, agentId] = await Promise.all([
          findLastProductContext(prisma, organizationId, convo.id),
          resolveConversationAgentId(prisma, convo.id),
        ]);
        const message = await draftColdFollowupMessage(prisma, organizationId, agentId, product, cfg.message);

        const sent = await sendColdFollowup(prisma, organizationId, convo.id, message, product);
        if (sent) {
          continue;
        }
        await prisma.conversation.update({
          where: { id: convo.id },
          data: { followupCount: 0, lastFollowupAt: null },
        });
      }
    } catch (err) {
      console.error(`[Sales Cold Followup] org ${organizationId} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

export function startSalesColdFollowupWorker(prisma: PrismaClient): { worker: Worker; queue: Queue } {
  const connection = getRedisConnection();
  const queue = new Queue(SALES_COLD_FOLLOWUP_QUEUE, { connection });

  const worker = new Worker(
    SALES_COLD_FOLLOWUP_QUEUE,
    async () => {
      await runSalesColdFollowup(prisma);
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, error) => console.error(`[Sales Cold Followup] Job ${job?.id} failed:`, error.message));
  worker.on('error', (error) => console.error('[Sales Cold Followup] Worker error:', error));

  ensurePatternJobScheduler(queue, {
    schedulerId: `${SALES_COLD_FOLLOWUP_QUEUE}-hourly`,
    name: SALES_COLD_FOLLOWUP_QUEUE,
    matchNameOnly: true,
    pattern: '0 * * * *', // hourly
    data: {},
    opts: { removeOnComplete: { count: 10 }, removeOnFail: { count: 10 } },
  })
    .then(() => console.log('[Sales Cold Followup] Scheduler ensured — hourly'))
    .catch((err: unknown) => console.error('[Sales Cold Followup] Failed to ensure scheduler:', err));

  return { worker, queue };
}
