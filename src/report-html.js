// [Define404] hangul-type-lint: 검사 결과를 HTML 리포트 한 장으로 만든다 (명령줄 report.html, 웹 메일 본문 공용)
import { RULES, SEVERITY_LABEL } from "./rules.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// mailFooter: 메일로 보낼 때 맨 아래에 붙이는 HTML (보낸 곳, 연락처, 수신 거부 안내)
export function renderReport(report, { images = true, cta = true, mailFooter = "" } = {}) {
  const { score, findings } = report;
  const items = findings
    .map(
      (f, i) => `
  <article class="f">
    <div class="f-head">
      <span class="sev ${f.severity}">${SEVERITY_LABEL[f.severity]}</span>
      <h3>${i + 1}. ${esc(RULES[f.rule] || f.rule)}</h3>
      <span class="vp">${f.viewport === "mobile" ? "휴대폰 390px" : "데스크톱 1280px"}</span>
    </div>
    <p class="why">${esc(f.why)}</p>
    <dl>
      <dt>위치</dt><dd><code>${esc(f.selector)}</code></dd>
      ${f.sample ? `<dt>글</dt><dd>${esc(f.sample)}</dd>` : ""}
      ${f.detail ? `<dt>세부</dt><dd>${esc(f.detail)}</dd>` : ""}
      <dt>고치기</dt><dd><code class="fix">${esc(f.fix)}</code></dd>
      ${f.count > 1 || f.more ? `<dt>같은 문제</dt><dd>${(f.count || 1) + (f.more || 0)}곳</dd>` : ""}
    </dl>
    ${images && f.shot ? `<img src="${esc(f.shot)}" alt="${esc(RULES[f.rule] || f.rule)} 위치 캡처" loading="lazy">` : ""}
  </article>`,
    )
    .join("");

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>한글 타이포 린트 결과</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>
  :root{--ink:#24201C;--sub:#5E5650;--line:#E6DED6;--bg:#FAF7F3;--card:#fff;--high:#C4352B;--medium:#B4690E;--low:#5E5650;--accent:#1F6F5C}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:Pretendard Variable,Pretendard,-apple-system,"Apple SD Gothic Neo",sans-serif;word-break:keep-all;overflow-wrap:anywhere;line-height:1.65;font-size:16px}
  .wrap{max-width:860px;margin:0 auto;padding:32px 16px 80px}
  h1{font-size:26px;line-height:1.35;margin:0 0 6px}
  .url{color:var(--sub);font-size:14px;margin:0 0 24px}
  .sum{display:flex;flex-wrap:wrap;gap:24px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:28px}
  .score{font-size:44px;font-weight:800;line-height:1}
  .score small{font-size:16px;color:var(--sub);font-weight:600;margin-left:6px}
  .counts{display:flex;gap:16px;font-size:15px;flex-wrap:wrap}
  .counts b{font-size:20px;margin-right:4px}
  .f{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px}
  .f-head{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
  .f h3{margin:0;font-size:18px}
  .sev{font-size:12px;font-weight:700;padding:3px 8px;border-radius:6px;color:#fff}
  .sev.high{background:var(--high)}.sev.medium{background:var(--medium)}.sev.low{background:var(--low)}
  .vp{font-size:13px;color:var(--sub);margin-left:auto}
  .why{margin:10px 0 12px}
  dl{display:grid;grid-template-columns:72px 1fr;gap:6px 12px;margin:0;font-size:14px}
  dt{color:var(--sub)}
  dd{margin:0;min-width:0}
  code{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:13px;background:#F2ECE6;border-radius:6px;padding:2px 6px;overflow-wrap:anywhere}
  code.fix{background:#E4F1EC;color:#174F42}
  img{display:block;max-width:100%;height:auto;margin-top:14px;border:1px solid var(--line);border-radius:10px}
  .cta{margin-top:32px;padding:20px;border-radius:14px;background:var(--ink);color:#fff}
  .cta a{color:#fff;font-weight:700}
  .empty{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px}
  footer{margin-top:32px;font-size:14px;color:var(--sub)}
  @media (max-width:480px){dl{grid-template-columns:1fr;gap:2px}dt{margin-top:6px}.vp{margin-left:0}}
</style>
</head>
<body>
<div class="wrap">
  <h1>한글 타이포 린트 결과</h1>
  <p class="url">${esc(report.url)} · ${esc(report.checkedAt.slice(0, 16).replace("T", " "))} (UTC)</p>
  <section class="sum">
    <div class="score">${score.value}<small>점 · ${esc(score.grade)}</small></div>
    <div class="counts">
      <span><b>${score.counts.high}</b>심각</span>
      <span><b>${score.counts.medium}</b>보통</span>
      <span><b>${score.counts.low}</b>낮음</span>
    </div>
  </section>
  ${findings.length ? items : `<p class="empty">찾은 문제가 없습니다. 검사한 항목 안에서는 한글이 잘 보이는 페이지입니다.</p>`}
  ${cta ? `<div class="cta">직접 고치기 어려우면 맡겨 주세요. <a href="https://contact.define404.com">Define404</a>가 위 항목을 고쳐 드립니다. https://contact.define404.com</div>` : ""}
  <footer>[Define404] hangul-type-lint ${esc(report.version || "")} · 검사 기준은 한글 웹 글쓰기 관행을 따른 것이며, 고치기 줄은 출발점입니다. 실제 화면에서 다시 확인하세요.</footer>
  ${mailFooter}
</div>
</body>
</html>`;
}
