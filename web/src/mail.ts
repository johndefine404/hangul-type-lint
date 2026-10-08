// [Define404] hangul-type-lint 웹판: 메일 보내기
// 순서: Gmail API(GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET + GMAIL_REFRESH_TOKEN) > Resend(RESEND_API_KEY) > 콘솔 기록
import type { Env } from "./env";
import { base64Url, buildMime } from "./mime";

type Attachment = { filename: string; content: string; content_id?: string };

export type MailResult = { sent: boolean; provider: "gmail" | "resend" | "console"; reason?: string };

export function mailProvider(env: Env): MailResult["provider"] {
  if (env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN) return "gmail";
  if (env.RESEND_API_KEY) return "resend";
  return "console";
}

// 액세스 토큰은 만료 1분 전까지 메모리에 둔다 (같은 isolate 안에서만 재사용)
let cachedToken: { value: string; exp: number; key: string } | null = null;

async function gmailAccessToken(env: Env): Promise<string> {
  const key = `${env.GMAIL_CLIENT_ID}|${env.GMAIL_REFRESH_TOKEN!.slice(-8)}`;
  if (cachedToken && cachedToken.key === key && cachedToken.exp > Date.now() + 60_000) return cachedToken.value;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.GMAIL_CLIENT_ID!,
      client_secret: env.GMAIL_CLIENT_SECRET!,
      refresh_token: env.GMAIL_REFRESH_TOKEN!,
    }),
  });
  if (!res.ok) throw new Error(`Google 토큰 ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000, key };
  return data.access_token;
}

export async function sendMail(
  env: Env,
  to: string,
  subject: string,
  html: string,
  attachments: Attachment[] = [],
  headers: Record<string, string> = {},
): Promise<MailResult> {
  const provider = mailProvider(env);
  if (provider === "console") {
    console.log(`[mail:console] to=${to} subject=${subject} bytes=${html.length} attachments=${attachments.length}`);
    return { sent: false, provider, reason: "메일 설정 없음" };
  }

  if (provider === "gmail") {
    try {
      const raw = buildMime({ from: env.MAIL_FROM, to, subject, html, attachments, headers });
      const send = async (token: string) =>
        fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw: base64Url(raw) }),
        });
      let res = await send(await gmailAccessToken(env));
      if (res.status === 401) {
        cachedToken = null;
        res = await send(await gmailAccessToken(env));
      }
      if (!res.ok) {
        console.error("gmail error", res.status, (await res.text()).slice(0, 300));
        return { sent: false, provider, reason: `Gmail ${res.status}` };
      }
      return { sent: true, provider };
    } catch (e) {
      console.error("gmail error", e instanceof Error ? e.message : e);
      return { sent: false, provider, reason: "Gmail 오류" };
    }
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [to],
      subject,
      html,
      attachments,
      headers,
    }),
  });
  if (!res.ok) {
    console.error("resend error", res.status, await res.text());
    return { sent: false, provider, reason: `Resend ${res.status}` };
  }
  return { sent: true, provider };
}
