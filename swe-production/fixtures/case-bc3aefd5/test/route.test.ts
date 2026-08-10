import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireModuleWrite: vi.fn(async () => null),
  itemFindFirst: vi.fn(),
  reconciliationUpsert: vi.fn(),
  statementImportFindFirst: vi.fn(),
  bankTransactionFindMany: vi.fn(),
  reconciliationUpdateMany: vi.fn(),
  statementImportCreate: vi.fn(),
  bankTransactionCreateMany: vi.fn(),
  inboxUpdate: vi.fn(),
}));

vi.mock('@/lib/auth/moduleGate', () => ({ requireModuleWrite: mocks.requireModuleWrite }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => ({ user: { id: 'user-1', organizationId: 'org-1' } })) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('uuidv7', () => ({ uuidv7: vi.fn(() => 'generated-id') }));
vi.mock('@/lib/utils/timezone', () => ({ parseDateOnly: (value: string) => new Date(`${value}T00:00:00.000Z`) }));
vi.mock('@/lib/db', () => ({
  prisma: {
    bankStatementInboxItem: { findFirst: mocks.itemFindFirst },
    bankReconciliation: { upsert: mocks.reconciliationUpsert },
    bankStatementImport: { findFirst: mocks.statementImportFindFirst },
    bankTransaction: { findMany: mocks.bankTransactionFindMany },
    $transaction: async (callback: (db: unknown) => Promise<unknown>) => callback({
      bankReconciliation: { updateMany: mocks.reconciliationUpdateMany },
      bankStatementImport: { create: mocks.statementImportCreate },
      bankTransaction: { createMany: mocks.bankTransactionCreateMany },
      bankStatementInboxItem: { update: mocks.inboxUpdate },
    }),
  },
}));

import { POST } from '../src/check__route';

const transactions = [
  { date: '2026-07-01', description: 'Opening activity', amount: 100_000, type: 'CREDIT' as const, reference: null },
  { date: '2026-07-07', description: 'Closing activity', amount: 25_000, type: 'DEBIT' as const, reference: null },
];

function inboxItem(closingBalance: number | null) {
  return {
    id: 'item-1', organizationId: 'org-1', accountId: 'account-1', period: '2026-07', fileEntryId: 'file-1', status: 'READY_TO_CHECK',
    parser: 'csv-spec', parsedStatement: { transactions, openingBalance: 1_000_000, closingBalance },
  };
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.requireModuleWrite.mockResolvedValue(null);
  mocks.statementImportFindFirst.mockResolvedValue(null);
  mocks.bankTransactionFindMany.mockResolvedValue([]);
  mocks.reconciliationUpdateMany.mockResolvedValue({ count: 1 });
  mocks.statementImportCreate.mockResolvedValue({});
  mocks.bankTransactionCreateMany.mockResolvedValue({ count: 2 });
  mocks.inboxUpdate.mockResolvedValue({});
});

describe('POST /api/accounting/bank-statements/[id]/check', () => {
  it('stores the parsed closing balance and statement cutoff with a fresh import', async () => {
    mocks.itemFindFirst.mockResolvedValue(inboxItem(1_075_000));
    mocks.reconciliationUpsert.mockResolvedValue({ id: 'recon-1', status: 'IN_PROGRESS', statementEndDate: null });

    const response = await POST(new Request('http://localhost') as never, { params: Promise.resolve({ id: 'item-1' }) });

    expect(response.status).toBe(200);
    expect(mocks.reconciliationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'recon-1',
        organizationId: 'org-1',
        OR: [
          { statementEndDate: null },
          { statementEndDate: { lt: new Date('2026-07-07T00:00:00.000Z') } },
        ],
      },
      data: { bankBalance: 1_075_000, statementEndDate: new Date('2026-07-07T00:00:00.000Z') },
    });
    expect(mocks.inboxUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CHECKED', reconciliationId: 'recon-1' }) }));
  });

  // The canonical-CSV parser always stores `closingBalance: null`. Coercing
  // that to 0 would wipe a bank balance the accountant entered by hand and move
  // the cutoff that bookBalance is computed against — a wrong difference on a
  // live set of books, with nothing on screen to say why.
  it('leaves the balance snapshot alone when the statement carries no closing balance', async () => {
    mocks.itemFindFirst.mockResolvedValue(inboxItem(null));
    mocks.reconciliationUpsert.mockResolvedValue({ id: 'recon-1', status: 'IN_PROGRESS', statementEndDate: null });

    const response = await POST(new Request('http://localhost') as never, { params: Promise.resolve({ id: 'item-1' }) });

    expect(response.status).toBe(200);
    expect(mocks.reconciliationUpdateMany).not.toHaveBeenCalled();
  });

  it('does not overwrite a newer statement snapshot with an older partial statement', async () => {
    mocks.itemFindFirst.mockResolvedValue(inboxItem(1_075_000));
    mocks.reconciliationUpsert.mockResolvedValue({ id: 'recon-1', status: 'IN_PROGRESS', statementEndDate: new Date('2026-07-31T00:00:00.000Z') });

    const response = await POST(new Request('http://localhost') as never, { params: Promise.resolve({ id: 'item-1' }) });

    expect(response.status).toBe(200);
    // The cutoff predicate is evaluated by the database at write time, so a
    // concurrent newer import cannot be replaced by this older statement.
    expect(mocks.reconciliationUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([{ statementEndDate: { lt: new Date('2026-07-07T00:00:00.000Z') } }]),
      }),
    }));
  });
});
