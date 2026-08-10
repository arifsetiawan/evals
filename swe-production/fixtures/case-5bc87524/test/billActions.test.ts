import { describe, it, expect } from 'vitest';
import { canVoidBill } from '../src/billActions';

const VOIDED = { source: 'purchase_bills_ui', voidedAt: '2026-07-30T12:58:29.626Z' };
const LIVE = { source: 'purchase_bills_ui', voidedAt: null };
const AT_RECEIPT = { source: 'direct_receipt', voidedAt: null };

describe('canVoidBill', () => {
  it('allows voiding an unsettled bill that was never paid', () => {
    expect(canVoidBill({ status: 'OPEN', isDirectReceipt: false, payments: [] })).toBe(true);
  });

  it('refuses a bill that still holds a live payment — voiding would strand the cash', () => {
    expect(canVoidBill({ status: 'OPEN', isDirectReceipt: false, payments: [LIVE] })).toBe(false);
  });

  it('refuses an already-cancelled bill', () => {
    expect(canVoidBill({ status: 'CANCELLED', isDirectReceipt: true, payments: [] })).toBe(false);
  });

  it('refuses a settled bill', () => {
    expect(canVoidBill({ status: 'PAID', isDirectReceipt: false, payments: [] })).toBe(false);
  });

  // The defect this file exists for. A voided payment posts its own compensating
  // journal and hands the amount back to outstanding, so it ties up no cash — yet
  // it used to still block the void, leaving the bill unpayable AND uncorrectable.
  it('allows voiding once the only payment has itself been voided', () => {
    expect(canVoidBill({ status: 'OPEN', isDirectReceipt: false, payments: [VOIDED] })).toBe(true);
  });

  it('allows voiding a direct receipt whose voided payment came from the bills UI', () => {
    expect(canVoidBill({ status: 'OPEN', isDirectReceipt: true, payments: [VOIDED] })).toBe(true);
  });

  it('still refuses when a live payment sits alongside a voided one', () => {
    expect(canVoidBill({ status: 'OPEN', isDirectReceipt: false, payments: [VOIDED, LIVE] })).toBe(false);
  });

  describe('direct receipts', () => {
    it('allows voiding a paid direct receipt — the void reverses the receipt, unwinding its cash', () => {
      expect(canVoidBill({ status: 'PAID', isDirectReceipt: true, payments: [AT_RECEIPT] })).toBe(true);
    });

    it('refuses a paid direct receipt settled by a separate payment, which has its own journal', () => {
      expect(canVoidBill({ status: 'PAID', isDirectReceipt: true, payments: [LIVE] })).toBe(false);
    });

    it('refuses a settled non-direct-receipt bill even with no payment rows', () => {
      expect(canVoidBill({ status: 'PAID', isDirectReceipt: false, payments: [] })).toBe(false);
    });
  });
});
