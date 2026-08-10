import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { uuidv7 } from 'uuidv7';
import { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { requireModuleWrite } from '@/lib/auth/moduleGate';
import { prisma } from '@/lib/db';
import { lineFingerprint, statementFingerprint } from '@/lib/accounting/bankFingerprint';
import { parseDateOnly } from '@/lib/utils/timezone';

function parseDate(value: string) { return parseDateOnly(value); }

type ParsedStatement = {
  transactions?: Array<{ date: string; description: string; amount: number; type: 'DEBIT' | 'CREDIT'; reference?: string | null }>;
  openingBalance?: unknown;
  closingBalance?: unknown;
};

// A statement with no balance column stores an explicit `closingBalance: null`.
// `Number(null)` is 0, so an unguarded coercion would read "no balance" as a
// real zero and snapshot bankBalance=0 over whatever the account actually had.
function finiteMoney(value: unknown): number | null {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireModuleWrite('accounting'); if (denied) return denied;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.user.organizationId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params; const organizationId = session.user.organizationId;
  const item = await prisma.bankStatementInboxItem.findFirst({ where: { id, organizationId } });
  if (!item) return NextResponse.json({ error: 'Statement not found.' }, { status: 404 });
  if (item.status !== 'READY_TO_CHECK') return NextResponse.json({ error: 'Statement is not ready for automatic check.' }, { status: 409 });
  const statement = item.parsedStatement as ParsedStatement | null;
  const transactions = statement?.transactions ?? [];
  if (!transactions.length) return NextResponse.json({ error: 'No parsed statement transactions.' }, { status: 422 });
  const closingBalance = finiteMoney(statement?.closingBalance);
  const statementEndDate = transactions
    .map((transaction) => parseDate(transaction.date))
    .reduce<Date | null>((latest, date) => !latest || date > latest ? date : latest, null);
  const reconciliation = await prisma.bankReconciliation.upsert({
    where: { organizationId_accountId_period: { organizationId, accountId: item.accountId, period: item.period } },
    create: { id: uuidv7(), number: `RECON-${Date.now().toString(36).toUpperCase()}`, organizationId, accountId: item.accountId, period: item.period },
    update: {},
  });
  if (reconciliation.status === 'COMPLETED') return NextResponse.json({ error: 'Reconciliation is completed; reopen before checking a new statement.' }, { status: 409 });
  const fingerprint = statementFingerprint(transactions.map((tx) => ({ date: tx.date, amount: tx.amount, type: tx.type, reference: tx.reference ?? null, description: tx.description })));
  const existingImport = await prisma.bankStatementImport.findFirst({ where: { reconciliationId: reconciliation.id, fingerprint } });
  if (existingImport) { await prisma.bankStatementInboxItem.update({ where: { id }, data: { status: 'DUPLICATE', fingerprint, reconciliationId: reconciliation.id, error: 'This statement was already imported for this account and period.' } }); return NextResponse.json({ error: 'Duplicate statement.', reconciliationId: reconciliation.id }, { status: 409 }); }
  const existing = await prisma.bankTransaction.findMany({ where: { reconciliationId: reconciliation.id, fingerprint: { not: null } }, select: { fingerprint: true } });
  const seen = new Set(existing.map((row) => row.fingerprint)); const importId = uuidv7(); const rows = [] as Array<Record<string, unknown>>; let duplicates = 0;
  for (const tx of transactions) { const fp = lineFingerprint({ date: tx.date, amount: tx.amount, type: tx.type, reference: tx.reference ?? null, description: tx.description }); if (seen.has(fp)) { duplicates += 1; continue; } seen.add(fp); rows.push({ id: uuidv7(), reconciliationId: reconciliation.id, organizationId, date: parseDate(tx.date), description: tx.description, amount: tx.amount, type: tx.type, reference: tx.reference ?? null, fingerprint: fp, statementImportId: importId }); }
  try {
    await prisma.$transaction(async (db) => {
      const storedEndDate = reconciliation.statementEndDate ? new Date(reconciliation.statementEndDate) : null;
      const shouldRefreshStatementSnapshot = closingBalance != null && statementEndDate != null
        && (!storedEndDate || statementEndDate >= storedEndDate);
      if (shouldRefreshStatementSnapshot) {
        await db.bankReconciliation.update({
          where: { id: reconciliation.id },
          data: { bankBalance: closingBalance, statementEndDate },
        });
      }
      await db.bankStatementImport.create({ data: { id: importId, organizationId, reconciliationId: reconciliation.id, fileEntryId: item.fileEntryId, parser: item.parser || 'csv', fingerprint, totalRows: transactions.length, insertedRows: rows.length, duplicateRows: duplicates, importedBy: session.user!.id! } });
      if (rows.length) await db.bankTransaction.createMany({ data: rows as any });
      await db.bankStatementInboxItem.update({ where: { id }, data: { status: 'CHECKED', fingerprint, reconciliationId: reconciliation.id, checkedAt: new Date(), error: null } });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      await prisma.bankStatementInboxItem.updateMany({
        where: { id, organizationId, status: 'READY_TO_CHECK' },
        data: { status: 'DUPLICATE', fingerprint, reconciliationId: reconciliation.id, error: 'This statement was already imported for this account and period.' },
      });
      return NextResponse.json({ error: 'Duplicate statement.', reconciliationId: reconciliation.id }, { status: 409 });
    }
    throw error;
  }
  return NextResponse.json({ reconciliationId: reconciliation.id, importId, insertedRows: rows.length, duplicateRows: duplicates });
}
