// [Define404] hangul-type-lint: Playwright 로 페이지를 열어 검사하고 화면 캡처를 남긴다
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { score, sortFindings } from "./rules.js";

const ANALYZE_SRC = readFileSync(fileURLToPath(new URL("./analyze.page.js", import.meta.url)), "utf8");
const LARGE_FONT = 300 * 1024;

export const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

export function toUrl(target) {
  if (/^https?:\/\//i.test(target) || target.startsWith("file://")) return target;
  return pathToFileURL(resolve(target)).href;
}

function analyzeExpr(opts) {
  // 함수 원문을 그대로 넣는다 (번들러·직렬화가 함수를 바꾸지 않게)
  return "(" + ANALYZE_SRC.replace(/^[\s\S]*?\(function analyzePage/, "(function analyzePage") + ")(" + JSON.stringify(opts) + ")";
}

function kb(n) {
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + "MB" : Math.round(n / 1024) + "KB";
}

async function settle(page) {
  try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch { /* 계속 요청하는 페이지도 있다 */ }
  try { await page.evaluate("document.fonts.ready.then(() => true)"); } catch { /* 없음 */ }
  await page.waitForTimeout(300);
}

// Chrome 개발자 도구 프로토콜로 실제로 쓰인 글꼴을 확인한다 (한글이 기본 서체로 떨어졌는지)
async function confirmPairing(ctx, page, cands) {
  const out = [];
  let cdp;
  try {
    cdp = await ctx.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
  } catch {
    return null;
  }
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const byStack = new Map();
  for (const c of cands) {
    try {
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[data-htl="${c.htl}"]` });
      if (!nodeId) continue;
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      const custom = fonts.filter((f) => f.isCustomFont);
      const system = fonts.filter((f) => !f.isCustomFont);
      const sysGlyphs = system.reduce((a, f) => a + f.glyphCount, 0);
      if (custom.length && sysGlyphs >= Math.max(5, c.hangulCount * 0.3) && !byStack.has(c.stack)) {
        byStack.set(c.stack, { c, custom, system });
      }
    } catch { /* 요소가 사라졌으면 건너뛴다 */ }
  }
  for (const { c, custom, system } of byStack.values()) {
    const first = c.stack.split(",")[0];
    const used = [...custom.map((f) => `${f.familyName}(웹폰트) ${f.glyphCount}자`), ...system.map((f) => `${f.familyName}(기기 기본) ${f.glyphCount}자`)];
    out.push({
      rule: "font-pairing",
      severity: "medium",
      selector: c.selector,
      sample: c.sample,
      why: `영문은 웹폰트로, 한글은 기기 기본 서체(${system[0].familyName})로 나와 한 문장 안에서 글자 모양이 섞입니다`,
      fix: `font-family: "${first}", "Pretendard", "Apple SD Gothic Neo", sans-serif;`,
      detail: "실제로 쓰인 글꼴: " + used.join(", "),
      htl: c.htl,
      viewport: "desktop",
    });
    if (out.length >= 3) break;
  }
  return out;
}

async function screenshot(page, htl, file, mobile) {
  const box = await page.evaluate(([id]) => {
    const el = document.querySelector(`[data-htl="${id}"]`);
    if (!el) return null;
    const r0 = el.getBoundingClientRect();
    window.scrollTo(0, Math.max(0, r0.top + scrollY - Math.max(40, (innerHeight - r0.height) / 2)));
    const r = el.getBoundingClientRect();
    const o = document.createElement("div");
    o.id = "__htl_box";
    o.style.cssText = `position:fixed;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;border:3px solid #E5484D;border-radius:4px;z-index:2147483647;pointer-events:none;box-sizing:border-box;background:rgba(229,72,77,.08)`;
    document.body.appendChild(o);
    return { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
  }, [htl]);
  if (!box) return false;
  await page.waitForTimeout(150);
  const pad = 48;
  let x = mobile ? 0 : Math.max(0, box.x - pad);
  let y = Math.max(0, box.y - pad);
  let w = mobile ? box.vw : Math.min(box.vw - x, box.w + pad * 2);
  let h = Math.min(box.vh - y, box.h + pad * 2, 700);
  if (w < 40 || h < 20) { x = 0; y = 0; w = box.vw; h = Math.min(box.vh, 600); }
  await page.screenshot({ path: file, clip: { x, y, width: w, height: h } });
  await page.evaluate(() => document.getElementById("__htl_box")?.remove());
  return true;
}

export async function check(target, { outDir, shots = true, log = () => {} } = {}) {
  const url = toUrl(target);
  if (outDir && shots) mkdirSync(join(outDir, "shots"), { recursive: true });
  const browser = await chromium.launch();
  const findings = [];
  const seen = new Set();
  const fonts = [];
  const meta = {};
  let shotNo = 0;
  try {
    for (const name of ["desktop", "mobile"]) {
      log(`${name === "desktop" ? "데스크톱 1280px" : "휴대폰 390px"} 화면으로 여는 중`);
      const ctx = await browser.newContext({ ...VIEWPORTS[name], locale: "ko-KR" });
      const page = await ctx.newPage();
      const pending = [];
      // 검사하는 컴퓨터에 설치된 폰트(local())를 쓰면 처음 온 손님이 받는 폰트 파일 크기를 못 잰다.
      // 외부 스타일시트에서 local() 을 빼고 연다. (style 태그 안의 local() 은 그대로 둔다)
      await page.route("**/*", async (route) => {
        if (route.request().resourceType() !== "stylesheet") return route.continue();
        try {
          const res = await route.fetch();
          const body = (await res.text()).replace(/local\([^)]*\)\s*,\s*/g, "");
          await route.fulfill({ response: res, body });
        } catch {
          await route.continue().catch(() => {});
        }
      });
      if (name === "desktop") {
        page.on("response", (res) => {
          if (res.request().resourceType() !== "font") return;
          pending.push(
            res.body().then((b) => fonts.push({ url: res.url(), bytes: b.length })).catch(() => {
              const len = Number(res.headers()["content-length"] || 0);
              if (len) fonts.push({ url: res.url(), bytes: len });
            }),
          );
        });
      }
      await page.goto(url, { waitUntil: "load", timeout: 45000 });
      await settle(page);
      await Promise.all(pending);
      const res = await page.evaluate(analyzeExpr({ viewport: name }));
      meta[name] = res.meta;
      let found = res.findings;
      if (name === "mobile" && meta.pairingMethod === "cdp") found = found.filter((f) => f.rule !== "font-pairing");
      if (name === "desktop") {
        meta.faces = res.faces;
        const confirmed = await confirmPairing(ctx, page, res.pairCands);
        if (confirmed) {
          // 실제 글꼴 확인이 됐으면 추정 결과 대신 확인 결과를 쓴다
          found = found.filter((f) => f.rule !== "font-pairing").concat(confirmed);
          meta.pairingMethod = "cdp";
        } else meta.pairingMethod = "heuristic";
        const large = fonts.filter((f) => f.bytes > LARGE_FONT).sort((a, b) => b.bytes - a.bytes);
        if (large.length) {
          const name = (u) => decodeURIComponent(u.split("?")[0].split("/").pop() || u);
          const total = large.reduce((a, f) => a + f.bytes, 0);
          found.push({
            rule: "font-large",
            severity: "medium",
            selector: name(large[0].url) + (large.length > 1 ? ` 외 ${large.length - 1}개` : ""),
            sample: "",
            why: `큰 폰트 파일 ${large.length}개(합계 ${kb(total)})를 받아야 해서 첫 화면 글자가 늦게 뜨거나, 뒤늦게 바뀌며 흔들립니다 (휴대폰 데이터에서 더 심함)`,
            fix: "unicode-range: U+AC00-D7A3; /* 글자 범위별로 나눈 서브셋 파일로 교체 */",
            detail: large.map((f) => `${name(f.url)} ${kb(f.bytes)}`).join(", "),
            htl: null,
            viewport: "desktop",
          });
        }
      }
      for (const f of found) {
        const key = f.rule + "|" + f.selector;
        if (seen.has(key)) continue;
        seen.add(key);
        f.viewport = f.viewport || name;
        if (shots && outDir && f.htl) {
          const file = `shots/${String(++shotNo).padStart(2, "0")}-${f.rule}.png`;
          try {
            if (await screenshot(page, f.htl, join(outDir, file), name === "mobile")) f.shot = file;
          } catch { /* 캡처 실패는 결과에 영향 없음 */ }
        }
        delete f.htl;
        findings.push(f);
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  const sorted = sortFindings(findings);
  return {
    tool: "hangul-type-lint",
    version: "0.1.0",
    url,
    checkedAt: new Date().toISOString(),
    score: score(sorted),
    findings: sorted,
    fonts: fonts.map((f) => ({ url: f.url, size: kb(f.bytes), bytes: f.bytes })),
    meta,
  };
}
