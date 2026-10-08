// [Define404] hangul-type-lint 웹판 설정값
export interface Env {
  ASSETS: Fetcher;
  BROWSER?: unknown; // Cloudflare Browser Rendering
  DB: D1Database;
  LIMITER?: RateLimit;

  MOCK?: string;
  DAILY_LIMIT: string;
  DAILY_MAIL_LIMIT: string;
  CONTACT_URL: string;

  // 리포트 메일과 운영자 알림 (Resend). 없으면 콘솔에만 남긴다
  RESEND_API_KEY?: string;
  OWNER_EMAIL?: string;
  MAIL_FROM: string;
}
