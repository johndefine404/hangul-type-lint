// [Define404] hangul-type-lint: 시험용 두 페이지로 명령줄을 돌려 결과를 확인한다
// 나쁜 예시는 문제를 찾고 종료 코드 1, 좋은 예시는 문제 0개에 종료 코드 0 이어야 한다.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cases = [
  { file: "fixtures/bad.html", exit: 1, mustFind: ["midword-break", "br-in-heading", "overflow-x", "font-display", "text-clipped", "font-size-small"] },
  { file: "fixtures/good.html", exit: 0, mustFind: [] },
];
let failed = 0;
for (const c of cases) {
  const out = mkdtempSync(join(tmpdir(), "htl-"));
  const r = spawnSync(process.execPath, ["bin/hangul-type-lint.mjs", "check", c.file, "--out", out, "--json"], { encoding: "utf8" });
  const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
  const rules = new Set(report.findings.map((f) => f.rule));
  const missing = c.mustFind.filter((x) => !rules.has(x));
  const ok = r.status === c.exit && missing.length === 0 && (c.mustFind.length || report.findings.length === 0);
  console.log(`${ok ? "통과" : "실패"}  ${c.file}  종료 코드 ${r.status} (기대 ${c.exit}), 찾은 문제 ${report.findings.length}개${missing.length ? ", 못 찾음: " + missing.join(", ") : ""}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
