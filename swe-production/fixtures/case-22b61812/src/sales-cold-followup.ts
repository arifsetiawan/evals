
import { Queue, Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { ensurePatternJobScheduler, getRedisConnection } from '../queue';
import { getOptedInOrgIds } from '../lib/cron-opt-in';
import { orgReengageConfig } from './wa-cold-reengagement';
import { invokeAgentOnce } from '../lib/sdr-agent-invoke';

export const SALES_COLD_FOLLOWUP_QUEUE = 'sales-cold-followup';

const AI_DRAFT_MAX_LENGTH = 500;
// Only used if AI drafting is unavailable or fails (see draftColdFollowupMessage)
// — generic on purpose, this job runs for any org, not just classes-adjacent
// ones. Do not reuse wa-cold-reengagement's "kelas kami" default here.
const GENERIC_DEFAULT_MESSAGE =
  'Halo Kak, apakah masih berminat dengan produk yang ditanyakan sebelumnya? Kalau ada yang bisa kami bantu, kabari saja ya.';

function formatIdr(value: unknown): string {
  return `Rp${Number(value || 0).toLocaleString('id-ID')}`;
}

// Config lives on OrgCronJob.config (an internal module —
// the schema's own designated home for "per-job parameters", e.g.
// reservation-reminder's leadTime), not features.leadFollowUp — that surface
// stays owned by orgReengageConfig for enabled/coldHours/message, shared with
// the classes job. A dedicated Settings UI field editor already exists for
// OrgCronJob.config (CRON_JOB_CONFIG_FIELDS), so this is what a merchant
// actually configures, not something requiring script access. This only
// covers cadence timing (a scheduling parameter) — discount/offer policy is
// deliberately not here, see the note below draftColdFollowupMessage.
type JobConfig = {
  touch1Hours?: unknown;
  touch2Hours?: unknown;
  touch3Hours?: unknown;
};

// Ordered hours-since-last-customer-message per touch, built from the fixed
// 3-slot Settings UI (touch1Hours/touch2Hours/touch3Hours) — 0 or unset on a
// slot stops the cadence there (e.g. touch3Hours: 0 = a 2-touch cadence).
// Falls back to a single touch at the legacy coldReengageHours value when no
// OrgCronJob config row exists yet, so orgs already using this job before
// cadence support keep their behavior.
function resolveCadenceHours(config: JobConfig | null, legacyColdHours: number): number[] {
  if (!config) return [legacyColdHours];
  const hours: number[] = [];
  for (const raw of [config.touch1Hours, config.touch2Hours, config.touch3Hours]) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) break; // stop at the first unset/zero slot
    hours.push(n);
  }
  return hours.length > 0 ? hours : [legacyColdHours];
}

// touchIndex is 0-based (0 = first touch). Tells the AI which stage this is
// and to defer to its own configured policy — never hands it a number,
// because the job has no way to know what that number should be; only the
// AI reading its own instructions/knowledge base does.
function buildDiscountGuidance(touchIndex: number, isFinalTouch: boolean): string {
  if (touchIndex <= 0) {
    return 'This is the first check-in — do not mention any discount or offer yet, just ask if they are still interested.';
  }
  return [
    'If your instructions or knowledge base describe a discount, promo, or closing offer for a hesitant customer, you may apply it now — never invent one that is not actually configured.',
    isFinalTouch
      ? 'This is the final follow-up in the cadence — if you do have a real offer to give, this is the moment to lead with it, framed as time-limited.'
      : 'Keep any offer modest at this stage — save your strongest offer for the final follow-up.',
  ].join(' ');
}

type ProductContext = { id: string; name: string; sellPrice: unknown; imageUrl: string | null } | null;
type TranscriptMessage = { content: string; participantType: string };

const TRANSCRIPT_LIMIT = 12;
const TRANSCRIPT_LINE_MAX_CHARS = 300;

