// [Define404] hangul-type-lint 웹판: 광고 수신 동의 처리와 보유 기간 관리
// 기준: 개인정보 보호법 제15조·제22조, 정보통신망법 제50조 (법률 자문이 아닌 운영 기준)
import type { Env } from "./env";
import { sendMail } from "./mail";

export const SENDER = "Define404";
export const RETENTION_DAYS = 365; // 필수 동의 정보: 수집일로부터 1년
export const MARKETING_DAYS = 730; // 광고 수신 동의: 2년이 지나면 끝낸다 (정보통신망법 제50조 제8항, 시행령 2년)

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const kstDate = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);

// 한국 시간 21:00 ~ 08:00 은 광고를 보내지 않는다 (야간 별도 동의를 받지 않으므로)
export function isNightKst(now = new Date()): boolean {
  const h = (now.getUTCHours() + 9) % 24;
  return h >= 21 || h < 8;
}

export function unsubUrl(origin: string, token: string) {
  return `${origin}/api/unsubscribe?t=${encodeURIComponent(token)}`;
}

// 광고가 들어간 메일 맨 아래: 보낸 곳, 연락처, 수신 거부 링크
export function adFooter(env: Env, link: string, consentAt: string) {
  return `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #E6DED6;font-size:13px;color:#5E5650;line-height:1.7">
보낸 곳: ${SENDER} · 연락처: <a href="${esc(env.CONTACT_URL)}">${esc(env.CONTACT_URL)}</a><br>
${kstDate(consentAt)}에 광고성 정보 수신에 동의하셔서 Define404 서비스 안내를 함께 보냅니다.<br>
더 받지 않으시려면 <a href="${esc(link)}">수신 거부</a>를 누르세요. 한 번 누르면 바로 처리되고 비용은 들지 않습니다.
</div>`;
}

// 동의·철회·만료 처리 결과를 메일로 알린다 (메일 설정이 없으면 콘솔에 남는다)
export async function notifyConsent(
  env: Env,
  to: string,
  kind: "agree" | "withdraw" | "expire",
  at: string,
  link?: string,
) {
  const result = { agree: "수신 동의", withdraw: "수신 거부(동의 철회)", expire: "동의 기간 2년 만료로 종료" }[kind];
  const title = { agree: "수신 동의", withdraw: "수신 거부", expire: "수신 동의 만료" }[kind];
  const extra =
    kind === "agree" && link
      ? `<p>더 받지 않으시려면 언제든 <a href="${esc(link)}">수신 거부</a>를 누르세요. 비용은 들지 않습니다.</p>`
      : kind === "expire"
        ? `<p>앞으로 광고성 정보를 보내지 않습니다. 다시 받으시려면 리포트를 신청하실 때 새로 동의해 주세요.</p>`
        : `<p>앞으로 광고성 정보를 보내지 않습니다.</p>`;
  const html = `<div style="font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;word-break:keep-all;line-height:1.7;color:#24201C">
<p>광고성 정보 수신 처리 결과를 알려 드립니다.</p>
<p>보낸 곳: ${SENDER}<br>처리 일자: ${kstDate(at)}<br>처리 결과: ${result}</p>
${extra}
<p style="font-size:13px;color:#5E5650">문의: <a href="${esc(env.CONTACT_URL)}">${esc(env.CONTACT_URL)}</a></p>
</div>`;
  return sendMail(env, to, `[한글 타이포 린트] 광고성 정보 ${title} 처리 결과 안내`, html);
}

// 수신 거부 링크로 들어온 요청: 같은 메일 주소의 광고 수신 동의를 모두 끝낸다
export async function withdrawByToken(env: Env, token: string): Promise<{ ok: boolean; email?: string; at?: string }> {
  if (!token) return { ok: false };
  const row = await env.DB.prepare("SELECT email FROM leads WHERE unsub_token = ?").bind(token).first<{ email: string }>();
  if (!row) return { ok: false };
  const at = new Date().toISOString();
  const res = await env.DB.prepare(
    "UPDATE leads SET consent_marketing = 0, consent_marketing_withdrawn_at = ? WHERE email = ? AND consent_marketing = 1",
  )
    .bind(at, row.email)
    .run();
  // 이미 철회된 주소에 다시 눌렀을 때는 알림 메일을 또 보내지 않는다
  if ((res.meta?.changes ?? 0) > 0) await notifyConsent(env, row.email, "withdraw", at);
  return { ok: true, email: row.email, at };
}

// 매일 한 번: 2년 지난 광고 수신 동의를 끝내고, 보유 기간이 지난 정보를 지운다
export async function dailyMaintenance(env: Env, now = new Date()) {
  const iso = (days: number) => new Date(now.getTime() - days * 86400e3).toISOString();
  const at = now.toISOString();

  const expired = await env.DB.prepare(
    "SELECT DISTINCT email FROM leads WHERE consent_marketing = 1 AND consent_marketing_at < ?",
  )
    .bind(iso(MARKETING_DAYS))
    .all<{ email: string }>();
  for (const { email } of expired.results || []) {
    await env.DB.prepare(
      "UPDATE leads SET consent_marketing = 0, consent_marketing_withdrawn_at = ? WHERE email = ? AND consent_marketing = 1 AND consent_marketing_at < ?",
    )
      .bind(at, email, iso(MARKETING_DAYS))
      .run();
    await notifyConsent(env, email, "expire", at);
  }

  // 광고 수신 동의가 살아 있지 않은 신청은 1년이 지나면 지운다
  const leads = await env.DB.prepare("DELETE FROM leads WHERE consent_marketing = 0 AND created_at < ?").bind(iso(RETENTION_DAYS)).run();
  const checks = await env.DB.prepare("DELETE FROM checks WHERE created_at < ?").bind(iso(RETENTION_DAYS)).run();
  console.log(
    `[maintenance] 광고 동의 만료 ${expired.results?.length ?? 0}명, 신청 삭제 ${leads.meta?.changes ?? 0}건, 검사 결과 삭제 ${checks.meta?.changes ?? 0}건`,
  );
}
