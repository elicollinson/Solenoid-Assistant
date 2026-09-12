// Apply before model/tool traces AND again before GitHub. Never retain arbitrary
// structured fields (request/response bodies, prompts, cookies, user metadata).
export function sanitize(value: string): string {
  let result = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (/token|secret|password|api.?key|credential/i.test(key) && secret && secret.length >= 6) {
      result = result.split(secret).join("[REDACTED]");
    }
  }
  return result
    .replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, "[REDACTED KEY]")
    .replace(/^.*\b(?:token|body|content|input|output)\s*[:=].*$/gim, "[REDACTED private field]")
    .replace(/\bBearer\s+[A-Za-z0-9_.+\/=-]+/gi, "[REDACTED TOKEN]")
    .replace(/^.*\b(?:authorization|cookie|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|credentials?|prompt|payload|request[._ ]?body|response[._ ]?body|input[._ ]?value|output[._ ]?value|arguments|toolArgs)\b.*$/gim, "[REDACTED sensitive log line]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]+)\b/g, "[REDACTED TOKEN]")
    .replace(/https?:\/\/[^\s<>"')]+/gi, url => { try { const u = new URL(url); return `${u.protocol}//${u.hostname}/[path redacted]`; } catch { return "[URL]"; } })
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP]")
    .replace(/\/(?:Users|home)\/[^\s/]+/g, "/[HOME]")
    .replace(/\b(?:\+?\d[\d ()-]{8,}\d)\b/g, "[NUMBER]")
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, "[OPAQUE VALUE]")
    .replace(/"[^"\n]*"|'[^'\n]*'/g, "[quoted value redacted]")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/@/g, "[at]")
    .replace(/```/g, "'''")
    .slice(0, 2000);
}
