// [Define404] hangul-type-lint: 검사 항목 이름과 점수 계산 (명령줄과 웹이 같이 쓴다)

export const RULES = {
  "midword-break": "단어 중간 줄바꿈",
  "br-in-heading": "헤드라인 강제 줄바꿈",
  "line-too-long": "너무 긴 줄",
  "letter-spacing-tight": "너무 좁은 자간",
  "font-size-small": "작은 본문 글자",
  "viewport-missing": "휴대폰 화면 설정 없음",
  "text-clipped": "잘린 한글",
  "overflow-x": "390px 가로 넘침",
  "font-display": "한글 폰트 로딩 중 글자 숨김",
  "font-load-failed": "한글 폰트 불러오기 실패",
  "font-large": "큰 한글 폰트 파일",
  "font-pairing": "한글·영문 서체 짝 불일치",
};

export const SEVERITY_LABEL = { high: "심각", medium: "보통", low: "낮음" };
const WEIGHT = { high: 15, medium: 6, low: 2 };

export function score(findings) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const value = Math.max(0, 100 - findings.reduce((a, f) => a + (WEIGHT[f.severity] || 0), 0));
  const grade = value >= 90 ? "좋음" : value >= 70 ? "손볼 곳 있음" : "고칠 곳 많음";
  return { value, grade, counts };
}

const ORDER = { high: 0, medium: 1, low: 2 };
export function sortFindings(findings) {
  return [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}
