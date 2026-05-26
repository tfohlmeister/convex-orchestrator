import type { InstanceListItem } from '../api';

const COLORS: Record<InstanceListItem['status'], string> = {
  running: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  stopped: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
  error: 'bg-red-500/20 text-red-300 border-red-500/40',
  creating: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
};

export function StatusBadge({ status }: { status: InstanceListItem['status'] }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-xs border ${COLORS[status]} uppercase tracking-wide`}
    >
      {status}
    </span>
  );
}
