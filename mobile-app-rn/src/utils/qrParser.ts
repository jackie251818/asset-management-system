// 二维码纯文本解析
export function parseAssetQR(content: string): string | null {
  if (!content) return null;
  // 匹配 "编码：FYM-001" 或 "编码:FYM-001"
  const match = content.match(/编码[：:]\s*(.+)/);
  if (match) return match[1].trim();
  // 兜底：尝试匹配纯编号格式
  const idMatch = content.match(/([A-Za-z]+-\d+)/);
  if (idMatch) return idMatch[1];
  // 再兜底：直接返回内容（假设扫码结果就是资产ID）
  const trimmed = content.trim();
  if (trimmed.length > 0 && trimmed.length < 50) return trimmed;
  return null;
}
