import type { LucideIcon } from 'lucide-react';
import {
  Search, User, FileText, ShoppingCart, CheckSquare, Package, Users,
  Truck, Receipt, Store, PackageCheck,
  GraduationCap, UserCheck, ClipboardList, RotateCcw, Send,
  ChefHat, Factory, Landmark, BookOpen,
} from 'lucide-react';
import type { SearchSourceKind } from './sources';

/**
 * How each kind of hit is announced in the omnibox.
 *
 * Separate from the component so a test can assert every source has an entry. Adding
 * a source and forgetting this file is not a visible crash — the group heading just
 * renders the raw key, so a supplier appears under a heading reading "vendor". That
 * happened once already; the test in `presentation.test.ts` is why it cannot again.
 *
 * Labels are the user's words, not the table's  vocabulary rule): a shop owner
 * reads "Pemasok", never "Vendor".
 */
export const TYPE_LABELS: Record<SearchSourceKind, string> = {
  product: 'Produk',
  contact: 'Pelanggan',
  vendor: 'Pemasok',
  invoice: 'Tagihan',
  order: 'Pesanan',
  bill: 'Tagihan pemasok',
  pos: 'Transaksi kasir',
  receipt: 'Penerimaan barang',
  employee: 'Pegawai',
  task: 'Tugas',
  class: 'Kelas',
  enrollment: 'Pendaftaran',
  'purchase-order': 'Pesanan pembelian',
  quote: 'Penawaran',
  'sales-return': 'Retur penjualan',
  delivery: 'Pengiriman',
  recipe: 'Resep',
  production: 'Perintah produksi',
  account: 'Akun',
  journal: 'Jurnal',
};

export const TYPE_ICONS: Record<SearchSourceKind, LucideIcon> = {
  product: Package,
  contact: User,
  vendor: Truck,
  invoice: FileText,
  order: ShoppingCart,
  bill: Receipt,
  pos: Store,
  receipt: PackageCheck,
  employee: Users,
  task: CheckSquare,
  class: GraduationCap,
  enrollment: UserCheck,
  'purchase-order': ClipboardList,
  quote: FileText,
  'sales-return': RotateCcw,
  delivery: Send,
  recipe: ChefHat,
  production: Factory,
  account: Landmark,
  journal: BookOpen,
};

export const TYPE_COLORS: Record<SearchSourceKind, string> = {
  product: 'text-indigo-500',
  contact: 'text-purple-500',
  vendor: 'text-amber-600',
  invoice: 'text-blue-500',
  order: 'text-green-500',
  bill: 'text-blue-600',
  pos: 'text-emerald-600',
  receipt: 'text-teal-600',
  employee: 'text-pink-500',
  task: 'text-orange-500',
  class: 'text-sky-600',
  enrollment: 'text-sky-500',
  'purchase-order': 'text-amber-500',
  quote: 'text-lime-600',
  'sales-return': 'text-rose-500',
  delivery: 'text-cyan-600',
  recipe: 'text-orange-600',
  production: 'text-slate-600',
  account: 'text-violet-600',
  journal: 'text-violet-500',
};

export function iconFor(kind: string): LucideIcon {
  return TYPE_ICONS[kind as SearchSourceKind] ?? Search;
}
export function labelFor(kind: string): string {
  return TYPE_LABELS[kind as SearchSourceKind] ?? kind;
}
export function colorFor(kind: string): string {
  return TYPE_COLORS[kind as SearchSourceKind] ?? 'text-gray-500';
}