async function fetchRecentTranscript(prisma: PrismaClient, organizationId: string, conversationId: string): Promise<TranscriptMessage[]> {
  const messages = await prisma.message.findMany({
    where: {
      conversationId,
      conversation: { organizationId },
      isPrivate: false,
      status: { not: 'FAILED' },
    },
    orderBy: { createdAt: 'desc' },
    take: TRANSCRIPT_LIMIT,
    select: { content: true, participantType: true },
  });
  return messages.reverse(); // chronological
}

function formatTranscript(messages: TranscriptMessage[]): string | null {
  if (messages.length === 0) return null;
  return messages
    .map((m) => `${m.participantType}: ${m.content.slice(0, TRANSCRIPT_LINE_MAX_CHARS)}`)
    .join('\n');
}

// Same shape the agent's own replies already cite in-line (confirmed by
// direct transcript inspection: "Blender Portable (SKU 000000)") — used only
// as a fallback when send_product_photo was never called, so there's no
// structured productId to key off.
function extractSkuMentions(messages: TranscriptMessage[]): string[] {
  const skus: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const matches = messages[i].content.matchAll(/SKU\s*:?\s*([A-Za-z0-9._-]{3,})/gi);
    for (const match of matches) {
      if (!skus.includes(match[1])) skus.push(match[1]);
    }
  }
  return skus;
}

