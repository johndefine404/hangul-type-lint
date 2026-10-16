// [Define404] hangul-type-lint 웹판: 주소를 넣으면 한글 타이포 점수를 보여 주고, 상세 리포트는 메일로 보낸다
import { Hono } from "hono";
import type { Env } from "./env";
import { runCheck } from "./browser";
import { mailProvider, sendMail } from "./mail";
import { adFooter, dailyMaintenance, isNightKst, notifyConsent, unsubUrl, withdrawByToken } from "./consent";
import mockReport from "./mock-report.json";
import { RULES, SEVERITY_LABEL } from "../../src/rules.js";
import { renderReport } from "../../src/report-html.js";

const app = new Hono<{ Bindings: Env }>();

const today = () => new Date().toISOString().slice(0, 10);
const isMock = (env: Env) => env.MOCK === "1" || !env.BROWSER;
const DEFAULT_PRIVACY_URL = "https://contact.define404.com/privacy.html";

// 다른 사이트에서 보낸 쓰기 요청을 막는다. 메일 앱의 한 번 누름 수신 거부(출처 머리글 없음)는 받는다
app.use("/api/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("Origin");
    const self = new URL(c.req.url).origin;
    const allowed = (c.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const isUnsub = new URL(c.req.url).pathname === "/api/unsubscribe";
    if (origin ? origin !== self && !allowed.includes(origin) : !isUnsub) {
      return c.json({ error: "허용하지 않은 요청입니다" }, 403);
    }
  }
  await next();
});

// 접속자별 요청 제한
app.use("/api/*", async (c, next) => {
  if (c.env.LIMITER && c.req.method === "POST") {
    const key = c.req.header("CF-Connecting-IP") || "unknown";
    const { success } = await c.env.LIMITER.limit({ key });
    if (!success) return c.json({ error: "요청이 많습니다. 1분 뒤 다시 시도해 주세요" }, 429);
  }
  await next();
});

// 검사할 수 있는 주소인지 확인한다 (내부망 주소는 받지 않는다)
function checkTarget(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return null;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.startsWith("[")) return null;
  return u;
}

