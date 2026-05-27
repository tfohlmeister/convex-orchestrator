import type { InstanceListItem } from '../api';

const TONES: Record<InstanceListItem['status'], string> = {
  running: 'pill-ok',
  stopped: 'pill-muted',
  error: 'pill-danger',
  creating: 'pill-warn',
};

export function StatusBadge({ status }: { status: InstanceListItem['status'] }) {
  const live = status === 'running' || status === 'creating';
  return <span className={`pill ${TONES[status]} ${live ? 'pulse-dot' : ''}`}>{status}</span>;
}
