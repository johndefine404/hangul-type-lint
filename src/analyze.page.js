// [Define404] hangul-type-lint: 브라우저 안에서 도는 검사 함수
// 이 파일은 모듈이 아니라 함수 식 하나다. 명령줄(Playwright)과 웹(Cloudflare Browser Rendering)이
// 파일 내용을 글자 그대로 읽어 page.evaluate 로 넣는다. 번들러가 함수를 바꾸지 못하게 하려는 것이다.
(function analyzePage(opts) {
  const viewport = opts.viewport; // "desktop" | "mobile"
  const MAX_PER_RULE = opts.maxPerRule || 5;
  const HANGUL = /[ㄱ-ㆎ가-힣]/;
  const HANGUL_G = /[ㄱ-ㆎ가-힣]/g;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "SVG", "TEMPLATE", "IFRAME", "CODE", "PRE"]);
  const KO_FONT = /pretendard|noto\s*sans\s*(kr|cjk)|noto\s*serif\s*(kr|cjk)|apple\s*sd\s*gothic|malgun|맑은|nanum|나눔|spoqa|suit|gmarket|ibm\s*plex\s*sans\s*kr|gothic\s*a1|wanted\s*sans|kopub|s-core|black\s*han|do\s*hyeon|jua|gowun|hahmlet|gungsuh|batang|dotum|gulim|굴림|돋움|바탕|궁서|\bkr\b/i;
  const vw = document.documentElement.clientWidth;
  let seq = Number(document.documentElement.getAttribute("data-htl-seq") || "0");

  const findings = [];
  const groups = {}; // 같은 규칙·같은 값끼리 묶어 개수만 센다

  function mark(el) {
    if (!el.hasAttribute("data-htl")) el.setAttribute("data-htl", String(++seq));
    return el.getAttribute("data-htl");
  }

  function selectorOf(el) {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return "#" + el.id;
    const parts = [];
    let e = el;
    for (let depth = 0; e && depth < 4 && e !== document.documentElement; depth++) {
      if (e === document.body) { parts.unshift("body"); break; }
      let p = e.tagName.toLowerCase();
      if (e.id && /^[A-Za-z][\w-]*$/.test(e.id)) { parts.unshift("#" + e.id); break; }
      const cls = Array.from(e.classList).filter((c) => /^[A-Za-z_-][\w-]*$/.test(c) && c.length < 32).slice(0, 2);
      if (cls.length) p += "." + cls.join(".");
      else if (e.parentElement) {
        const same = Array.from(e.parentElement.children).filter((s) => s.tagName === e.tagName);
        if (same.length > 1) p += ":nth-of-type(" + (same.indexOf(e) + 1) + ")";
      }
      parts.unshift(p);
      e = e.parentElement;
    }
    return parts.join(" > ");
  }

  function sample(text, n) {
    const t = (text || "").replace(/\s+/g, " ").trim();
    return t.length > (n || 60) ? t.slice(0, n || 60) + "..." : t;
  }

  function visible(el) {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    return el.getClientRects().length > 0;
  }

  function add(f, groupKey) {
    const key = f.rule + "|" + (groupKey || "");
    if (groupKey !== undefined) {
      if (groups[key]) { groups[key].count++; return; }
      f.count = 1;
      groups[key] = f;
    }
    const sameRule = findings.filter((x) => x.rule === f.rule);
    if (sameRule.length >= MAX_PER_RULE) {
      sameRule[sameRule.length - 1].more = (sameRule[sameRule.length - 1].more || 0) + 1;
      return;
    }
    f.viewport = viewport;
    findings.push(f);
  }

  function isHeading(el, fs) {
    return /^H[1-3]$/.test(el.tagName) || fs >= 24;
  }

  // 1. 한글이 든 글 덩어리(가장 가까운 블록 요소)를 모은다
  const blocks = new Map();
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!HANGUL.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
      for (let p = n.parentElement; p; p = p.parentElement) if (SKIP.has(p.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  function blockOf(el) {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const d = getComputedStyle(e).display;
      if (!d.startsWith("inline") && d !== "contents") return e;
    }
    return document.body;
  }
  for (let n = tw.nextNode(); n && blocks.size < 600; n = tw.nextNode()) {
    const el = n.parentElement;
    if (!el || !visible(el)) continue;
    const b = blockOf(el);
    if (!blocks.has(b)) blocks.set(b, []);
    blocks.get(b).push(n);
  }

  const koBlocks = [];
  for (const [b, nodes] of blocks) {
    const s = getComputedStyle(b);
    const text = nodes.map((n) => n.nodeValue).join("");
    const hangulCount = (text.match(HANGUL_G) || []).length;
    const fs = parseFloat(s.fontSize) || 16;
    let lh = parseFloat(s.lineHeight);
    if (!lh || isNaN(lh)) lh = fs * 1.4;
    const rect = b.getBoundingClientRect();
    koBlocks.push({ b, nodes, s, text, hangulCount, fs, lh, rect, shown: b.innerText || text });
  }

  // 2. 단어 중간 줄바꿈: 줄이 바뀌는 자리의 앞뒤 글자가 둘 다 한글이면 단어가 쪼개진 것이다
  let charBudget = 120000;
  for (const k of koBlocks) {
    if (k.s.wordBreak === "keep-all") continue;
    if (k.rect.height < k.lh * 1.5) continue; // 한 줄짜리는 볼 필요 없다
    const breaks = [];
    let prevTop = null, prevChar = "", sawBreak = false;
    const walker = document.createTreeWalker(k.b, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          if (n.tagName === "BR") return NodeFilter.FILTER_ACCEPT;
          if (SKIP.has(n.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
          const d = getComputedStyle(n).display;
          if (!d.startsWith("inline") && d !== "contents") return NodeFilter.FILTER_REJECT; // 안쪽 블록은 따로 본다
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const range = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 1) { sawBreak = true; continue; } // <br>
      const v = n.nodeValue;
      const lim = Math.min(v.length, 800);
      for (let i = 0; i < lim && charBudget > 0; i++) {
        const ch = v[i];
        if (/\s/.test(ch)) { sawBreak = true; continue; }
        charBudget--;
        range.setStart(n, i);
        range.setEnd(n, i + 1);
        const r = range.getClientRects()[0];
        if (!r || r.width === 0) continue;
        if (prevTop !== null && r.top > prevTop + r.height * 0.5) {
          if (!sawBreak && HANGUL.test(prevChar) && HANGUL.test(ch)) {
            const before = v.slice(Math.max(0, i - 6), i).replace(/\s+/g, " ");
            const after = v.slice(i, i + 4).replace(/\s+/g, " ");
            breaks.push(before + "|" + after);
          }
        }
        prevTop = r.top;
        prevChar = ch;
        sawBreak = false;
      }
    }
    if (breaks.length) {
      const heading = isHeading(k.b, k.fs);
      add({
        rule: "midword-break",
        severity: heading ? "high" : "medium",
        selector: selectorOf(k.b),
        sample: sample(k.shown),
        why: heading
          ? "헤드라인 단어가 음절 중간에서 끊겨 바로 눈에 띕니다"
          : "단어가 음절 중간에서 끊겨 읽다가 걸립니다",
        fix: "word-break: keep-all;",
        detail: "끊긴 자리 " + breaks.length + "곳 (예: " + breaks.slice(0, 2).join(", ") + ")",
        htl: mark(k.b),
      });
    }
  }

  // 3. 헤드라인 안의 <br> 강제 줄바꿈
  const heads = new Set(Array.from(document.querySelectorAll("h1,h2,h3")));
  for (const k of koBlocks) if (k.fs >= 28) heads.add(k.b);
  for (const h of heads) {
    if (!visible(h) || !HANGUL.test(h.textContent || "")) continue;
    const brs = Array.from(h.querySelectorAll("br")).filter((br) => {
      const r1 = document.createRange();
      r1.setStart(h, 0); r1.setEndBefore(br);
      const r2 = document.createRange();
      r2.setStartAfter(br); r2.setEnd(h, h.childNodes.length);
      return r1.toString().trim() && r2.toString().trim();
    });
    if (brs.length) {
      add({
        rule: "br-in-heading",
        severity: "medium",
        selector: selectorOf(h),
        sample: sample(h.innerText),
        why: "화면 폭이 바뀌면 강제로 끊은 자리 때문에 한 글자짜리 줄이 생깁니다",
        fix: "max-width: 18em; /* <br>을 지우고 폭으로 줄바꿈 */",
        detail: "<br> " + brs.length + "개",
        htl: mark(h),
      });
    }
  }

  // 4. 너무 긴 줄 (데스크톱)
  if (viewport === "desktop") {
    for (const k of koBlocks) {
      if (k.hangulCount < 60) continue;
      const lines = Math.round(k.rect.height / k.lh);
      if (lines < 2) continue;
      const chars = k.text.replace(/\s+/g, " ").trim().length;
      const perLine = Math.round(chars / lines);
      if (perLine > 45) {
        add({
          rule: "line-too-long",
          severity: "low",
          selector: selectorOf(k.b),
          sample: sample(k.shown),
          why: "한 줄이 약 " + perLine + "자라 다음 줄 시작을 찾기 어렵습니다 (한글 본문은 35~45자가 편합니다)",
          fix: "max-width: 38em;",
          detail: "약 " + perLine + "자 x " + lines + "줄",
          htl: mark(k.b),
        });
      }
    }
  }

  // 5. 본문 자간이 너무 좁음
  for (const k of koBlocks) {
    if (k.fs > 20 || k.hangulCount < 20) continue;
    const ls = parseFloat(k.s.letterSpacing);
    if (isNaN(ls)) continue;
    const em = ls / k.fs;
    if (em < -0.03) {
      add({
        rule: "letter-spacing-tight",
        severity: "low",
        selector: selectorOf(k.b),
        sample: sample(k.shown),
        why: "본문 자간이 " + em.toFixed(3) + "em이라 한글 획이 서로 붙어 보입니다",
        fix: "letter-spacing: -0.01em;",
        detail: "글자 크기 " + k.fs + "px, 자간 " + ls.toFixed(2) + "px",
        htl: mark(k.b),
      }, em.toFixed(3));
    }
  }

  // 6~8. 휴대폰 화면 검사
  if (viewport === "mobile") {
    if (!document.querySelector('meta[name="viewport"]')) {
      add({
        rule: "viewport-missing",
        severity: "high",
        selector: "head",
        sample: "",
        why: "휴대폰이 페이지를 PC 폭으로 그린 뒤 줄여 보여 줘서 글자가 아주 작아집니다",
        fix: '<meta name="viewport" content="width=device-width, initial-scale=1">',
        detail: "",
        htl: null,
      });
    }

    for (const k of koBlocks) {
      if (k.hangulCount < 20) continue;
      if (k.fs < 14) {
        add({
          rule: "font-size-small",
          severity: "medium",
          selector: selectorOf(k.b),
          sample: sample(k.shown),
          why: "휴대폰에서 본문이 " + k.fs + "px라 작아서 읽기 힘듭니다",
          fix: "font-size: 15px;",
          detail: "",
          htl: mark(k.b),
        }, String(k.fs));
      }
    }

    // 잘린 한글 (말줄임표, 줄 수 제한, 넘침 숨김)
    const clipCands = new Set(koBlocks.map((k) => k.b));
    for (const k of koBlocks) for (const n of k.nodes) if (n.parentElement) clipCands.add(n.parentElement);
    for (const el of clipCands) {
      const s = getComputedStyle(el);
      const ellipsis = s.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1;
      const clamp = s.webkitLineClamp && s.webkitLineClamp !== "none" && el.scrollHeight > el.clientHeight + 1;
      const hidden = (s.overflowX === "hidden" || s.overflowX === "clip") && s.whiteSpace === "nowrap" && el.scrollWidth > el.clientWidth + 2;
      if (ellipsis || clamp || hidden) {
        add({
          rule: "text-clipped",
          severity: "medium",
          selector: selectorOf(el),
          sample: sample(el.innerText),
          why: "390px 화면에서 한글 문장이 잘려 뒷부분이 보이지 않습니다",
          fix: clamp ? "-webkit-line-clamp: unset;" : "white-space: normal; text-overflow: clip;",
          detail: clamp ? "줄 수 제한으로 잘림" : ellipsis ? "말줄임표(...)로 잘림" : "넘친 부분 숨김",
          htl: mark(el),
        });
      }
    }

    // 가로 넘침
    const de = document.documentElement;
    if (de.scrollWidth > de.clientWidth + 1) {
      const all = document.body.querySelectorAll("*");
      const over = [];
      const clipped = (el) => {
        for (let p = el.parentElement; p && p !== document.body && p !== de; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o !== "visible") return true;
        }
        return false;
      };
      const isOver = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > vw + 1 || r.left < -1);
      };
      for (const el of all) {
        if (SKIP.has(el.tagName.toUpperCase()) && el.tagName !== "IFRAME") continue;
        if (!isOver(el)) continue;
        const s = getComputedStyle(el);
        if (s.position === "fixed" || !visible(el)) continue;
        if (el.parentElement && el.parentElement !== document.body && isOver(el.parentElement)) continue;
        if (clipped(el)) continue;
        over.push(el);
        if (over.length >= 5) break;
      }
      for (const el of over) {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        let fix = "max-width: 100%;";
        if (/^(IMG|VIDEO|IFRAME|CANVAS|SVG)$/i.test(el.tagName)) fix = "max-width: 100%; height: auto;";
        else if (s.whiteSpace === "nowrap" || s.whiteSpace === "pre") fix = "white-space: normal;";
        else if (s.display.includes("flex") && s.flexWrap === "nowrap") fix = "flex-wrap: wrap;";
        else if (s.display.includes("grid")) fix = "grid-template-columns: 1fr;";
        else if (el.parentElement && /grid|flex/.test(getComputedStyle(el.parentElement).display)) fix = "min-width: 0; /* 그리드·플렉스 칸이 안쪽 내용 폭만큼 늘어나지 않게 */";
        else if (el.scrollWidth > el.clientWidth + 1) fix = "overflow-wrap: anywhere;";
        add({
          rule: "overflow-x",
          severity: "high",
          selector: selectorOf(el),
          sample: sample(el.textContent, 40),
          why: "390px 화면에서 옆으로 " + Math.round(Math.max(r.right - vw, -r.left)) + "px 넘쳐 페이지가 좌우로 흔들립니다",
          fix,
          detail: "요소 폭 " + Math.round(r.width) + "px, 화면 폭 " + vw + "px",
          htl: mark(el),
        });
      }
      if (!over.length) {
        add({
          rule: "overflow-x",
          severity: "high",
          selector: "html",
          sample: "",
          why: "390px 화면에서 페이지가 옆으로 " + (de.scrollWidth - de.clientWidth) + "px 넘칩니다",
          fix: "overflow-x: clip; /* 넘치는 요소를 찾아 폭을 줄이는 것이 먼저 */",
          detail: "넘치는 요소를 특정하지 못했습니다",
          htl: null,
        });
      }
    }
  }

  // 9. 한글 웹폰트 설정 (font-display, 불러오기 실패)
  const faces = [];
  try {
    document.fonts.forEach((f) => faces.push({ family: f.family.replace(/^["']|["']$/g, ""), display: f.display, unicodeRange: f.unicodeRange, status: f.status, weight: f.weight }));
  } catch (e) { /* 일부 브라우저는 document.fonts 순회를 막는다 */ }
  const coversHangul = (ur) => {
    if (!ur || /^U\+0-10FFFF$/i.test(ur.trim())) return null; // 범위 지정 없음
    return ur.split(",").some((part) => {
      const m = part.trim().match(/^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i);
      if (!m) return false;
      const a = parseInt(m[1].replace(/\?/g, "0"), 16);
      const b = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, "F"), 16);
      return a <= 0xd7a3 && b >= 0xac00;
    });
  };
  const koFace = (f) => KO_FONT.test(f.family) || coversHangul(f.unicodeRange) === true;
  const seenFam = new Set();
  for (const f of faces) {
    if (!koFace(f)) continue;
    if ((f.display === "auto" || f.display === "block") && !seenFam.has("d" + f.family)) {
      seenFam.add("d" + f.family);
      add({
        rule: "font-display",
        severity: "medium",
        selector: '@font-face "' + f.family + '"',
        sample: "",
        why: "한글 폰트 파일은 커서 늦게 오는데, 그동안 글자가 아예 안 보입니다 (최대 3초)",
        fix: "font-display: swap;",
        detail: "현재 font-display: " + f.display,
        htl: null,
      });
    }
    if (f.status === "error" && !seenFam.has("e" + f.family)) {
      seenFam.add("e" + f.family);
      add({
        rule: "font-load-failed",
        severity: "medium",
        selector: '@font-face "' + f.family + '"',
        sample: "",
        why: "한글 웹폰트를 불러오지 못해 기기 기본 서체로 나옵니다",
        fix: 'src: url("/fonts/올바른-경로.woff2") format("woff2");',
        detail: "불러오기 실패",
        htl: null,
      });
    }
  }

  // 10. 한글·영문 서체 짝: 영문 웹폰트만 지정하고 한글 서체가 없으면 한글은 기기 기본 서체로 떨어진다
  const faceFams = new Set(faces.map((f) => f.family.toLowerCase()));
  const pairCands = [];
  const seenStack = new Set();
  for (const k of koBlocks.slice(0, 300)) {
    const stack = k.s.fontFamily.split(",").map((x) => x.trim().replace(/^["']|["']$/g, ""));
    const key = stack.join(",");
    const id = mark(k.b);
    if (pairCands.filter((p) => p.stack === key).length < 3 && pairCands.length < 40) {
      pairCands.push({ htl: id, stack: key, hangulCount: k.hangulCount, selector: selectorOf(k.b), sample: sample(k.shown) });
    }
    if (seenStack.has(key)) continue;
    seenStack.add(key);
    const first = stack[0] || "";
    const webFirst = faceFams.has(first.toLowerCase());
    const hasKo = stack.some((x) => KO_FONT.test(x));
    if (webFirst && !KO_FONT.test(first) && !hasKo) {
      add({
        rule: "font-pairing",
        severity: "medium",
        selector: selectorOf(k.b),
        sample: sample(k.shown),
        why: "영문은 웹폰트 " + first + "로, 한글은 기기마다 다른 기본 서체로 나와 모양이 섞입니다",
        fix: 'font-family: "' + first + '", "Pretendard", "Apple SD Gothic Neo", sans-serif;',
        detail: "추정 (font-family: " + k.s.fontFamily + ")",
        htl: id,
        heuristic: true,
      });
    }
  }

  document.documentElement.setAttribute("data-htl-seq", String(seq));
  return {
    findings,
    faces,
    pairCands,
    meta: {
      title: document.title,
      lang: document.documentElement.lang || "",
      viewportWidth: vw,
      koreanBlocks: koBlocks.length,
      hangulChars: koBlocks.reduce((a, k) => a + k.hangulCount, 0),
      hasViewportMeta: !!document.querySelector('meta[name="viewport"]'),
    },
  };
})
