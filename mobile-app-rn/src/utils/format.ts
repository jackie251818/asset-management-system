// 日期/数字格式化工具

export function formatDate(dateStr?: string): string {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return dateStr;
  }
}

export function formatDateTime(dateStr?: string): string {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return `${formatDate(dateStr)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return dateStr;
  }
}

export function formatRelativeTime(dateStr?: string): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr).getTime();
  if (isNaN(d)) return dateStr;
  const diff = Date.now() - d;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}天前`;
  return formatDate(dateStr);
}

export function formatCurrency(value?: number): string {
  if (value === undefined || value === null || isNaN(value)) return '-';
  return '¥' + value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

export function formatNumber(value?: number): string {
  if (value === undefined || value === null || isNaN(value)) return '0';
  return value.toLocaleString('zh-CN');
}

export function formatPercent(numerator: number, denominator: number): string {
  if (!denominator) return '0%';
  return `${Math.round((numerator / denominator) * 100)}%`;
}
