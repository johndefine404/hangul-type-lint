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
  PRIVACY_URL?: string; // 개인정보 처리방침 주소
  ALLOWED_ORIGINS?: string; // 쓰기 요청을 받을 출처 (쉼표로 구분). 비우면 같은 주소만 받는다

  // 리포트 메일과 운영자 알림. Gmail API 가 있으면 Gmail, 없으면 Resend, 둘 다 없으면 콘솔에만 남긴다
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  RESEND_API_KEY?: string;
  OWNER_EMAIL?: string;
  MAIL_FROM: string;
}
