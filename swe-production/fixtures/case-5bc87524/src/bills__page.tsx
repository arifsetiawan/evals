'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Search, Eye, CreditCard, CheckCircle2, Clock, AlertCircle, FileText, Plus, Camera, Loader2, X, Ban, Pencil, ShieldCheck, ShieldAlert } from 'lucide-react';
import toast from 'react-hot-toast';
import { type ThreeWayMatchResult } from '@/lib/purchase/threeWayMatch';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { ListTable, ListTableActionButton, ListTableIdentifier, ListTableToolbar, type ListTableColumn } from '@/components/ui/ListTable';
import { MobileFilterButton, MobileSearchInput, PageFabButton } from '@/components/ui/MobileListControls';
import { DateRangePicker, type DateRangePickerValue } from '@/components/ui/DateRangePicker';
import { LIST_PERIOD_PRESETS } from '@/lib/date/periods';
import { NumericInput } from '@/components/ui/NumericInput';
import { EntityCombobox, EntityOption } from '@/components/ui/EntityCombobox';
import { OptionCombobox } from '@/components/ui/OptionCombobox';
import { AttachmentUploader, PendingAttachment } from '@/components/attachments/AttachmentUploader';
import { useLanguage } from '@/contexts/LanguageContext';
import { useConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useStoreFilter } from '@/lib/hooks/useStoreFilter';
import { useOrgTimezone } from '@/lib/hooks/useOrgTimezone';
import { formatDateOnlyForDisplay, formatTimestampDateForDisplay } from '@/lib/utils/client-date';
import { CorrectionApprovalNotice } from '@/components/corrections/CorrectionApprovalNotice';
import SignatureSurface from '@/components/signatures/SignatureSurface';
import { useEntityFilter, EntityFilterChip } from '@/hooks/useEntityFilter';

type BillStatus = 'DRAFT' | 'OPEN' | 'PENDING' | 'OVERDUE' | 'PAID' | 'PARTIALLY_PAID' | 'CANCELLED';

interface Bill {
  id: string;
  billNumber: string;
  vendor: string;
  vendorId?: string;
  vendorInvoiceNumber?: string | null;
  description: string;
  amount: number;
  paidAmount: number;
  outstanding: number;
  dueDate: string | null;
  status: BillStatus;
  paidAt: string | null;
  poStatus: string;
}

interface BillDetailItem {
  productName?: string;
  name?: string;
  quantity?: number;
  unit?: string;
  unitPrice?: number;
  subtotal?: number;
}

interface BillDetails {
  id: string;
  number: string;
  billDate: string;
  dueDate: string | null;
  amount: number;
  paidAmount: number;
  outstandingBalance: number;
  status: string;
  notes: string | null;
  billItems?: { name: string; quantity: number; unitPrice: number; total: number }[];
  receivedItems?: { name: string; quantity: number; unitPrice: number; total: number }[];
  goodsReceipts?: { id: string; number: string }[];
  charges?: { discount: number; shipping: number; tax: number };
  isDirectReceipt?: boolean;
  relatedDocuments?: {
    vendorAdvances: Array<{ id: string; number: string; amount: number; appliedAmount: number; status: string; purchaseOrderId: string | null }>;
    returns: Array<{ id: string; number: string; status: string; total: number; reason: string; purchaseOrderId: string | null; goodsReceivingId: string | null; purchaseBillId: string | null }>;
  };
  purchaseOrder?: {
    id: string;
    number: string;
    items: BillDetailItem[];
    subtotal: number;
    taxTotal: number;
    shippingTotal: number;
    grandTotal: number;
    status: string;
  } | null;
}

interface PaymentSuccess {
  bill: {
    id: string;
    number: string;
    paidAmount: number;
    status: BillStatus;
  };
}

interface PaymentMethodApiRow {
  id: string;
  enabled: boolean;
  method: string;
  label: string | null;
  cashAccountId: string | null;
  surfaces: string[];
}

const STATUS_COLORS: Record<BillStatus, string> = {
  DRAFT:     'bg-gray-100 text-gray-600',
  OPEN:      'bg-blue-100 text-blue-700',
  PENDING:   'bg-yellow-100 text-yellow-700',
  OVERDUE:   'bg-red-100 text-red-700',
  PAID:      'bg-green-100 text-green-700',
  PARTIALLY_PAID: 'bg-orange-100 text-orange-700',
  CANCELLED: 'bg-gray-100 text-gray-400',
};

const STATUS_ICONS: Record<BillStatus, React.ElementType> = {
  DRAFT:     FileText,
  OPEN:      FileText,
  PENDING:   Clock,
  OVERDUE:   AlertCircle,
  PAID:      CheckCircle2,
  PARTIALLY_PAID: AlertCircle,
  CANCELLED: FileText,
};

const PAGE_SIZE = 20;
const PAYABLE_BILL_STATUSES: BillStatus[] = ['OPEN', 'PENDING', 'OVERDUE', 'PARTIALLY_PAID'];
const BILL_STATUS_FILTER_OPTIONS: Array<BillStatus | 'All'> = [
  'All',
  'DRAFT',
  'OPEN',
  'PENDING',
  'OVERDUE',
  'PARTIALLY_PAID',
  'PAID',
  'CANCELLED',
];

function formatIDR(n: number) {
  return `Rp ${n.toLocaleString('id-ID')}`;
}

function canPayBill(bill: Bill) {
  return bill.outstanding > 0.005 && PAYABLE_BILL_STATUSES.includes(bill.status);
}

