// [Define404] hangul-type-lint 웹판: Cloudflare Browser Rendering 으로 실제 페이지를 검사한다
// 주의: 이 경로는 로컬 시험에서 돌리지 않았다 (MOCK 모드만 시험). 배포 뒤 확인이 필요하다.
import puppeteer from "@cloudflare/puppeteer";
// @ts-ignore: 함수 원문을 글자로 불러온다 (wrangler.toml 의 Text 규칙)
import ANALYZE_SRC from "../../src/analyze.page.js";
import { score, sortFindings } from "../../src/rules.js";

const LARGE_FONT = 300 * 1024;
const MAX_SHOTS = 6;

const VIEWPORTS = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
} as const;

type Finding = Record<string, any>;

function kb(n: number) {
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + "MB" : Math.round(n / 1024) + "KB";
}

export async function runCheck(browserBinding: unknown, url: string) {
  const browser = await puppeteer.launch(browserBinding as any);
  const findings: Finding[] = [];
  const shots: Record<string, string> = {};
  const seen = new Set<string>();
  const fonts: { url: string; bytes: number }[] = [];
  try {
    for (const name of ["desktop", "mobile"] as const) {
      const page = await browser.newPage();
      await page.setViewport(VIEWPORTS[name]);
      if (name === "desktop") {
        page.on("response", async (res) => {
          if (res.request().resourceType() !== "font") return;
          const len = Number(res.headers()["content-length"] || 0);
          if (len) fonts.push({ url: res.url(), bytes: len });
        });
      }
      await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
      await page.evaluate("document.fonts.ready.then(() => true)");
      const res: any = await page.evaluate(`(${ANALYZE_SRC})(${JSON.stringify({ viewport: name })})`);
      const found: Finding[] = res.findings;
      if (name === "desktop") {
        const large = fonts.filter((f) => f.bytes > LARGE_FONT);
        if (large.length) {
          const total = large.reduce((a, f) => a + f.bytes, 0);
          found.push({
            rule: "font-large",
            severity: "medium",
            selector: large[0].url.split("?")[0].split("/").pop(),
            sample: "",
            why: `큰 폰트 파일 ${large.length}개(합계 ${kb(total)})를 받아야 해서 첫 화면 글자가 늦게 뜨거나, 뒤늦게 바뀌며 흔들립니다`,
            fix: "unicode-range: U+AC00-D7A3; /* 글자 범위별로 나눈 서브셋 파일로 교체 */",
            detail: large.map((f) => `${f.url.split("/").pop()} ${kb(f.bytes)}`).join(", "),
            htl: null,
          });
        }
      }
      for (const f of found) {
        const key = f.rule + "|" + f.selector;
        if (seen.has(key)) continue;
        seen.add(key);
        f.viewport = f.viewport || name;
        if (f.htl && Object.keys(shots).length < MAX_SHOTS) {
          try {
            const el = await page.$(`[data-htl="${f.htl}"]`);
            if (el) {
              await el.evaluate((n: any) => { n.style.outline = "3px solid #E5484D"; n.style.outlineOffset = "2px"; });
              const b64 = (await el.screenshot({ type: "jpeg", quality: 70, encoding: "base64" })) as string;
              const id = `shot-${Object.keys(shots).length + 1}`;
              shots[id] = b64;
              f.shot = `cid:${id}`;
            }
          } catch { /* 캡처 실패는 결과에 영향 없음 */ }
        }
        delete f.htl;
        findings.push(f);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
  const sorted = sortFindings(findings);
  return {
    report: { tool: "hangul-type-lint", version: "0.1.0", url, checkedAt: new Date().toISOString(), score: score(sorted), findings: sorted },
    shots,
  };
}
