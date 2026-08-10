'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { iconFor, labelFor, colorFor } from '@/lib/search/presentation';

interface SearchResult {
  type: string;
  id: string;
  label: string;
  subtitle?: string;
  href: string;
}

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  // Cmd+K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(o => !o);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery('');
      setResults([]);
      setError(null);
    }
  }, [open]);

  // Debounced search
  const search = useCallback((q: string) => {
    clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    if (q.length < 2) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=5`, {
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Pencarian gagal');
        }
        setResults(data.results || []);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setResults([]);
        setError(err instanceof Error ? err.message : 'Pencarian gagal');
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setLoading(false);
        }
      }
    }, 300);
  }, []);

  useEffect(() => {
    search(query);
  }, [query, search]);

  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, results.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
      }
      if (e.key === 'Enter' && results[selectedIndex]) {
        router.push(results[selectedIndex].href);
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, results, selectedIndex, router]);

  if (!open) return null;

  // Group results by type
  const grouped = results.reduce((acc, r) => {
    (acc[r.type] = acc[r.type] || []).push(r);
    return acc;
  }, {} as Record<string, SearchResult[]>);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/20"
      onClick={() => setOpen(false)}
    >
      <div
        className="bg-white rounded-xl shadow-2xl border border-gray-200 w-full max-w-2xl mx-4"
        onClick={e => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
          <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            aria-label="Cari data"
            value={query}
            onChange={e => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Cari produk, pelanggan, pemasok, nomor tagihan…"
            className="flex-1 text-sm outline-none placeholder-gray-400"
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Bersihkan pencarian">
              <X className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600" />
            </button>
          )}
          <kbd className="hidden sm:flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono text-gray-400 border border-gray-200 rounded">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-96 overflow-auto py-2">
          {loading && (
            <div className="px-4 py-6 text-center text-xs text-gray-400">Mencari...</div>
          )}
          {!loading && error && (
            <div className="px-4 py-6 text-center text-xs text-red-500">{error}</div>
          )}
          {!loading && !error && query.length >= 2 && results.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-gray-400">
              Tidak ada hasil untuk &ldquo;{query}&rdquo;
            </div>
          )}
          {!loading && query.length < 2 && (
            <div className="px-4 py-6 text-center text-xs text-gray-400">
              Ketik minimal 2 karakter untuk mencari
            </div>
          )}
          {Object.entries(grouped).map(([type, items]) => {
            const Icon = iconFor(type);
            const color = colorFor(type);
            return (
              <div key={type}>
                <div className="px-4 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
                  {labelFor(type)}
                </div>
                {items.map(item => {
                  const globalIdx = results.indexOf(item);
                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        router.push(item.href);
                        setOpen(false);
                      }}
                      aria-current={globalIdx === selectedIndex ? 'true' : undefined}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 transition-colors text-left ${globalIdx === selectedIndex ? 'bg-gray-50' : ''}`}
                    >
                      <Icon className={`w-4 h-4 flex-shrink-0 ${color}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{item.label}</p>
                        {item.subtitle && (
                          <p className="text-xs text-gray-500 truncate">{item.subtitle}</p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        {results.length > 0 && (
          <div className="px-4 py-2 border-t border-gray-100 flex items-center gap-3 text-[10px] text-gray-400">
            <span>↑↓ pilih</span>
            <span>↵ buka</span>
            <span>esc tutup</span>
          </div>
        )}
      </div>
    </div>
  );
}
