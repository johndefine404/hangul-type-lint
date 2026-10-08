#!/usr/bin/env node
// [Define404] hangul-type-lint: 명령줄 진입점
// 사용: hangul-type-lint [check] <주소 또는 HTML 파일> [--out 폴더] [--json] [--no-shots] [--fail-on high|medium|none]
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { check } from "../src/check.mjs";
import { renderReport } from "../src/report-html.js";
import { RULES, SEVERITY_LABEL } from "../src/rules.js";

const HELP = `hangul-type-lint: 한국어가 화면에서 어색하게 보이는 곳을 찾고 고치는 CSS 한 줄을 붙여 줍니다

사용법
  hangul-type-lint check <주소 또는 HTML 파일> [옵션]

옵션
  --out <폴더>        리포트 저장 폴더 (기본: ./htl-report)
  --json              결과를 JSON 으로만 출력
  --no-shots          화면 캡처를 만들지 않음
  --fail-on <단계>    이 단계 이상이 하나라도 있으면 종료 코드 1 (high | medium | none, 기본 high)

종료 코드
  0 통과, 1 기준 이상 문제 발견, 2 실행 오류`;

function parse(argv) {
  const a = { out: "htl-report", json: false, shots: true, failOn: "high", target: null };
  const rest = [...argv];
  if (rest[0] === "check") rest.shift();
  while (rest.length) {
    const v = rest.shift();
    if (v === "--out") a.out = rest.shift();
    else if (v === "--json") a.json = true;
    else if (v === "--no-shots") a.shots = false;
    else if (v === "--fail-on") a.failOn = rest.shift();
    else if (v === "-h" || v === "--help") a.help = true;
    else if (!a.target) a.target = v;
  }
  return a;
}

const args = parse(process.argv.slice(2));
if (args.help || !args.target) {
  console.log(HELP);
  process.exit(args.help ? 0 : 2);
}

const outDir = resolve(args.out);
try {
  mkdirSync(outDir, { recursive: true });
  const report = await check(args.target, {
    outDir,
    shots: args.shots,
    log: (m) => { if (!args.json) console.error("  " + m); },
  });
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, "report.html"), renderReport(report));

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const s = report.score;
    console.log(`\n${report.url}`);
    console.log(`점수 ${s.value}점 (${s.grade}) · 심각 ${s.counts.high} · 보통 ${s.counts.medium} · 낮음 ${s.counts.low}\n`);
    for (const f of report.findings) {
      const n = (f.count || 1) + (f.more || 0);
      console.log(`[${SEVERITY_LABEL[f.severity]}] ${RULES[f.rule] || f.rule}${n > 1 ? ` (${n}곳)` : ""} · ${f.viewport === "mobile" ? "390px" : "1280px"}`);
      console.log(`  위치  ${f.selector}`);
      if (f.sample) console.log(`  글    ${f.sample}`);
      console.log(`  이유  ${f.why}`);
      console.log(`  고침  ${f.fix}`);
      if (f.detail) console.log(`  세부  ${f.detail}`);
      console.log("");
    }
    if (!report.findings.length) console.log("찾은 문제가 없습니다.\n");
    console.log(`리포트: ${join(outDir, "report.html")}`);
  }

  const levels = { high: ["high"], medium: ["high", "medium"], none: [] }[args.failOn] || ["high"];
  process.exit(report.findings.some((f) => levels.includes(f.severity)) ? 1 : 0);
} catch (e) {
  console.error("검사 실패: " + (e && e.message ? e.message : e));
  process.exit(2);
}
