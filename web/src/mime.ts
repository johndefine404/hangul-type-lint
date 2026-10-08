// [Define404] hangul-type-lint 웹판: Gmail API 로 보낼 메일 원문(RFC 5322, MIME)을 만든다
// 외부 의존 없이 Workers 와 Node 양쪽에서 돈다 (TextEncoder, btoa, crypto 만 쓴다)

export type MimeAttachment = { filename: string; content: string; content_id?: string; content_type?: string };

export type MimeInput = {
  from: string; // "표시 이름 <주소>" 또는 "주소"
  to: string;
  subject: string;
  html: string;
  text?: string; // 없으면 html 에서 만든다
  replyTo?: string;
  headers?: Record<string, string>; // List-Unsubscribe 같은 추가 머리글
  attachments?: MimeAttachment[]; // content 는 base64. content_id 가 있으면 본문 속 cid: 이미지로 붙인다
  date?: Date;
  messageId?: string;
};

const enc = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64Utf8(s: string): string {
  return bytesToBase64(enc.encode(s));
}

export function base64Url(s: string): string {
  return base64Utf8(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// 76자마다 줄을 나눈다 (RFC 2045)
function wrap76(b64: string): string {
  return (b64.match(/.{1,76}/g) || [""]).join("\r\n");
}

// 머리글 값에 ASCII 밖 글자가 있으면 =?UTF-8?B?...?= 로 바꾼다. 한 덩어리가 너무 길지 않게 글자 단위로 나눈다
export function encodeWord(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (enc.encode(cur + ch).length > 45) {
      words.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${base64Utf8(w)}?=`).join("\r\n ");
}

// "표시 이름 <주소>" 의 표시 이름만 인코딩한다
export function encodeAddress(addr: string): string {
  const m = addr.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (!m) return addr.trim();
  const name = m[1].trim();
  if (!name) return `<${m[2]}>`;
  const shown = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : encodeWord(name);
  return `${shown} <${m[2]}>`;
}

export function addressOnly(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim();
}

// 머리글 주입을 막는다
const clean = (v: string) => v.replace(/[\r\n]+/g, " ");

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|pre)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => `${label} (${href})`)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function rfc2822Date(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

const boundary = (tag: string) => `=_${tag}_${crypto.randomUUID().replace(/-/g, "")}`;

export function buildMime(m: MimeInput): string {
  const domain = addressOnly(m.from).split("@")[1] || "localhost";
  const head: string[] = [
    `From: ${encodeAddress(clean(m.from))}`,
    `To: ${encodeAddress(clean(m.to))}`,
    `Subject: ${encodeWord(clean(m.subject))}`,
    `Date: ${rfc2822Date(m.date || new Date())}`,
    `Message-ID: ${m.messageId || `<${crypto.randomUUID()}@${domain}>`}`,
    "MIME-Version: 1.0",
  ];
  if (m.replyTo) head.push(`Reply-To: ${encodeAddress(clean(m.replyTo))}`);
  for (const [k, v] of Object.entries(m.headers || {})) {
    if (!/^[A-Za-z0-9-]+$/.test(k)) continue;
    head.push(`${k}: ${clean(v)}`);
  }

  const alt = boundary("alt");
  const altBody = [
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(base64Utf8(m.text ?? htmlToText(m.html))),
    `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(base64Utf8(m.html)),
    `--${alt}--`,
    "",
  ].join("\r\n");

  const atts = m.attachments || [];
  if (!atts.length) {
    return [...head, `Content-Type: multipart/alternative; boundary="${alt}"`, "", altBody].join("\r\n");
  }

  // 본문 속 이미지(cid:)가 있으면 multipart/related 로 감싼다
  const rel = boundary("rel");
  const parts = atts.map((a) => {
    const type = a.content_type || (/\.png$/i.test(a.filename) ? "image/png" : /\.jpe?g$/i.test(a.filename) ? "image/jpeg" : "application/octet-stream");
    const name = clean(a.filename).replace(/"/g, "");
    return [
      `--${rel}`,
      `Content-Type: ${type}; name="${name}"`,
      "Content-Transfer-Encoding: base64",
      a.content_id ? `Content-ID: <${clean(a.content_id)}>` : "",
      `Content-Disposition: ${a.content_id ? "inline" : "attachment"}; filename="${name}"`,
      "",
      wrap76(a.content.replace(/\s+/g, "")),
    ]
      .filter((l, i) => !(i === 3 && l === ""))
      .join("\r\n");
  });
  return [
    ...head,
    `Content-Type: multipart/related; boundary="${rel}"; type="multipart/alternative"`,
    "",
    `--${rel}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    altBody,
    ...parts,
    `--${rel}--`,
    "",
  ].join("\r\n");
}
