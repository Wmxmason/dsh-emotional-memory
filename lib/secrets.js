// Conservative known-format filtering, not a general secret detector.
const PATTERNS = [
  /\bsk-[a-z0-9_-]{16,}\b/gi,
  /\bgh[pousr]_[a-z0-9_]{20,}\b/gi,
  /\bgithub_pat_[a-z0-9_]{20,}\b/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[a-z0-9_-]{6,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi,
  /\bBearer\s+[^\s"'，。；;,]{8,}/gi,
  /(?:api[_ -]?key|client[_ -]?secret|access[_ -]?token|secret[_ -]?access[_ -]?key|password|passwd|otp|密码|口令|验证码)\s*(?:[:=：]|\bis\b|是|为)\s*(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s"'，。；;,]+)/gi,
  /\b\d{17}[\dXx]\b/g,
];
export function redact(text) {
  let value = text;
  for (const pattern of PATTERNS) value = value.replace(pattern, '[敏感信息已隐藏]');
  return value;
}
export function containsKnownSecret(text) { return redact(text) !== text; }