export default function VendorBillsPage() {
  const { t } = useLanguage();
  const [confirmEl, confirmAction] = useConfirmDialog();
  const { storeId } = useStoreFilter();
  const { timezone } = useOrgTimezone();

  const STATUS_LABELS: Record<BillStatus, string> = {
    DRAFT:     t('Draft', 'ui'),
    OPEN:      t('Open', 'ui'),
    PENDING:   t('Pending', 'ui'),
    OVERDUE:   t('Overdue', 'ui'),
    PAID:      t('Paid', 'ui'),
    PARTIALLY_PAID: t('Partially Paid', 'ui'),
    CANCELLED: t('Cancelled', 'ui'),
  };

  const [bills, setBills] = useState<Bill[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [dateRange, setDateRange] = useState<DateRangePickerValue>({ period: 'all', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const activeFilterCount = (statusFilter !== 'All' ? 1 : 0) + (dateRange.period !== 'all' ? 1 : 0);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [selectedBill, setSelectedBill] = useState<Bill | null>(null);
  const searchParams = useSearchParams();
  const deepLinkHandledRef = useRef(false);
  const [billPayments, setBillPayments] = useState<Array<{ id: string; amount: number; paymentDate: string; notes: string | null; paymentMethod?: string | null; paymentMethodId?: string | null; source?: string | null; voidedAt?: string | null; fundingAccount?: { name: string | null; code: string | null } | null }>>([]);
  // Inline edit of a recorded payment (routes through the document-correction
  // standard: same-day applies, older needs approval).
  const [editPaymentId, setEditPaymentId] = useState<string | null>(null);
  const [editPaymentForm, setEditPaymentForm] = useState<{ amount: string; paymentDate: string; paymentMethodId: string; notes: string }>({ amount: '', paymentDate: '', paymentMethodId: '', notes: '' });
  const [savingPaymentEdit, setSavingPaymentEdit] = useState(false);
  const [voidPaymentId, setVoidPaymentId] = useState<string | null>(null);
  const [voidPaymentDate, setVoidPaymentDate] = useState('');
  const [savingPaymentVoid, setSavingPaymentVoid] = useState(false);
  const [showPaymentDrawer, setShowPaymentDrawer] = useState(false);
  const [paymentBill, setPaymentBill] = useState<Bill | null>(null);
  const [paymentForm, setPaymentForm] = useState<{
    amount: string;
    paymentDate: string;
    vendorInvoiceNumber: string;
    notes: string;
    idempotencyKey: string;
  }>({
    amount: '',
    paymentDate: new Date().toISOString().slice(0, 10),
    vendorInvoiceNumber: '',
    notes: '',
    idempotencyKey: '',
  });
  const [paymentAttachments, setPaymentAttachments] = useState<PendingAttachment[]>([]);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentSuccess, setPaymentSuccess] = useState<PaymentSuccess | null>(null);
  const [cashAccounts, setCashAccounts] = useState<Array<{ id: string; code: string; name: string }>>([]);
  // Configurable payment methods scoped to PURCHASE_BILL (Settings → Payment
  // Methods). The chosen method drives the funding (paid-from) account server-side
  // — the operator never picks a raw GL account. Must be chosen explicitly.
  const [selectedPayMethodId, setSelectedPayMethodId] = useState<string>('');
  const [billPayMethods, setBillPayMethods] = useState<Array<{ id: string; label: string; cashAccountId: string }>>([]);
  // Open vendor advances (uang muka) for the bill's vendor that can settle it —
  // selecting one in the method picker applies it (Dr AP / Cr Vendor Advance)
  // instead of paying from cash/bank.
  const [vendorAdvances, setVendorAdvances] = useState<Array<{ id: string; number: string; remaining: number }>>([]);
  const [roundingThreshold, setRoundingThreshold] = useState(1000);
  const [billDetails, setBillDetails] = useState<BillDetails | null>(null);
  const [loadingBillDetails, setLoadingBillDetails] = useState(false);
  const [voidingBill, setVoidingBill] = useState<Bill | null>(null);
  const [billVoidReason, setBillVoidReason] = useState('');
  const [billVoidSaving, setBillVoidSaving] = useState(false);
  //  three-way match (PO vs received vs invoice). Detail drawer + payment block.
  const [selectedMatch, setSelectedMatch] = useState<ThreeWayMatchResult | null>(null);
  const [paymentMatch, setPaymentMatch] = useState<ThreeWayMatchResult | null>(null);

  // Fetch payments every time a bill detail drawer opens. Keeps the drawer in
  // sync with any payments that landed via the Pay button or the agent tool
  // `record_bill_payment` since the list was last loaded.
  useEffect(() => {
    if (!selectedBill) { setBillPayments([]); setBillDetails(null); setSelectedMatch(null); return; }
    let cancelled = false;

    // Three-way match (only meaningful when the bill is linked to a PO; the
    // endpoint returns 400 otherwise, which we treat as "no match available").
    setSelectedMatch(null);
    fetch(`/api/purchase/bills/${selectedBill.id}/match`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setSelectedMatch(d?.matchResult ?? null); })
      .catch(() => { if (!cancelled) setSelectedMatch(null); });

    // Fetch payments
    fetch(`/api/purchase/bills/${selectedBill.id}/payments`)
      .then(r => r.ok ? r.json() : { payments: [] })
      .then(data => { if (!cancelled) setBillPayments(data.payments || []); })
      .catch(() => { if (!cancelled) setBillPayments([]); });

    // Fetch bill details (including items from PO)
    setLoadingBillDetails(true);
    fetch(`/api/purchase/bills/${selectedBill.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled) { setBillDetails(data?.bill || null); setLoadingBillDetails(false); } })
      .catch(() => { if (!cancelled) { setBillDetails(null); setLoadingBillDetails(false); } });

    return () => { cancelled = true; };
  }, [selectedBill]);

  // Deep-link: open the bill detail drawer for ?billId= (loaded list first, else fetch).
  useEffect(() => {
    if (deepLinkHandledRef.current) return;
    const id = searchParams.get('billId');
    if (!id) return;
    const row = bills.find((b) => b.id === id);
    if (row) { setSelectedBill(row); deepLinkHandledRef.current = true; return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/purchase/bills/${id}`);
        if (!res.ok) return;
        const data = await res.json();
        const b = data?.bill;
        if (cancelled || !b) return;
        setSelectedBill({
          id: b.id,
          billNumber: b.number,
          vendor: b.vendor?.name ?? '',
          vendorId: b.vendor?.id,
          vendorInvoiceNumber: null,
          description: b.notes ?? '',
          amount: Number(b.amount) || 0,
          paidAmount: Number(b.paidAmount) || 0,
          outstanding: Number(b.outstandingBalance) || 0,
          dueDate: b.dueDate ?? null,
          status: b.status,
          paidAt: null,
          poStatus: b.purchaseOrder?.status ?? '',
        });
        deepLinkHandledRef.current = true;
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [bills, searchParams]);

  const [actionError, setActionError] = useState<string | null>(null);

  // Fetch cash/bank accounts + payment methods + rounding when either the
  // payment drawer OR a bill detail drawer opens (the detail drawer hosts the
  // inline payment-edit form, which needs the method list + rounding).
  useEffect(() => {
    if (!showPaymentDrawer && !selectedBill) return;
    let cancelled = false;

    try {
      fetch('/api/accounting/accounts?limit=200')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (cancelled) return;
          const accts = (data?.data || data?.accounts || []) as Array<{ id: string; code: string; name: string; type: string; category?: string }>;
          const cashAccts = accts
            .filter((a) => {
              const text = `${a.code} ${a.name} ${a.category || ''}`;
              return a.type === 'ASSET' && /\b(cash|kas|bank)\b/i.test(text);
            })
            .map((a) => ({ id: a.id, code: a.code, name: a.name }));
          setCashAccounts(cashAccts);
        })
        .catch(() => { if (!cancelled) setCashAccounts([]); });

      fetch('/api/settings/payments')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (cancelled) return;
          const rows = Array.isArray(data?.methods) ? data.methods as PaymentMethodApiRow[] : [];
          const methods = rows
            .filter((m) => m.enabled && Array.isArray(m.surfaces) && m.surfaces.includes('PURCHASE_BILL'))
            .map((m) => ({ id: m.id, label: m.label || m.method, cashAccountId: m.cashAccountId ?? '' }));
          setBillPayMethods(methods);
        })
        .catch(() => { if (!cancelled) setBillPayMethods([]); });

      fetch('/api/settings/organization')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (cancelled) return;
          const value = Number(data?.organization?.features?.roundingThreshold);
          if (Number.isFinite(value) && value >= 0) setRoundingThreshold(value);
        })
        .catch(() => { /* fallback stays at default */ });
    } catch (err) {
      console.error('Error loading cash accounts:', err);
    }

    return () => { cancelled = true; };
  }, [showPaymentDrawer, selectedBill]);

  // Fetch bill details when payment bill changes
  useEffect(() => {
    if (!paymentBill) { setBillDetails(null); setVendorAdvances([]); return; }
    let cancelled = false;
    setLoadingBillDetails(true);
    setVendorAdvances([]);

    // Open advances for this vendor (remaining > 0) — offered as a payment source.
    if (paymentBill.vendorId) {
      fetch(`/api/purchase/vendor-advances?vendorId=${encodeURIComponent(paymentBill.vendorId)}&limit=50`)
        .then((r) => (r.ok ? r.json() : { advances: [] }))
        .then((data) => {
          if (cancelled) return;
          const open = (Array.isArray(data?.advances) ? data.advances : [])
            .map((a: { id: string; number: string; amount: number; appliedAmount: number; status: string }) => ({
              id: a.id,
              number: a.number,
              remaining: Math.max(0, Number(a.amount || 0) - Number(a.appliedAmount || 0)),
              status: a.status,
            }))
            .filter((a: { remaining: number; status: string }) => a.remaining > 0.005 && !['CANCELLED', 'REFUNDED'].includes(a.status))
            .map(({ id, number, remaining }: { id: string; number: string; remaining: number }) => ({ id, number, remaining }));
          setVendorAdvances(open);
        })
        .catch(() => { if (!cancelled) setVendorAdvances([]); });
    } else {
      setVendorAdvances([]);
    }

    fetch(`/api/purchase/bills/${paymentBill.id}`)
      .then(r => r.ok ? r.json() : { bill: null })
      .then(data => {
        if (!cancelled) {
          setBillDetails(data.bill || null);
        }
      })
      .catch(err => {
        console.error('Error loading bill details:', err);
        if (!cancelled) setBillDetails(null);
      })
      .finally(() => { if (!cancelled) setLoadingBillDetails(false); });

    return () => { cancelled = true; };
  }, [paymentBill]);
  // Create bill drawer state
  const [showCreateDrawer, setShowCreateDrawer] = useState(false);
  const [selectedVendor, setSelectedVendor] = useState<EntityOption | null>(null);
  const [selectedPO, setSelectedPO] = useState<EntityOption | null>(null);
  const [newBill, setNewBill] = useState({
    amount: '',
    billDate: new Date().toISOString().slice(0, 10),
    dueDate: '',
    vendorInvoiceNumber: '',
    notes: '',
  });
  const [billAttachments, setBillAttachments] = useState<PendingAttachment[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // /purchase/bills?vendorId=<id> — search fan-out sends people to this supplier's
  // bills, not to every bill. The API already accepted the filter; the page ignored it.
  const { value: vendorFilter, clear: clearVendorFilter } = useEntityFilter('vendorId');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (searchQuery.trim()) params.set('search', searchQuery.trim());
      if (statusFilter !== 'All') params.set('status', statusFilter);
      if (storeId) params.set('storeId', storeId);
      if (dateRange.from) params.set('from', dateRange.from);
      if (dateRange.to) params.set('to', dateRange.to);
      if (vendorFilter) params.set('vendorId', vendorFilter);
      const res = await fetch(`/api/purchase/bills?${params.toString()}`);
      const data = await res.json();
      setBills(data.bills || []);
      setTotal(data.pagination?.total ?? (data.bills?.length || 0));
    } catch (error) {
      console.error('[purchase/bills] fetch error:', error);
    } finally {
      setLoading(false);
    }
  }, [page, searchQuery, statusFilter, storeId, dateRange.from, dateRange.to, vendorFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Reset to first page when filters (not the page itself) change.
  useEffect(() => {
    setPage(1);
  }, [searchQuery, statusFilter, storeId, dateRange.from, dateRange.to, vendorFilter]);

  const searchVendors = useCallback(async (query: string): Promise<EntityOption[]> => {
    try {
      const params = new URLSearchParams({ limit: '20' });
      if (query) params.set('search', query);
      const res = await fetch(`/api/purchase/vendors?${params.toString()}`);
      const data = await res.json();
      const rows = Array.isArray(data?.vendors) ? data.vendors : [];
      return rows.map((v: any) => ({ id: v.id, label: v.name, sublabel: v.email || v.phoneNumber || undefined }));
    } catch (e) {
      console.error('[purchase/bills] vendor search error:', e);
      return [];
    }
  }, []);

  const searchPOs = useCallback(async (query: string): Promise<EntityOption[]> => {
    try {
      const params = new URLSearchParams({ limit: '20' });
      if (query) params.set('search', query);
      if (selectedVendor?.id) params.set('vendorId', selectedVendor.id);
      const res = await fetch(`/api/purchase/orders?${params.toString()}`);
      const data = await res.json();
      const rows = Array.isArray(data?.orders) ? data.orders : Array.isArray(data?.purchaseOrders) ? data.purchaseOrders : [];
      return rows.map((po: any) => ({
        id: po.id,
        label: po.number || po.number || po.id,
        sublabel: `${po.vendor?.name || ''}${po.status ? ' · ' + po.status : ''}${po.grandTotal ? ' · Rp ' + Number(po.grandTotal).toLocaleString('id-ID') : ''}`.trim(),
      }));
    } catch (e) {
      console.error('[purchase/bills] PO search error:', e);
      return [];
    }
  }, [selectedVendor?.id]);

  function searchCashAccounts(query: string): EntityOption[] {
    const q = query.trim().toLowerCase();
    return cashAccounts
      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.code.toLowerCase().includes(q))
      .map((a) => ({ id: a.id, label: a.name, sublabel: a.code }));
  }

  async function handleCreateBill() {
    setCreating(true);
    setCreateError(null);
    try {
      if (!selectedVendor?.id) {
        const message = t('Vendor required', 'ui');
        setCreateError(message);
        toast.error(message);
        return;
      }
      const amt = parseFloat(newBill.amount);
      if (!amt || amt <= 0) {
        const message = t('Amount must be > 0', 'ui');
        setCreateError(message);
        toast.error(message);
        return;
      }
      const res = await fetch('/api/purchase/bills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorId: selectedVendor.id,
          amount: amt,
          billDate: newBill.billDate,
          dueDate: newBill.dueDate || undefined,
          purchaseOrderId: selectedPO?.id || undefined,
          vendorInvoiceNumber: newBill.vendorInvoiceNumber || undefined,
          notes: newBill.notes || undefined,
          attachments: billAttachments.length ? billAttachments : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = typeof data?.error === 'string' ? data.error : t('Failed to create bill', 'ui');
        setCreateError(message);
        toast.error(message);
        return;
      }
      setShowCreateDrawer(false);
      setSelectedVendor(null);
      setSelectedPO(null);
      setNewBill({ amount: '', billDate: new Date().toISOString().slice(0, 10), dueDate: '', vendorInvoiceNumber: '', notes: '' });
      setBillAttachments([]);
      fetchData();
    } catch (e) {
      console.error('[purchase/bills] create error:', e);
      const message = t('Failed to create bill', 'ui');
      setCreateError(message);
      toast.error(message);
    } finally {
      setCreating(false);
    }
  }

  async function handlePay(bill: Bill) {
    setActionError(null);
    setPaymentError(null);
    setPaymentSuccess(null);
    setPaymentAttachments([]);
    setSelectedPayMethodId('');
    setPaymentBill(bill);
    // Load the three-way match so the payment drawer can warn / block on an
    // EXCEPTION before money goes out. Reuse the detail-drawer result if it's
    // for the same bill, otherwise fetch.
    if (selectedBill?.id === bill.id) {
      setPaymentMatch(selectedMatch);
    } else {
      setPaymentMatch(null);
      try {
        const res = await fetch(`/api/purchase/bills/${bill.id}/match`);
        setPaymentMatch(res.ok ? (await res.json()).matchResult ?? null : null);
      } catch {
        setPaymentMatch(null);
      }
    }
    setPaymentForm({
      amount: String(bill.outstanding || bill.amount),
      paymentDate: new Date().toISOString().slice(0, 10),
      vendorInvoiceNumber: bill.vendorInvoiceNumber || '',
      notes: '',
      idempotencyKey: typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `pbp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    });
    setShowPaymentDrawer(true);
  }

  // --- Payment edit / void (document-correction standard: same-day applies,
  // older needs approval). Both POST /api/purchase/corrections with
  // targetModel 'PurchaseBillPayment'. ---
  function startEditPayment(p: { id: string; amount: number; paymentDate: string; notes: string | null; paymentMethodId?: string | null }) {
    setEditPaymentId(p.id);
    setEditPaymentForm({
      amount: String(p.amount),
      paymentDate: p.paymentDate.slice(0, 10),
      paymentMethodId: p.paymentMethodId || '',
      notes: p.notes || '',
    });
  }

  async function submitEditPayment() {
    if (!editPaymentId || !selectedBill) return;
    const amount = Number(editPaymentForm.amount || 0);
    if (!(amount > 0)) { toast.error(t('Payment amount must be greater than 0', 'ui')); return; }
    setSavingPaymentEdit(true);
    try {
      const res = await fetch('/api/purchase/corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetModel: 'PurchaseBillPayment',
          targetId: editPaymentId,
          payload: { documentUpdate: {
            amount,
            paymentDate: editPaymentForm.paymentDate,
            notes: editPaymentForm.notes,
            ...(editPaymentForm.paymentMethodId ? { paymentMethodId: editPaymentForm.paymentMethodId } : {}),
          } },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error || t('Failed to save', 'ui')); return; }
      toast.success(data.status === 'applied' ? t('Payment updated', 'ui') : t('Correction submitted for approval', 'ui'));
      setEditPaymentId(null);
      await reloadBillPayments();
      fetchData();
    } catch { toast.error(t('Failed to save', 'ui')); } finally { setSavingPaymentEdit(false); }
  }

  function startVoidPayment(p: { id: string; paymentDate: string }) {
    setVoidPaymentId(p.id);
    setVoidPaymentDate(p.paymentDate.slice(0, 10));
  }

  async function handleVoidPayment(paymentId: string) {
    if (!selectedBill) return;
    if (!voidPaymentDate) { toast.error(t('Void date is required', 'ui')); return; }
    const ok = await confirmAction(t('Void this payment? The amount returns to the bill outstanding.', 'ui'), {
      title: t('Void Payment', 'ui'),
      confirmLabel: t('Void', 'ui'),
      variant: 'danger',
    });
    if (!ok) return;
    setSavingPaymentVoid(true);
    try {
      const res = await fetch('/api/purchase/corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetModel: 'PurchaseBillPayment', targetId: paymentId, payload: { action: 'VOID', voidDate: voidPaymentDate } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error || t('Failed to void', 'ui')); return; }
      toast.success(data.status === 'applied' ? t('Payment voided', 'ui') : t('Correction submitted for approval', 'ui'));
      setVoidPaymentId(null);
      await reloadBillPayments();
      fetchData();
    } catch { toast.error(t('Failed to void', 'ui')); } finally { setSavingPaymentVoid(false); }
  }

  async function reloadBillPayments() {
    if (!selectedBill) return;
    try {
      const r = await fetch(`/api/purchase/bills/${selectedBill.id}/payments`);
      const d = r.ok ? await r.json() : { payments: [] };
      setBillPayments(d.payments || []);
    } catch { /* keep current */ }
    // Refresh the bill summary (paidAmount/outstanding/status) shown in the drawer.
    try {
      const r2 = await fetch(`/api/purchase/bills/${selectedBill.id}`);
      if (r2.ok) {
        const b = await r2.json();
        const bd = b?.bill ?? b;
        if (bd) {
          setSelectedBill((prev) => prev ? {
            ...prev,
            amount: Number(bd.amount) || prev.amount,
            outstanding: Number(bd.outstandingBalance ?? bd.outstanding) || 0,
            paidAmount: Number(bd.paidAmount) || 0,
            status: bd.status || prev.status,
          } : prev);
        }
      }
    } catch { /* ignore */ }
  }

  // Void a bill — routes through the approval flow (POST /api/finance/void).
  // Unpaid bills and paid direct-receipt (cash) bills are accepted; the latter
  // also reverses the goods receipt. Bills with other payments are rejected.
  function handleVoidBill(bill: Bill) {
    setVoidingBill(bill);
    setBillVoidReason('');
  }

  async function submitVoidBill() {
    if (!voidingBill) return;
    setBillVoidSaving(true);
    try {
      const res = await fetch('/api/finance/void', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetModel: 'PurchaseBill',
          targetId: voidingBill.id,
          reason: billVoidReason.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Gagal memproses void');
        return;
      }
      toast.success(data.status === 'applied' ? 'Tagihan di-void' : 'Void diajukan, menunggu persetujuan');
      setVoidingBill(null);
      setBillVoidReason('');
      setSelectedBill(null);
      fetchData();
    } catch (err) {
      console.error('Error voiding bill:', err);
      toast.error('Gagal memproses void');
    } finally {
      setBillVoidSaving(false);
    }
  }

  async function handleSubmitPayment() {
    if (!paymentBill) return;
    //  payment block: a three-way match EXCEPTION means PO/received/invoice
    // disagree (price or qty). Don't hard-block — the buyer may still have a
    // valid reason — but force an explicit acknowledgement before money leaves.
    if (paymentMatch?.overallStatus === 'EXCEPTION') {
      const ok = await confirmAction(
        t('This bill has a three-way match exception (PO, goods received, and invoice do not agree). Pay anyway?', 'ui'),
        { title: t('Match exception', 'ui'), confirmLabel: t('Pay anyway', 'ui'), variant: 'danger' },
      );
      if (!ok) return;
    }
    setPayingId(paymentBill.id);
    setPaymentError(null);
    setPaymentSuccess(null);
    setActionError(null);
    try {
      const amount = Number(paymentForm.amount || 0);
      if (amount <= 0) {
        const message = t('Payment amount must be greater than 0', 'ui');
        setPaymentError(message);
        toast.error(message);
        return;
      }
      if (amount > paymentBill.outstanding + roundingThreshold) {
        const message = t('Payment amount cannot exceed outstanding balance', 'ui');
        setPaymentError(message);
        toast.error(message);
        return;
      }
      if (!selectedPayMethodId) {
        const message = t('Please select a payment method', 'ui');
        setPaymentError(message);
        toast.error(message);
        return;
      }
      // Pay with a vendor advance (uang muka): apply it to the bill (Dr AP / Cr
      // Vendor Advance, server caps at outstanding) instead of a cash payment.
      if (selectedPayMethodId.startsWith('advance:')) {
        const advanceId = selectedPayMethodId.slice('advance:'.length);
        const res = await fetch(`/api/purchase/vendor-advances/${advanceId}/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'apply', billId: paymentBill.id, amount, notes: paymentForm.notes || undefined }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          const message = typeof data?.error === 'string' ? data.error : t('Failed to apply advance', 'ui');
          setPaymentError(message);
          setActionError(message);
          toast.error(message);
          return;
        }
        const data = await res.json().catch(() => ({}));
        const appliedTotal = Number(data?.appliedTotal || amount);
        toast.success(t('Advance applied to bill', 'ui'));
        setPaymentForm({ amount: '', paymentDate: new Date().toISOString().slice(0, 10), vendorInvoiceNumber: paymentForm.vendorInvoiceNumber, notes: '', idempotencyKey: '' });
        setSelectedPayMethodId('');
        if (selectedBill) {
          setSelectedBill({ ...selectedBill, outstanding: Math.max(0, Number(selectedBill.outstanding || 0) - appliedTotal) });
        }
        await fetchData();
        setTimeout(() => { setShowPaymentDrawer(false); setPaymentBill(null); setPaymentSuccess(null); }, 1500);
        return;
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (paymentForm.idempotencyKey) headers['Idempotency-Key'] = paymentForm.idempotencyKey;
      const res = await fetch(`/api/purchase/bills/${paymentBill.id}/payments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          amount,
          paymentDate: paymentForm.paymentDate,
          vendorInvoiceNumber: paymentForm.vendorInvoiceNumber,
          paymentMethodId: selectedPayMethodId,
          notes: paymentForm.notes || undefined,
          attachments: paymentAttachments.length ? paymentAttachments : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = typeof data?.error === 'string' ? data.error : t('Failed to pay bill', 'ui');
        setPaymentError(message);
        setActionError(message);
        // The inline error sits at the top of the drawer and can be scrolled out
        // of view when the user submits from the bottom — toast so it's always seen.
        toast.error(message);
        return;
      }
      const result = await res.json();
      setPaymentSuccess(result);
      // Reset form for next payment
      setPaymentForm({
        amount: '',
        paymentDate: new Date().toISOString().slice(0, 10),
        vendorInvoiceNumber: paymentForm.vendorInvoiceNumber,
        notes: '',
        idempotencyKey: '',
      });
      setSelectedPayMethodId('');
      setPaymentAttachments([]);
      // Update selected bill and payments list
      if (selectedBill) {
        setSelectedBill({ ...selectedBill, outstanding: Math.max(0, Number(selectedBill.outstanding || 0) - amount), status: result.bill.status });
      }
      await fetchData();
      // Close drawer after 2 seconds
      setTimeout(() => {
        setShowPaymentDrawer(false);
        setPaymentBill(null);
        setPaymentSuccess(null);
      }, 2000);
    } catch (e) {
      console.error('[purchase/bills] pay error:', e);
      const message = t('Failed to pay bill', 'ui');
      setPaymentError(message);
      setActionError(message);
      toast.error(message);
    } finally {
      setPayingId(null);
    }
  }

  const columns: ListTableColumn<Bill>[] = [
    {
      key: 'bill',
      header: t('Bill No.', 'ui'),
      render: (bill) => (
        <ListTableIdentifier onClick={() => setSelectedBill(bill)} className="text-[#2B6CB0]">
          {bill.billNumber}
        </ListTableIdentifier>
      ),
    },
    {
      key: 'vendor',
      header: t('Vendor', 'ui'),
      className: 'text-gray-700',
      render: (bill) => bill.vendor,
    },
    {
      key: 'description',
      header: t('Description', 'ui'),
      className: 'text-gray-500 max-w-xs truncate',
      render: (bill) => bill.description,
    },
    {
      key: 'amount',
      header: t('Amount', 'ui'),
      align: 'right',
      className: 'font-medium text-gray-700 whitespace-nowrap',
      render: (bill) => (
        <div className="leading-tight">
          <div>{formatIDR(bill.amount)}</div>
          {Number(bill.paidAmount) > 0 && (
            <div className="text-[10px] font-normal text-green-700">{t('Paid', 'ui')} {formatIDR(Number(bill.paidAmount))}</div>
          )}
        </div>
      ),
    },
    {
      key: 'outstanding',
      header: t('Outstanding', 'ui'),
      align: 'right',
      className: 'whitespace-nowrap',
      render: (bill) => (
        <span className={bill.outstanding > 0 ? 'text-orange-600 font-medium' : 'text-gray-400'}>{formatIDR(bill.outstanding)}</span>
      ),
    },
    {
      key: 'due',
      header: t('Due Date', 'ui'),
      render: (bill) => (
        <span className={bill.status === 'OVERDUE' ? 'text-red-600 font-medium' : 'text-gray-500'}>
          {bill.dueDate ? formatDateOnlyForDisplay(bill.dueDate) : '-'}
        </span>
      ),
    },
    {
      key: 'status',
      header: t('Status', 'ui'),
      render: (bill) => {
        const Icon = STATUS_ICONS[bill.status] || Clock;
        return (
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[bill.status]}`}>
            <Icon size={10} />
            {STATUS_LABELS[bill.status]}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: t('Actions', 'ui'),
      align: 'right',
      render: (bill) => (
        <div className="flex items-center justify-end gap-1">
          <ListTableActionButton icon={<Eye size={14} />} onClick={() => setSelectedBill(bill)} title="Detail" aria-label="View bill detail" />
        </div>
      ),
    },
  ];

  return (
    <div className="h-full flex flex-col bg-white">
      {confirmEl}
      {vendorFilter && (
        <EntityFilterChip
          label={`Pemasok: ${bills[0]?.vendor || "terpilih"}`}
          onClear={clearVendorFilter}
        />
      )}
      <div className="hidden lg:block">
        <ListTableToolbar
          left={(
            <>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              type="text"
              placeholder={`${t('Search', 'ui')} vendor bills...`}
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
              className="pl-8 pr-3 py-1.5 border border-gray-200 rounded text-xs w-52 focus:outline-none focus:ring-2 focus:ring-[#2B6CB0]/20 focus:border-[#2B6CB0]"
            />
          </div>
          <OptionCombobox
            value={statusFilter}
            options={BILL_STATUS_FILTER_OPTIONS.map(s => ({ value: s, label: s === 'All' ? t('All Status', 'ui') : STATUS_LABELS[s] }))}
            onChange={v => { setStatusFilter(v); setPage(1); }}
            className="px-2 py-1.5 border border-gray-200 rounded text-xs focus:outline-none focus:ring-2 focus:ring-[#2B6CB0]/20 focus:border-[#2B6CB0] bg-white"
          />
          {!loading && <span className="text-xs text-gray-400 ml-1">{total} {t('bills', 'ui')}</span>}
            </>
          )}
          right={(
            <>
            <DateRangePicker value={dateRange} onApply={setDateRange} presets={LIST_PERIOD_PRESETS} />
            <Button
              module="purchase"
              size="sm"
              onClick={() => setShowCreateDrawer(true)}
            >
              <Plus size={12} className="mr-1" />
              {t('Create Bill', 'ui')}
            </Button>
            </>
          )}
        />
      </div>

      {/* Toolbar (mobile) */}
      <div className="lg:hidden flex-shrink-0 px-4 py-3 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <MobileSearchInput
            value={searchQuery}
            onChange={v => { setSearchQuery(v); setPage(1); }}
            placeholder={`${t('Search', 'ui')} vendor bills...`}
          />
        </div>
        <MobileFilterButton activeCount={activeFilterCount} onClick={() => setShowMobileFilters(true)} label={t('Filters', 'ui')} />
      </div>

      {/* Filters Drawer (mobile) */}
      <Drawer isOpen={showMobileFilters} onClose={() => setShowMobileFilters(false)} title={t('Filters', 'ui')}>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">{t('Status', 'ui')}</label>
            <OptionCombobox
              value={statusFilter}
              options={BILL_STATUS_FILTER_OPTIONS.map(s => ({ value: s, label: s === 'All' ? t('All Status', 'ui') : STATUS_LABELS[s] }))}
              onChange={v => { setStatusFilter(v); setPage(1); }}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">{t('Date Range', 'ui')}</label>
            <DateRangePicker value={dateRange} onApply={setDateRange} presets={LIST_PERIOD_PRESETS} />
          </div>
        </div>
      </Drawer>

      {/* Mobile-only FAB — desktop keeps the inline "Create Bill" button above. */}
      <PageFabButton module="purchase" icon={Plus} onClick={() => setShowCreateDrawer(true)} label={t('Create Bill', 'ui')} />

      {/* Table */}
      <div className="flex-1 overflow-auto px-4 pb-3">
        {actionError && (
          <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
            {actionError}
          </div>
        )}
        <ListTable
          columns={columns}
          rows={bills}
          getRowKey={(bill) => bill.id}
          isLoading={loading}
          emptyMessage={t('No vendor bills', 'ui')}
          page={page}
          total={total}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
        <p className="text-xs text-gray-400 mt-2">{t('Vendor bills info', 'ui')}</p>
      </div>

      {/* Create Bill Drawer */}
      <Drawer isOpen={showCreateDrawer} onClose={() => setShowCreateDrawer(false)} title={t('Create Vendor Bill', 'ui')} size="lg">
        <div className="space-y-3">
          {createError && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{createError}</div>
          )}
          <div>
            <label className="block text-xs text-gray-600 mb-1">{t('Vendor', 'ui')} <span className="text-red-500">*</span></label>
            <EntityCombobox
              value={selectedVendor}
              onChange={(opt) => { setSelectedVendor(opt); setSelectedPO(null); }}
              onSearch={searchVendors}
              placeholder={t('Search vendor...', 'ui')}
              fetchInitial
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">{t('Amount', 'ui')} (IDR) <span className="text-red-500">*</span></label>
              <NumericInput
                mode="decimal"
                min={0}
                value={newBill.amount}
                onChange={v => setNewBill({ ...newBill, amount: v })}
                className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs"
                placeholder="0"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">{t('Vendor Invoice No.', 'ui')}</label>
              <input
                type="text"
                value={newBill.vendorInvoiceNumber}
                onChange={e => setNewBill({ ...newBill, vendorInvoiceNumber: e.target.value })}
                className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs"
                placeholder="INV-001"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">{t('Bill Date', 'ui')}</label>
              <input
                type="date"
                value={newBill.billDate}
                onChange={e => setNewBill({ ...newBill, billDate: e.target.value })}
                className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">{t('Due Date', 'ui')}</label>
              <input
                type="date"
                value={newBill.dueDate}
                onChange={e => setNewBill({ ...newBill, dueDate: e.target.value })}
                className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">{t('Purchase Order (optional)', 'ui')}</label>
            <EntityCombobox
              key={selectedVendor?.id || 'no-vendor'}
              value={selectedPO}
              onChange={(opt) => setSelectedPO(opt)}
              onSearch={searchPOs}
              placeholder={selectedVendor ? t('Search PO...', 'ui') : t('Leave empty for standalone bill (e.g. utility)', 'ui')}
              fetchInitial
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">{t('Description', 'ui')}</label>
            <textarea
              value={newBill.notes}
              onChange={e => setNewBill({ ...newBill, notes: e.target.value })}
              rows={2}
              className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs"
              placeholder={t('e.g. Listrik PLN April 2026', 'ui')}
            />
          </div>
          <AttachmentUploader
            mode="pending"
            value={billAttachments}
            onChange={setBillAttachments}
            label={t('Invoice / Receipt photos', 'ui')}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setShowCreateDrawer(false)} disabled={creating}>
              {t('Cancel', 'ui')}
            </Button>
            <Button size="sm" onClick={handleCreateBill} disabled={creating}>
              {creating ? t('Creating...', 'ui') : t('Create Bill', 'ui')}
            </Button>
          </div>
        </div>
      </Drawer>

      {/* Detail Drawer — standardized header card + invoice-style line items */}
      <Drawer
        isOpen={!!selectedBill}
        onClose={() => setSelectedBill(null)}
        title={`${t('Bill', 'ui')} ${selectedBill?.billNumber || ''}`.trim() || t('Bill Detail', 'ui')}
        size="lg"
      >
        {selectedBill && (
          <div className="space-y-4">
            {/* Metadata header card */}
            <div className="rounded border border-gray-200 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-mono font-medium" style={{ color: '#2B6CB0' }}>{selectedBill.billNumber}</span>
                <span className="text-sm font-semibold text-gray-900">{formatIDR(selectedBill.amount)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{selectedBill.vendor || '—'}</p>
                  <p className="text-xs text-gray-500">
                    {billDetails?.billDate ? `${t('Bill Date', 'ui')}: ${formatDateOnlyForDisplay(billDetails.billDate)}` : t('Vendor bill', 'ui')}
                    {selectedBill.dueDate ? ` · ${t('Due Date', 'ui')}: ${formatDateOnlyForDisplay(selectedBill.dueDate)}` : ''}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[selectedBill.status]}`}>
                    {STATUS_LABELS[selectedBill.status]}
                  </span>
                  {selectedMatch && (() => {
                    const meta = selectedMatch.overallStatus === 'FULL_MATCH'
                      ? { label: t('3-way match', 'ui'), cls: 'bg-green-100 text-green-700', Icon: ShieldCheck }
                      : selectedMatch.overallStatus === 'WITHIN_TOLERANCE'
                        ? { label: t('Within tolerance', 'ui'), cls: 'bg-yellow-100 text-yellow-700', Icon: ShieldAlert }
                        : { label: t('Match exception', 'ui'), cls: 'bg-red-100 text-red-700', Icon: ShieldAlert };
                    const Icon = meta.Icon;
                    return (
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${meta.cls}`}>
                        <Icon size={12} />{meta.label}
                      </span>
                    );
                  })()}
                </div>
              </div>
            </div>

            {/*  three-way match detail — show variance lines when not a clean match */}
            {selectedMatch && selectedMatch.overallStatus !== 'FULL_MATCH' && (
              <div className={`rounded border p-3 ${selectedMatch.overallStatus === 'EXCEPTION' ? 'border-red-200 bg-red-50' : 'border-yellow-200 bg-yellow-50'}`}>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <ShieldAlert size={13} className={selectedMatch.overallStatus === 'EXCEPTION' ? 'text-red-600' : 'text-yellow-600'} />
                  <span className="text-xs font-semibold text-gray-900">
                    {selectedMatch.overallStatus === 'EXCEPTION'
                      ? t('Three-way match exception — PO, goods received, and invoice do not agree', 'ui')
                      : t('Within tolerance — minor variances below threshold', 'ui')}
                  </span>
                </div>
                <div className="space-y-1">
                  {selectedMatch.lines.filter(l => l.lineStatus !== 'MATCHED').map((l, idx) => (
                    <div key={idx} className="text-[11px] text-gray-700 flex flex-wrap gap-x-3">
                      <span className="font-medium text-gray-900">{l.itemName}</span>
                      {Math.abs(l.qtyVariance) > 0.0001 && (
                        <span>{t('Qty', 'ui')}: PO {l.poQty} / {t('GR', 'ui')} {l.grQty} / {t('Bill', 'ui')} {l.billQty} ({l.qtyVariancePct > 0 ? '+' : ''}{l.qtyVariancePct.toFixed(1)}%)</span>
                      )}
                      {Math.abs(l.priceVariance) > 0.0001 && (
                        <span>{t('Price', 'ui')}: PO {formatIDR(l.poUnitPrice)} / {t('Bill', 'ui')} {formatIDR(l.billUnitPrice)} ({l.priceVariancePct > 0 ? '+' : ''}{l.priceVariancePct.toFixed(1)}%)</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Line items — the RECEIVED items (what the bill is actually for),
                else the linked PO lines, else the flat bill amount as one line. */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {billDetails?.billItems && billDetails.billItems.length > 0
                  ? t('Bill items', 'ui')
                  : billDetails?.receivedItems && billDetails.receivedItems.length > 0 ? t('Received items', 'ui') : t('Items', 'ui')}
              </label>
              <div className="border border-gray-200 rounded">
                <div className="grid grid-cols-[1fr_72px_120px_120px] gap-2 px-2 py-1.5 bg-gray-50 border-b border-gray-200 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                  <span>{t('Description', 'ui')}</span>
                  <span className="text-center">{t('Qty', 'ui')}</span>
                  <span className="text-right">{t('Price', 'ui')}</span>
                  <span className="text-right">{t('Amount', 'ui')}</span>
                </div>
                {loadingBillDetails ? (
                  <div className="px-2 py-3 text-xs text-gray-400 text-center">{t('Loading...', 'ui')}</div>
                ) : (billDetails?.billItems && billDetails.billItems.length > 0 ? billDetails.billItems : billDetails?.receivedItems ?? []).length > 0 ? (
                  (billDetails?.billItems && billDetails.billItems.length > 0 ? billDetails.billItems : billDetails?.receivedItems ?? []).map((item, idx) => (
                    <div key={idx} className="grid grid-cols-[1fr_72px_120px_120px] gap-2 px-2 py-1.5 items-center border-b border-gray-100 last:border-0">
                      <span className="text-xs text-gray-900 truncate">{item.name || 'Item'}</span>
                      <span className="text-xs text-center text-gray-900">{item.quantity || 0}</span>
                      <span className="text-xs text-right text-gray-900">{formatIDR(item.unitPrice ?? 0)}</span>
                      <span className="text-xs text-right font-medium text-gray-900">{formatIDR(item.total)}</span>
                    </div>
                  ))
                ) : (billDetails?.purchaseOrder?.items && billDetails.purchaseOrder.items.length > 0) ? (
                  billDetails.purchaseOrder.items.map((item, idx) => (
                    <div key={idx} className="grid grid-cols-[1fr_72px_120px_120px] gap-2 px-2 py-1.5 items-center border-b border-gray-100 last:border-0">
                      <span className="text-xs text-gray-900 truncate">{item.productName || item.name || 'Item'}</span>
                      <span className="text-xs text-center text-gray-900">{item.quantity || 0}{item.unit ? ` ${item.unit}` : ''}</span>
                      <span className="text-xs text-right text-gray-900">{formatIDR(item.unitPrice ?? 0)}</span>
                      <span className="text-xs text-right font-medium text-gray-900">{formatIDR(item.subtotal ?? (Number(item.quantity || 0) * Number(item.unitPrice || 0)))}</span>
                    </div>
                  ))
                ) : (
                  <div className="grid grid-cols-[1fr_72px_120px_120px] gap-2 px-2 py-1.5 items-center">
                    <span className="text-xs text-gray-900 truncate">{selectedBill.description || t('Vendor bill', 'ui')}</span>
                    <span className="text-xs text-center text-gray-900">1</span>
                    <span className="text-xs text-right text-gray-900">{formatIDR(selectedBill.amount)}</span>
                    <span className="text-xs text-right font-medium text-gray-900">{formatIDR(selectedBill.amount)}</span>
                  </div>
                )}
              </div>
              <div className="space-y-1 text-xs pt-2">
                {(() => {
                  const c = billDetails?.charges;
                  const grossSubtotal = (billDetails?.receivedItems ?? []).reduce((s, it) => s + (Number(it.total) || 0), 0);
                  // Only show the breakdown when there's something to explain (a
                  // discount/shipping/tax that makes Σ lines ≠ Amount).
	                  if (!c || grossSubtotal <= 0 || (c.discount <= 0 && c.shipping <= 0 && c.tax <= 0)) return null;
                  return (
                    <>
                      <div className="flex justify-between"><span className="text-gray-500">{t('Subtotal', 'ui')}</span><span>{formatIDR(grossSubtotal)}</span></div>
	                      {c.discount > 0 && <div className="flex justify-between"><span className="text-gray-500">{t('Discount', 'ui')}</span><span className="text-gray-600">− {formatIDR(c.discount)}</span></div>}
	                      {c.shipping > 0 && <div className="flex justify-between"><span className="text-gray-500">{t('Shipping', 'ui')}</span><span className="text-gray-600">+ {formatIDR(c.shipping)}</span></div>}
	                      {c.tax > 0 && <div className="flex justify-between"><span className="text-gray-500">{t('Tax', 'ui')}</span><span className="text-gray-600">+ {formatIDR(c.tax)}</span></div>}
                    </>
                  );
                })()}
                <div className="flex justify-between"><span className="text-gray-500">{t('Amount', 'ui')}</span><span className="font-medium">{formatIDR(selectedBill.amount)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">{t('Outstanding', 'ui')}</span><span className="font-semibold text-gray-900">{formatIDR(selectedBill.outstanding)}</span></div>
              </div>
            </div>

            {/* Linked documents — PO + originating goods receipt(s). Each opens
                in a new tab with the target drawer auto-open. */}
            {(billDetails?.purchaseOrder
              || (billDetails?.goodsReceipts && billDetails.goodsReceipts.length > 0)
              || (billDetails?.relatedDocuments?.vendorAdvances && billDetails.relatedDocuments.vendorAdvances.length > 0)
              || (billDetails?.relatedDocuments?.returns && billDetails.relatedDocuments.returns.length > 0)) && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-gray-700">{t('Linked Documents', 'ui')}</label>
                {billDetails?.purchaseOrder && (
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-0.5">{t('Purchase Order', 'ui')}</p>
                    <Link
                      href={`/purchase?orderId=${billDetails.purchaseOrder.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs font-medium text-[#2B6CB0] hover:bg-gray-100 transition-colors"
                    >
                      {billDetails.purchaseOrder.number}
                    </Link>
                  </div>
                )}
                {billDetails?.goodsReceipts && billDetails.goodsReceipts.length > 0 && (
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-0.5">{t('Goods Receipt', 'ui')}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {billDetails.goodsReceipts.map((gr) => (
                        <Link
                          key={gr.id}
                          href={`/purchase/receiving?receivingId=${gr.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs font-medium text-[#2B6CB0] hover:bg-gray-100 transition-colors"
                        >
                          {gr.number}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                {billDetails?.relatedDocuments?.vendorAdvances && billDetails.relatedDocuments.vendorAdvances.length > 0 && (
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-0.5">{t('Uang Muka', 'ui')}</p>
                    <div className="space-y-1">
                      {billDetails.relatedDocuments.vendorAdvances.map((advance) => (
                        <div key={advance.id} className="rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs">
                          <span className="font-medium text-[#2B6CB0]">{advance.number}</span>
                          <span className="text-gray-500"> · {advance.status} · {formatIDR(advance.appliedAmount)} / {formatIDR(advance.amount)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {billDetails?.relatedDocuments?.returns && billDetails.relatedDocuments.returns.length > 0 && (
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-0.5">{t('Returns', 'nav')}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {billDetails.relatedDocuments.returns.map((ret) => (
                        <Link
                          key={ret.id}
                          href={`/purchase/returns?returnId=${ret.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs font-medium text-[#2B6CB0] hover:bg-gray-100 transition-colors"
                        >
                          {ret.number}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Secondary info */}
            {(selectedBill.vendorInvoiceNumber || selectedBill.description || selectedBill.paidAt || selectedBill.poStatus) && (
              <div className="text-xs text-gray-600 space-y-0.5">
                {selectedBill.vendorInvoiceNumber && <p>{t('Vendor Invoice No.', 'ui')}: <span className="text-gray-900">{selectedBill.vendorInvoiceNumber}</span></p>}
                {selectedBill.description && <p>{t('Description', 'ui')}: <span className="text-gray-900">{selectedBill.description}</span></p>}
                {selectedBill.paidAt && <p>{t('Paid', 'ui')}: <span className="text-gray-900">{formatTimestampDateForDisplay(selectedBill.paidAt, timezone)}</span></p>}
                {selectedBill.poStatus && <p>{t('PO Status', 'ui')}: <span className="text-gray-900">{selectedBill.poStatus}</span></p>}
              </div>
            )}

            <div className="pt-3 border-t border-gray-100">
              <p className="text-xs font-medium text-gray-700 mb-2">Signatures</p>
              <SignatureSurface
                referenceType="PurchaseBill"
                referenceId={selectedBill.id}
                title={selectedBill.billNumber || 'Purchase Bill'}
              />
            </div>
            <AttachmentUploader
              mode="persisted"
              referenceType="BILL"
              referenceId={selectedBill.id}
              label={t('Attachments', 'ui')}
            />

            {billPayments.length > 0 && (
              <div className="pt-3 border-t border-gray-100">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-medium text-gray-700">
                    {t('Payment History', 'ui')} ({billPayments.length})
                  </p>
                  <p className="text-xs text-gray-500">{t('Total Paid', 'ui')}: <span className="font-semibold text-gray-900">{formatIDR(billPayments.filter((p) => !p.voidedAt).reduce((s, p) => s + p.amount, 0))}</span></p>
                </div>
                {/* Payments table — edit/void each row via the correction standard */}
                <div className="border border-gray-200 rounded overflow-hidden">
                  <div className="grid grid-cols-[90px_1fr_90px_64px] gap-2 px-2 py-1.5 bg-gray-50 text-[10px] font-medium text-gray-500 border-b border-gray-200">
                    <span>{t('Date', 'ui')}</span>
                    <span>{t('Method', 'ui')} / {t('Notes', 'ui')}</span>
                    <span className="text-right">{t('Amount', 'ui')}</span>
                    <span className="text-right">{t('Actions', 'ui')}</span>
                  </div>
                  {billPayments.map((p) => (
                    <div key={p.id} className="border-b border-gray-100 last:border-0">
                      {editPaymentId === p.id ? (
                        <div className="p-2 space-y-2 bg-blue-50/40">
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[10px] text-gray-500 mb-0.5">{t('Amount', 'ui')}</label>
                              <NumericInput mode="decimal" min={0} value={editPaymentForm.amount}
                                onChange={(v) => setEditPaymentForm({ ...editPaymentForm, amount: v })}
                                className="w-full px-2 py-1 border border-gray-200 rounded text-xs text-right" />
                            </div>
                            <div>
                              <label className="block text-[10px] text-gray-500 mb-0.5">{t('Date', 'ui')}</label>
                              <input type="date" value={editPaymentForm.paymentDate}
                                onChange={(e) => setEditPaymentForm({ ...editPaymentForm, paymentDate: e.target.value })}
                                className="w-full px-2 py-1 border border-gray-200 rounded text-xs" />
                            </div>
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500 mb-0.5">{t('Payment Method', 'ui')}</label>
                            <select value={editPaymentForm.paymentMethodId}
                              onChange={(e) => setEditPaymentForm({ ...editPaymentForm, paymentMethodId: e.target.value })}
                              className="w-full px-2 py-1 border border-gray-200 rounded text-xs bg-white">
                              <option value="">{t('Keep current', 'ui')}</option>
                              {billPayMethods.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500 mb-0.5">{t('Notes', 'ui')}</label>
                            <input value={editPaymentForm.notes}
                              onChange={(e) => setEditPaymentForm({ ...editPaymentForm, notes: e.target.value })}
                              className="w-full px-2 py-1 border border-gray-200 rounded text-xs" />
                          </div>
                          <CorrectionApprovalNotice businessDate={p.paymentDate} />
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => setEditPaymentId(null)} disabled={savingPaymentEdit}>{t('Cancel', 'ui')}</Button>
                            <Button size="sm" isLoading={savingPaymentEdit} onClick={submitEditPayment}>{t('Save', 'ui')}</Button>
                          </div>
                        </div>
                      ) : voidPaymentId === p.id ? (
                        <div className="p-2 space-y-2 bg-red-50/40">
                          <div>
                            <label className="block text-[10px] text-gray-500 mb-0.5">{t('Void Date', 'ui')}</label>
                            <input type="date" value={voidPaymentDate}
                              onChange={(e) => setVoidPaymentDate(e.target.value)}
                              className="w-full px-2 py-1 border border-gray-200 rounded text-xs" />
                          </div>
                          <CorrectionApprovalNotice businessDate={p.paymentDate} />
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => setVoidPaymentId(null)} disabled={savingPaymentVoid}>{t('Cancel', 'ui')}</Button>
                            <Button variant="destructive" size="sm" isLoading={savingPaymentVoid} onClick={() => handleVoidPayment(p.id)}>{t('Void', 'ui')}</Button>
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-[90px_1fr_90px_64px] gap-2 px-2 py-1.5 items-center text-xs">
                          <span className="text-gray-500 text-[11px]">{formatDateOnlyForDisplay(p.paymentDate)}</span>
                          <span className="text-gray-700 truncate">
                            {p.paymentMethod || p.fundingAccount?.name || '—'}{p.notes ? <span className="text-gray-400"> · {p.notes}</span> : null}
                            {p.voidedAt ? <span className="ml-1 inline-flex items-center rounded bg-red-50 px-1 py-0.5 text-[10px] font-medium text-red-600">{t('Voided', 'ui')}</span> : null}
                          </span>
                          <span className={`text-right font-medium ${p.voidedAt ? 'text-gray-400 line-through' : 'text-gray-900'}`}>{formatIDR(p.amount)}</span>
                          <span className="flex items-center justify-end gap-1">
                            {!p.voidedAt && (
                              <>
                                <button onClick={() => startEditPayment(p)} title={t('Edit', 'ui')} className="p-1 text-gray-400 hover:text-[#2B6CB0]"><Pencil size={13} /></button>
                                <button onClick={() => startVoidPayment(p)} title={t('Void', 'ui')} className="p-1 text-gray-400 hover:text-red-600"><Ban size={13} /></button>
                              </>
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-gray-400 mt-1">{t('Same-day edits apply immediately; older payments need approval.', 'ui')}</p>
              </div>
            )}

            {/* Drawer actions — mutating document actions stay out of the list table.
                Void routes through the approval flow. Unpaid bills are
                always voidable; a paid direct-receipt (cash) bill is too, because
                voiding reverses the receipt (which unwinds the at-receipt cash)
                and its only payment carries no separate journal. */}
            {(canPayBill(selectedBill) || (selectedBill.status !== 'CANCELLED' && (
              (['DRAFT', 'OPEN', 'PENDING', 'OVERDUE'].includes(selectedBill.status) && billPayments.length === 0)
              || (billDetails?.isDirectReceipt && (billPayments.length === 0 || billPayments.every((p) => p.source === 'direct_receipt')))
            ))) && (
              <div className="pt-3 border-t border-gray-100 flex flex-wrap justify-end gap-2">
                {canPayBill(selectedBill) && (
                  <Button module="purchase" size="sm" icon={CreditCard} onClick={() => handlePay(selectedBill)} disabled={payingId === selectedBill.id}>
                    {payingId === selectedBill.id ? t('Processing...', 'ui') : t('Pay', 'ui')}
                  </Button>
                )}
                {selectedBill.status !== 'CANCELLED' && (
                  (['DRAFT', 'OPEN', 'PENDING', 'OVERDUE'].includes(selectedBill.status) && billPayments.length === 0)
                  || (billDetails?.isDirectReceipt && (billPayments.length === 0 || billPayments.every((p) => p.source === 'direct_receipt')))
                ) && (
                  <Button variant="destructive" size="sm" icon={Ban} onClick={() => handleVoidBill(selectedBill)}>
                    {t('Void', 'ui')}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </Drawer>

      {voidingBill && typeof document !== 'undefined' && createPortal((
        <div className="fixed inset-0 isolate z-[1000] flex items-center justify-center bg-black/40 p-4 pointer-events-auto">
          <div className="relative z-[1001] w-full max-w-md rounded bg-white p-5 shadow-xl">
            <h2 className="text-lg font-semibold text-red-700">{t('Void bill', 'ui')}</h2>
            <p className="mt-2 text-sm text-gray-700">
              {billDetails?.isDirectReceipt
                ? t('This will void the vendor bill and cancel the linked direct receipt. Stock will be moved out and the goods receipt journal will be reversed. Approval may be required.', 'ui')
                : t('This will remove the vendor bill from payables. Approval may be required and this cannot be undone.', 'ui')}
            </p>
            {billDetails?.isDirectReceipt && (
              <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {t('If any received stock has already been used, the server will block the void. Use stock opname or write-off for consumed stock.', 'ui')}
              </p>
            )}
            <label className="mt-4 block text-xs font-medium text-gray-700">{t('Reason', 'ui')}</label>
            <textarea
              value={billVoidReason}
              onChange={(e) => setBillVoidReason(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded border border-gray-200 px-3 py-2 text-sm focus:border-[#2B6CB0] focus:outline-none focus:ring-2 focus:ring-[#2B6CB0]/20"
              placeholder={t('Why is this bill being voided?', 'ui')}
            />
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setVoidingBill(null)} disabled={billVoidSaving}>
                {t('Cancel', 'ui')}
              </Button>
              <Button type="button" variant="destructive" onClick={submitVoidBill} isLoading={billVoidSaving} loadingText={t('Voiding...', 'ui')}>
                {t('Void', 'ui')}
              </Button>
            </div>
          </div>
        </div>
      ), document.body)}

      <Drawer
        isOpen={showPaymentDrawer}
        onClose={() => {
          setShowPaymentDrawer(false);
          setPaymentBill(null);
          setPaymentAttachments([]);
          setPaymentError(null);
          setPaymentSuccess(null);
        }}
        title={t('Record Bill Payment', 'ui')}
      >
        {paymentSuccess && (
          <div className="py-4 text-center">
            <CheckCircle2 size={32} className="mx-auto mb-2 text-green-600" />
            <p className="text-sm font-semibold text-gray-900 mb-1">{t('Payment recorded successfully', 'ui')}</p>
            <p className="text-xs text-gray-600 mb-3">
              {t('Status', 'ui')}: <span className={`inline-block px-2 py-1 rounded mt-1 ${STATUS_COLORS[paymentSuccess.bill.status]}`}>
                {STATUS_LABELS[paymentSuccess.bill.status]}
              </span>
            </p>
            <p className="text-[11px] text-gray-500">{t('Closing in a moment...', 'ui')}</p>
          </div>
        )}
        {paymentBill && !paymentSuccess && (
          <div className="space-y-4">
            <div className="rounded border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700">
              {paymentBill.billNumber} • {paymentBill.vendor}
            </div>
            {paymentMatch?.overallStatus === 'EXCEPTION' && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 flex items-start gap-2">
                <ShieldAlert size={14} className="text-red-600 mt-0.5 shrink-0" />
                <span>{t('Three-way match exception: PO, goods received, and invoice do not agree. Review before paying — you will be asked to confirm.', 'ui')}</span>
              </div>
            )}
            {paymentMatch?.overallStatus === 'WITHIN_TOLERANCE' && (
              <div className="rounded border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800 flex items-start gap-2">
                <ShieldAlert size={14} className="text-yellow-600 mt-0.5 shrink-0" />
                <span>{t('Minor variances vs the PO, within tolerance.', 'ui')}</span>
              </div>
            )}
            {paymentError && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{paymentError}</div>
            )}

            {/* Bill Details Display */}
            {loadingBillDetails && (
              <div className="rounded border border-gray-200 p-3 bg-gray-50 text-xs text-gray-600">
                {t('Loading bill details...', 'ui')}
              </div>
            )}
            {billDetails && !loadingBillDetails && (
              <div className="rounded border border-gray-200 p-3 space-y-3 bg-gray-50">
                <div>
                  <p className="text-xs font-medium text-gray-700 mb-2">{t('Bill Details', 'ui')}</p>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <p className="text-gray-500">{t('Bill Date', 'ui')}</p>
                      <p className="font-medium text-gray-900">{formatDateOnlyForDisplay(billDetails.billDate)}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">{t('Due Date', 'ui')}</p>
                      <p className="font-medium text-gray-900">{billDetails.dueDate ? formatDateOnlyForDisplay(billDetails.dueDate) : '—'}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">{t('Bill Total', 'ui')}</p>
                      <p className="font-medium text-gray-900">{formatIDR(billDetails.amount)}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">{t('Total Paid', 'ui')}</p>
                      <p className="font-medium text-gray-900">{formatIDR(billDetails.paidAmount)}</p>
                    </div>
                    <div className="col-span-2">
                      <p className="text-gray-500">{t('Outstanding Balance', 'ui')}</p>
                      <p className="font-medium text-lg text-red-600">{formatIDR(billDetails.outstandingBalance)}</p>
                    </div>
                  </div>
                </div>

                {/* Bill Items */}
                {billDetails.purchaseOrder?.items && billDetails.purchaseOrder.items.length > 0 && (
                  <div className="border-t border-gray-200 pt-3">
                    <p className="text-xs font-medium text-gray-700 mb-2">{t('Bill Items', 'ui')}</p>
                    <div className="space-y-2 max-h-40 overflow-y-auto">
                      {billDetails.purchaseOrder.items.map((item, idx) => (
                        <div key={idx} className="rounded bg-white p-2 border border-gray-100 text-xs">
                          <div className="flex items-center justify-between mb-1">
                            <p className="font-medium text-gray-900">{item.productName || item.name || 'Item'}</p>
                            <p className="text-gray-600">{item.quantity || 0} {item.unit || ''}</p>
                          </div>
                          <div className="flex items-center justify-between text-gray-600">
                            <p>{formatIDR(item.unitPrice ?? 0)} / {item.unit || ''}</p>
                            <p className="font-medium text-gray-900">{formatIDR(item.subtotal ?? 0)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">{t('Outstanding', 'ui')}</label>
                <div className="w-full rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-700 font-medium">
                  {formatIDR(paymentBill.outstanding)}
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">{t('Payment Amount', 'ui')} <span className="text-red-500">*</span></label>
                <div>
                  <NumericInput
                    mode="decimal"
                    min={0}
                    max={paymentBill.outstanding + roundingThreshold}
                    value={paymentForm.amount}
                    onChange={(v) => setPaymentForm({ ...paymentForm, amount: v })}
                    className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs"
                  />
                  {paymentForm.amount && (
                    <p className="mt-1 text-xs text-blue-600 font-medium">
                      {formatIDR(Number(paymentForm.amount) || 0)}
                    </p>
                  )}
                </div>
                {paymentForm.amount && Number(paymentForm.amount) > paymentBill.outstanding + roundingThreshold && (
                  <p className="mt-1 text-xs text-red-600">
                    {t('Exceeds outstanding balance', 'ui')}
                  </p>
                )}
                {paymentForm.amount && Number(paymentForm.amount) > paymentBill.outstanding && Number(paymentForm.amount) <= paymentBill.outstanding + roundingThreshold && (
                  <p className="mt-1 text-xs text-amber-600">
                    {t('Selisih akan dipost ke akun Beban Selisih Pembulatan', 'ui')}
                  </p>
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs text-gray-600 mb-1">{t('Payment Method', 'ui')}</label>
              <OptionCombobox
                value={selectedPayMethodId}
                options={[
                  ...billPayMethods.map(m => ({ value: m.id, label: m.label })),
                  ...vendorAdvances.map(a => ({ value: `advance:${a.id}`, label: `${t('Uang Muka', 'ui')} ${a.number} — ${t('sisa', 'ui')} ${formatIDR(a.remaining)}` })),
                ]}
                onChange={(v) => {
                  setSelectedPayMethodId(v);
                  // Picking an advance settles min(remaining, outstanding); preset the amount.
                  if (v.startsWith('advance:')) {
                    const adv = vendorAdvances.find(a => `advance:${a.id}` === v);
                    if (adv && paymentBill) {
                      const applied = Math.min(adv.remaining, paymentBill.outstanding);
                      setPaymentForm(prev => ({ ...prev, amount: String(Math.round(applied * 100) / 100) }));
                    }
                  }
                }}
                placeholder={t('Select a payment method', 'ui')}
                className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs"
              />
              {selectedPayMethodId.startsWith('advance:') && (
                <p className="mt-1 text-[11px] text-gray-500">{t('Settled from the vendor advance (Dr Utang / Cr Uang Muka) — no cash out.', 'ui')}</p>
              )}
              {billPayMethods.length === 0 && vendorAdvances.length === 0 && (
                <p className="mt-1 text-[11px] text-amber-600">{t('No payment methods configured for bills. Add one in Settings → Payment Methods.', 'ui')}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">{t('Payment Date', 'ui')}</label>
                <input
                  type="date"
                  value={paymentForm.paymentDate}
                  onChange={(e) => setPaymentForm({ ...paymentForm, paymentDate: e.target.value })}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">{t('Vendor Invoice No.', 'ui')}</label>
                <input
                  type="text"
                  value={paymentForm.vendorInvoiceNumber}
                  onChange={(e) => setPaymentForm({ ...paymentForm, vendorInvoiceNumber: e.target.value })}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs"
                  placeholder="INV-001"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">{t('Notes', 'ui')}</label>
              <textarea
                value={paymentForm.notes}
                onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })}
                rows={2}
                className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs"
                placeholder={t('Transfer reference / notes', 'ui')}
              />
            </div>
            <AttachmentUploader
              mode="pending"
              value={paymentAttachments}
              onChange={setPaymentAttachments}
              label={t('Transfer Proof', 'ui')}
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setShowPaymentDrawer(false)} disabled={!!payingId}>
                {t('Cancel', 'ui')}
              </Button>
              <Button
                size="sm"
                onClick={handleSubmitPayment}
                disabled={!!payingId || !selectedPayMethodId || !paymentForm.amount || Number(paymentForm.amount) <= 0 || Number(paymentForm.amount) > paymentBill.outstanding + roundingThreshold}
              >
                {payingId ? t('Processing...', 'ui') : t('Record Payment', 'ui')}
              </Button>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
