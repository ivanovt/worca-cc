import { iconSvg, Zap } from './icons.js';

const VARIANT_MAP = {
  high: 'primary',
  xhigh: 'warning',
  max: 'danger',
};

export function effortLevelVariant(level) {
  return VARIANT_MAP[level] || 'neutral';
}

export function effortLevelBadge(level) {
  const text = level ?? '-';
  const variant = effortLevelVariant(level);
  const icon = iconSvg(Zap, 12, 'effort-zap-icon');
  return `<sl-badge variant="${variant}" pill>${icon}${text}</sl-badge>`;
}