async function bump(env: Env, col: "checks" | "mails"): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO usage (day, ${col}) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET ${col} = ${col} + 1 RETURNING ${col} AS n`,
  )
    .bind(today())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// 화면에 보여 줄 요약: 점수, 단계별 개수, 문제 이름. 위치·고치는 CSS·캡처는 메일 리포트에 담는다
function summary(id: string, report: any, mock: boolean) {
  const byRule = new Map<string, { rule: string; title: string; severity: string; count: number }>();
  for (const f of report.findings) {
    const cur = byRule.get(f.rule);
    const n = (f.count || 1) + (f.more || 0);
    if (cur) cur.count += n;
    else byRule.set(f.rule, { rule: f.rule, title: RULES[f.rule as keyof typeof RULES] || f.rule, severity: f.severity, count: n });
  }
  return {
    id,
    url: report.url,
    mock,
    score: report.score,
    problems: [...byRule.values()].map((p) => ({ ...p, severityLabel: SEVERITY_LABEL[p.severity as keyof typeof SEVERITY_LABEL] })),
    sample: report.findings[0] ? { title: RULES[report.findings[0].rule as keyof typeof RULES], why: report.findings[0].why } : null,
  };
}

app.post("/api/check", async (c) => {
  const body = await c.req.json<{ url?: string }>().catch(() => ({}) as { url?: string });
  const target = checkTarget(String(body.url || "").trim());
  if (!target) return c.json({ error: "검사할 홈페이지 주소를 확인해 주세요 (예: https://example.com)" }, 400);

  const used = await bump(c.env, "checks");
  if (used > Number(c.env.DAILY_LIMIT || 50)) {
    return c.json({ error: "오늘 무료 검사 횟수가 모두 찼습니다. 내일 다시 시도하시거나, 명령줄 판을 써 주세요" }, 429);
  }

  const id = crypto.randomUUID();
  const mock = isMock(c.env);
  let report: any;
  let shots: Record<string, string> = {};
  if (mock) {
    report = { ...structuredClone(mockReport), url: target.href, checkedAt: new Date().toISOString() };
  } else {
    try {
      ({ report, shots } = await runCheck(c.env.BROWSER, target.href));
    } catch (e) {
      console.error("check failed", e);
      return c.json({ error: "페이지를 열지 못했습니다. 주소가 맞는지, 로그인 없이 열리는 페이지인지 확인해 주세요" }, 502);
    }
  }
  await c.env.DB.prepare("INSERT INTO checks (id, url, score, report, mock, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, target.href, report.score.value, JSON.stringify({ report, shots }), mock ? 1 : 0, new Date().toISOString())
    .run();
  return c.json(summary(id, report, mock));
});

app.post("/api/lead", async (c) => {
  const b = await c.req
    .json<{ checkId?: string; email?: string; consentRequired?: boolean; consentMarketing?: boolean }>()
    .catch(() => ({}) as Record<string, never>);
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return c.json({ error: "메일 주소를 확인해 주세요" }, 400);
  if (b.consentRequired !== true) return c.json({ error: "개인정보 수집·이용에 동의해 주셔야 리포트를 보내 드릴 수 있습니다" }, 400);

  const row = await c.env.DB.prepare("SELECT url, report FROM checks WHERE id = ?").bind(String(b.checkId || "")).first<{ url: string; report: string }>();
  if (!row) return c.json({ error: "검사 결과를 찾지 못했습니다. 다시 검사해 주세요" }, 404);

  if ((await bump(c.env, "mails")) > Number(c.env.DAILY_MAIL_LIMIT || 100)) {
    return c.json({ error: "오늘 보낼 수 있는 리포트 메일이 모두 찼습니다. 내일 다시 신청해 주세요" }, 429);
  }

  const now = new Date().toISOString();
  // 광고 수신 동의는 선택이다. 동의하지 않아도 리포트는 똑같이 보낸다 (개인정보 보호법 제22조 제5항)
  const marketing = b.consentMarketing === true;
  const token = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO leads (email, check_id, url, consent_required_at, consent_marketing, consent_marketing_at, unsub_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(email, b.checkId, row.url, now, marketing ? 1 : 0, marketing ? now : null, token, now)
    .run();

  const { report, shots } = JSON.parse(row.report) as { report: any; shots: Record<string, string> };
  const host = new URL(row.url).hostname;
  const attachments = Object.entries(shots || {}).map(([id, content]) => ({ filename: `${id}.jpg`, content, content_id: id }));

  // 리포트 메일에 서비스 안내(광고)는 광고 수신에 동의한 분께만, 한국 시간 08:00 ~ 21:00 에만 넣는다 (정보통신망법 제50조)
  const ad = marketing && !isNightKst();
  const link = unsubUrl(new URL(c.req.url).origin, token);
  const html = renderReport(report, { images: attachments.length > 0, cta: ad, mailFooter: ad ? adFooter(c.env, link, now) : "" });
  const subject = `${ad ? "(광고) " : ""}[한글 타이포 검사] ${host} 상세 리포트`;
  const headers: Record<string, string> = ad ? { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {};
  const mail = await sendMail(c.env, email, subject, html, attachments, headers);

  // 광고 수신 동의 처리 결과를 따로 알린다 (정보통신망법 제50조 제7항)
  if (marketing) await notifyConsent(c.env, email, "agree", now, link);

  // 캡처는 보낸 뒤 지운다 (저장 공간과 개인정보를 줄이려고)
  if (attachments.length) {
    await c.env.DB.prepare("UPDATE checks SET report = ? WHERE id = ?").bind(JSON.stringify({ report, shots: {} }), b.checkId).run();
  }

  const note = `새 리포트 신청\n메일: ${email}\n검사 주소: ${row.url}\n점수: ${report.score.value}\n광고 수신 동의: ${marketing ? "예" : "아니오"}`;
  if (c.env.OWNER_EMAIL && mailProvider(c.env) !== "console") {
    await sendMail(c.env, c.env.OWNER_EMAIL, `[리드] ${host} ${report.score.value}점`, `<pre>${note.replace(/</g, "&lt;")}</pre>`);
  } else {
    console.log("[lead]\n" + note);
  }
  return c.json({ ok: true, delivered: mail.sent, marketing });
});

// 광고 수신 거부: 메일 속 링크를 한 번 누르면 바로 처리한다. POST 는 메일 앱의 한 번 누름 수신 거부(RFC 8058)용
const unsubPage = (ok: boolean, contact: string, privacy: string) => `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>광고 수신 거부</title></head>
<body style="margin:0;background:#FAF7F3;color:#24201C;font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;word-break:keep-all;line-height:1.7">
<main style="max-width:560px;margin:0 auto;padding:48px 16px">
<h1 style="font-size:24px">${ok ? "광고 수신을 거부하셨습니다" : "수신 거부 링크를 확인하지 못했습니다"}</h1>
<p>${ok ? "앞으로 Define404의 광고성 정보를 보내지 않습니다. 처리 결과는 메일로도 알려 드립니다." : "링크가 잘렸거나 이미 지워진 신청입니다. 아래 연락처로 메일 주소를 알려 주시면 바로 처리합니다."}</p>
<p style="font-size:14px;color:#5E5650">보낸 곳: Define404 · 연락처: <a href="${contact}">${contact}</a> · <a href="${privacy}">개인정보 처리방침</a></p>
</main></body></html>`;

app.get("/api/unsubscribe", async (c) => {
  const r = await withdrawByToken(c.env, c.req.query("t") || "");
  return c.html(unsubPage(r.ok, c.env.CONTACT_URL, c.env.PRIVACY_URL || DEFAULT_PRIVACY_URL), r.ok ? 200 : 404);
});
app.post("/api/unsubscribe", async (c) => {
  const r = await withdrawByToken(c.env, c.req.query("t") || "");
  return c.json({ ok: r.ok }, r.ok ? 200 : 404);
});

app.get("/api/health", (c) => c.json({ ok: true, mock: isMock(c.env), mail: mailProvider(c.env) }));

// 화면이 쓰는 설정값: 실제 검사 가능 여부, 처리방침 주소
app.get("/api/config", (c) =>
  c.json({ live: !isMock(c.env), privacyUrl: c.env.PRIVACY_URL || DEFAULT_PRIVACY_URL, contactUrl: c.env.CONTACT_URL }),
);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "잠시 후 다시 시도해 주세요" }, 500);
});

const worker = {
  // 정기 실행은 define404-slack 워커가 이 주소로 대신 부른다 (무료 요금제 계정당 정기 실행 5개 한도)
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/__cron") {
      if (req.method !== "POST" || !env.CRON_SECRET || req.headers.get("x-cron-secret") !== env.CRON_SECRET) {
        return new Response("Not Found", { status: 404 });
      }
      const t = Number(u.searchParams.get("t")) || Date.now();
      await worker.scheduled({ scheduledTime: t, cron: "", noRetry() {} } as ScheduledController, env, ctx);
      return new Response("ok");
    }
    return app.fetch(req, env, ctx);
  },
  // 매일 한 번: 보유 기간이 지난 정보 삭제, 2년 지난 광고 수신 동의 종료
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dailyMaintenance(env));
  },
};

export default worker;
