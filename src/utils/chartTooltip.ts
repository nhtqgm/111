interface AxisTooltipItem {
  axisValue?: unknown;
  axisValueLabel?: unknown;
  marker?: unknown;
  seriesName?: unknown;
  value?: unknown;
}

export function formatAxisTooltip(params: unknown) {
  const items = (Array.isArray(params) ? params : [params])
    .filter(isAxisTooltipItem)
    .filter((item) => hasTooltipValue(item.value));
  if (!items.length) return '';

  const axisLabel = items[0].axisValueLabel ?? items[0].axisValue ?? '';
  const lines = items.map((item) => {
    const marker = typeof item.marker === 'string' ? item.marker : '';
    const seriesName = escapeHtml(String(item.seriesName ?? ''));
    return `${marker}${seriesName}&nbsp;&nbsp;${formatTooltipValue(item.value)}`;
  });
  return [escapeHtml(String(axisLabel)), ...lines].join('<br/>');
}

export function hasTooltipValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '' || value === '-') return false;
  if (Array.isArray(value)) return value.some(hasTooltipValue);
  if (typeof value === 'object') {
    const nested = (value as { value?: unknown }).value;
    return nested !== undefined && hasTooltipValue(nested);
  }
  return true;
}

function isAxisTooltipItem(value: unknown): value is AxisTooltipItem {
  return Boolean(value && typeof value === 'object');
}

function formatTooltipValue(value: unknown): string {
  if (Array.isArray(value)) {
    const visibleValues = value.filter(hasTooltipValue);
    if (visibleValues.length === 4) {
      const [open, close, low, high] = visibleValues;
      return `开 ${escapeHtml(String(open))} / 收 ${escapeHtml(String(close))} / 低 ${escapeHtml(String(low))} / 高 ${escapeHtml(String(high))}`;
    }
    return visibleValues.map((item) => escapeHtml(String(item))).join(' / ');
  }
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return formatTooltipValue((value as { value: unknown }).value);
  }
  return escapeHtml(String(value));
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