async function findLastProductContext(
  prisma: PrismaClient,
  organizationId: string,
  conversationId: string,
  transcript: TranscriptMessage[],
): Promise<ProductContext> {
  const taggedMsg = await prisma.message.findFirst({
    where: {
      conversationId,
      conversation: { organizationId },
      isPrivate: false,
      status: { not: 'FAILED' },
      metadata: { path: ['sentViaTool'], equals: 'send_product_photo' },
    },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true },
  });
  const taggedProductId = taggedMsg?.metadata && typeof taggedMsg.metadata === 'object' && !Array.isArray(taggedMsg.metadata)
    ? (taggedMsg.metadata as Record<string, unknown>).productId
    : null;
  if (typeof taggedProductId === 'string' && taggedProductId) {
    const product = await prisma.product.findFirst({
      where: { id: taggedProductId, organizationId, deletedAt: null },
      select: { id: true, name: true, sellPrice: true, imageUrl: true },
    });
    if (product) return product;
  }

  const skus = extractSkuMentions(transcript); // most-recently-mentioned first
  if (skus.length === 0) return null;
  return prisma.product.findFirst({
    where: { sku: skus[0], organizationId, deletedAt: null },
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
  transcriptText: string | null,
  touchIndex: number,
  isFinalTouch: boolean,
  staticFallback: string,
): Promise<string> {
  if (!agentId) return staticFallback;

  const touchLabel = `touch ${touchIndex + 1}${isFinalTouch ? ' (final)' : ''} of this follow-up cadence`;
  const prompt = [
    `Draft a short, warm WhatsApp follow-up for a customer who asked about a product and then went quiet — this is ${touchLabel}, in the tone you normally use.`,
    transcriptText
      ? `Here is the recent conversation with this customer, oldest first (participantType: content):\n${transcriptText}`
      : 'No conversation history is on record — keep it general and ask what they were looking for.',
    product
      ? `The product on record for this conversation is ${product.name} (${formatIdr(product.sellPrice)}, already shared with them) — reference it specifically, don't just say "the product you asked about."`
      : 'Identify what they were asking about from the conversation above and reference it specifically — do not send a generic "which product were you asking about" message if the transcript already says what it was.',
    'Ask if they are still interested. You may restate the price since it was already shared, and you may invite them to ask about bulk/special pricing.',
    buildDiscountGuidance(touchIndex, isFinalTouch),
    isFinalTouch
      ? 'This is the last follow-up you will send on this conversation — if they do not respond, we will stop reaching out, so it is okay to make this one count.'
      : null,
    'Keep it under 400 characters, one message only.',
  ].filter(Boolean).join('\n');

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
  touchIndex: number,
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
        metadata: { caption: message, sentViaTool: 'sales_cold_followup', productId: product.id, touchIndex },
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

//  — mark the Lead behind a conversation LOST once its cold-followup
// cadence exhausts with no reply or order. Exported for direct unit testing.
// Scoped by organizationId + status: {notIn: ['WON','LOST']}, same guard
// pattern as markLeadWonForConversation — if the Lead already closed WON in
// the meantime (a payment race), this simply no-ops on that row instead of
// overwriting it.
export async function markExhaustedLeadsLost(
  prisma: PrismaClient,
  organizationId: string,
  cadenceLength: number,
): Promise<void> {
  const exhausted = await prisma.conversation.findMany({
    where: {
      organizationId,
      deletedAt: null,
      status: 'OPEN',
      channel: { type: 'WHATSAPP' },
      leadId: { not: null },
      followupCount: { gte: cadenceLength },
    },
    select: { leadId: true },
    take: 200,
  });
  const leadIds = [...new Set(exhausted.map((c) => c.leadId).filter((id): id is string => !!id))];
  if (!leadIds.length) return;

  await prisma.lead.updateMany({
    where: { id: { in: leadIds }, organizationId, deletedAt: null, status: { notIn: ['WON', 'LOST'] } },
    data: {
      status: 'LOST',
      lostReason: 'Tidak ada respons setelah follow-up otomatis selesai',
      actualCloseDate: new Date(),
    },
  });
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

      const cronJob = await prisma.orgCronJob.findUnique({
        where: { organizationId_jobName: { organizationId, jobName: SALES_COLD_FOLLOWUP_QUEUE } },
        select: { config: true },
      });
      const jobConfig = (cronJob?.config as JobConfig | null) ?? null;
      const cadenceHours = resolveCadenceHours(jobConfig, cfg.coldHours);
      // Rough prefilter only — the exact per-touch threshold (cadenceHours[touchIndex])
      // varies by how far along a given conversation already is in the cadence,
      // so it's checked precisely per-conversation below, not in this query.
      const roughCutoff = new Date(now.getTime() - Math.min(...cadenceHours) * 60 * 60 * 1000);

      const conversations = await prisma.conversation.findMany({
        where: {
          organizationId,
          deletedAt: null,
          status: 'OPEN',
          channel: { type: 'WHATSAPP' },
          lastCustomerMessageAt: { not: null, lt: roughCutoff }, // customer went quiet, at least the shortest touch's worth
          OR: [{ followupCount: null }, { followupCount: { lt: cadenceHours.length } }], // cadence not yet exhausted
        },
        select: { id: true, contactId: true, lastCustomerMessageAt: true, lastFollowupAt: true, leadId: true, followupCount: true },
        take: 100,
      });

      for (const convo of conversations) {
        if (!convo.contactId || !convo.lastCustomerMessageAt) continue;

        const touchIndex = convo.followupCount ?? 0;
        if (touchIndex >= cadenceHours.length) continue; // cadence already exhausted
        const requiredMs = cadenceHours[touchIndex] * 60 * 60 * 1000;
        if (now.getTime() - convo.lastCustomerMessageAt.getTime() < requiredMs) continue; // not due for this touch yet
        const isFinalTouch = touchIndex === cadenceHours.length - 1;

        //  — check both conversion signals, skip on either. The
        // Conversation now links to the open Lead ensureOpenProspectOpportunity
        // finds-or-creates for the contact (webhookUtils.ts
        // findOrCreateConversation).  — the Lead behind an AI inbox
        // order (an internal module's create_inbox_order) is
        // marked WON only once that order is actually paid (dashboard's
        // Xendit webhook / manual mark-paid route, see
        // an internal module's markLeadWonForConversation)
        // — not at order-creation time, since an order can sit unpaid for
        // hours or lapse to CANCELLED. So a WON/LOST Lead is a reliable
        // "don't nudge" signal — but its absence is not proof they're still
        // unconverted (no leadId at all, or the Lead update lost a race) —
        // the direct SalesOrder/AIInboxOrder checks below catch an AI-taken,
        // already-paid order independent of whether the Lead was updated.
        if (convo.leadId) {
          const lead = await prisma.lead.findUnique({
            where: { id: convo.leadId },
            select: { status: true },
          });
          if (lead && (lead.status === 'WON' || lead.status === 'LOST')) continue;
        }
        const [convertedSince, inboxOrderSince] = await Promise.all([
          prisma.salesOrder.findFirst({
            where: {
              organizationId,
              contactId: convo.contactId,
              createdAt: { gte: convo.lastCustomerMessageAt },
            },
            select: { id: true },
          }),
          //  — a WA/chat customer converts via the AI's own
          // create_inbox_order tool (AIInboxOrder), not the dashboard's
          // SalesOrder path — this is the common case for this job, not the
          // exception, so it must be checked directly, not just via SalesOrder.
          // Only a PAID order counts as converted: an order can sit UNPAID
          // for hours (the reservation TTL is per-terminal configurable, up
          // to 24h) or lapse into CANCELLED if the customer never pays — in
          // both cases they are still a legitimate follow-up target, not a
          // closed sale, so an unpaid/cancelled order must not silence the
          // cadence.
          prisma.aIInboxOrder.findFirst({
            where: {
              organizationId,
              contactId: convo.contactId,
              deletedAt: null,
              paymentStatus: 'PAID',
              createdAt: { gte: convo.lastCustomerMessageAt },
            },
            select: { id: true },
          }),
        ]);
        if (convertedSince || inboxOrderSince) continue;

        // Claim this specific touch — the where-clause must match the exact
        // current followupCount (not just "< cadence length") so two
        // concurrent runs can't both advance the same conversation past the
        // same touch.
        const claimed = await prisma.conversation.updateMany({
          where: {
            id: convo.id,
            organizationId,
            deletedAt: null,
            status: 'OPEN',
            lastCustomerMessageAt: convo.lastCustomerMessageAt,
            followupCount: convo.followupCount ?? null,
          },
          data: { followupCount: touchIndex + 1, lastFollowupAt: now },
        });
        if (claimed.count !== 1) continue; // lost the race (or another job already claimed it)

        const [transcript, agentId] = await Promise.all([
          fetchRecentTranscript(prisma, organizationId, convo.id),
          resolveConversationAgentId(prisma, convo.id),
        ]);
        const product = await findLastProductContext(prisma, organizationId, convo.id, transcript);
        const message = await draftColdFollowupMessage(
          prisma, organizationId, agentId, product, formatTranscript(transcript),
          touchIndex, isFinalTouch, cfg.message,
        );

        const sent = await sendColdFollowup(prisma, organizationId, convo.id, message, product, touchIndex);
        if (sent) {
          continue;
        }
        // Revert to exactly what it was before this claim, not a hardcoded
        // 0 — a mid-cadence touch that fails to send must retry that same
        // touch next tick, not restart the whole cadence from touch 1 or
        // erase the timestamp from the prior successful touch.
        await prisma.conversation.update({
          where: { id: convo.id },
          data: { followupCount: convo.followupCount ?? null, lastFollowupAt: convo.lastFollowupAt ?? null },
        });
      }

      //  — nothing else in this codebase ever marks a Lead LOST for
      // this flow. Without this, a Lead whose cadence exhausted with no
      // reply/order sat open forever, and ensureOpenProspectOpportunity
      // (an internal module) only starts a fresh Lead
      // once the old one is WON/LOST — so a customer's next, unrelated visit
      // months later silently reused the stale, abandoned Lead (wrong stage,
      // wrong notes, wrong everything). The `conversations` query above
      // already excludes cadence-exhausted conversations (followupCount >=
      // cadenceHours.length), so this is a separate, deliberately inverted
      // query — not reachable from the loop above.
      await markExhaustedLeadsLost(prisma, organizationId, cadenceHours.length);
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
