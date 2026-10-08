// [Define404] hangul-type-lint 웹판: 메일 보내기 (Resend). 키가 없으면 콘솔에만 남긴다
import type { Env } from "./env";

type Attachment = { filename: string; content: string; content_id?: string };

export async function sendMail(env: Env, to: string, subject: string, html: string, attachments: Attachment[] = []) {
  if (!env.RESEND_API_KEY) {
    console.log(`[mail:console] to=${to} subject=${subject} bytes=${html.length} attachments=${attachments.length}`);
    return { sent: false, reason: "RESEND_API_KEY 없음" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, html, attachments }),
  });
  if (!res.ok) {
    console.error("resend error", res.status, await res.text());
    return { sent: false, reason: `Resend ${res.status}` };
  }
  return { sent: true };
}
