// [Define404] hangul-type-lint 웹판: 주소를 넣으면 한글 타이포 점수를 보여 주고, 상세 리포트는 메일로 보낸다
import { Hono } from "hono";
import type { Env } from "./env";
import { runCheck } from "./browser";
import { sendMail } from "./mail";
import mockReport from "./mock-report.json";
import { RULES, SEVERITY_LABEL } from "../../src/rules.js";
import { renderReport } from "../../src/report-html.js";

const app = new Hono<{ Bindings: Env }>();

const today = () => new Date().toISOString().slice(0, 10);
const isMock = (env: Env) => env.MOCK === "1" || !env.BROWSER;

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
    .json<{ checkId?: string; email?: string; name?: string; consentRequired?: boolean; consentMarketing?: boolean }>()
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
  const marketing = b.consentMarketing === true;
  await c.env.DB.prepare(
    "INSERT INTO leads (email, name, check_id, url, consent_required_at, consent_marketing, consent_marketing_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(email, String(b.name || "").slice(0, 50) || null, b.checkId, row.url, now, marketing ? 1 : 0, marketing ? now : null, now)
    .run();

  const { report, shots } = JSON.parse(row.report) as { report: any; shots: Record<string, string> };
  const host = new URL(row.url).hostname;
  const attachments = Object.entries(shots || {}).map(([id, content]) => ({ filename: `${id}.jpg`, content, content_id: id }));
  const html = renderReport(report, { images: attachments.length > 0 });
  const mail = await sendMail(c.env, email, `[한글 타이포 검사] ${host} 상세 리포트`, html, attachments);

  // 캡처는 보낸 뒤 지운다 (저장 공간과 개인정보를 줄이려고)
  if (attachments.length) {
    await c.env.DB.prepare("UPDATE checks SET report = ? WHERE id = ?").bind(JSON.stringify({ report, shots: {} }), b.checkId).run();
  }

  const note = `새 리포트 신청\n메일: ${email}\n이름: ${b.name || "-"}\n검사 주소: ${row.url}\n점수: ${report.score.value}\n광고 수신 동의: ${marketing ? "예" : "아니오"}`;
  if (c.env.OWNER_EMAIL && c.env.RESEND_API_KEY) {
    await sendMail(c.env, c.env.OWNER_EMAIL, `[리드] ${host} ${report.score.value}점`, `<pre>${note.replace(/</g, "&lt;")}</pre>`);
  } else {
    console.log("[lead]\n" + note);
  }
  return c.json({ ok: true, delivered: mail.sent });
});

app.get("/api/health", (c) => c.json({ ok: true, mock: isMock(c.env) }));

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "잠시 후 다시 시도해 주세요" }, 500);
});

export default app;
