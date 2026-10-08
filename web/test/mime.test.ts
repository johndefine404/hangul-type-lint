// [Define404] hangul-type-lint 웹판: 메일 원문(MIME) 만들기 시험
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMime, encodeAddress, encodeWord, htmlToText } from "../src/mime.ts";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

// 머리글의 =?UTF-8?B?...?= 덩어리들을 다시 글자로 푼다
function decodeWords(v: string) {
  return v
    .replace(/\r\n /g, "")
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_m, x) => Buffer.from(x, "base64").toString("utf8"));
}

// 본문 부분(base64)을 꺼내 푼다
function partBody(raw: string, type: string) {
  const i = raw.indexOf(`Content-Type: ${type}`);
  assert.ok(i >= 0, `${type} 부분이 있어야 한다`);
  const rest = raw.slice(raw.indexOf("\r\n\r\n", i) + 4);
  return Buffer.from(rest.slice(0, rest.indexOf("\r\n--")).replace(/\r\n/g, ""), "base64").toString("utf8");
}

test("한글 제목은 UTF-8 encoded word 로 바뀌고 풀면 원문과 같다", () => {
  const subject = "(광고) [한글 타이포 검사] 우리가게.com 상세 리포트, 단어 중간 줄바꿈 3곳";
  const raw = buildMime({ from: "한글 타이포 린트 <john@define404.com>", to: "john@define404.com", subject, html: "<p>안녕하세요</p>" });
  const line = raw.split("\r\n\r\n")[0].match(/^Subject: ([\s\S]*?)\r\n(?=[A-Z][\w-]*: )/m)![1];
  assert.match(line, /^=\?UTF-8\?B\?/);
  for (const l of line.split("\r\n")) assert.ok(l.length <= 78, "머리글 한 줄은 78자를 넘지 않는다");
  assert.equal(decodeWords(line), subject);
});

test("보내는 이름은 encoded word, 주소는 그대로", () => {
  assert.equal(encodeAddress("한글 타이포 린트 <john@define404.com>"), `=?UTF-8?B?${b64("한글 타이포 린트")}?= <john@define404.com>`);
  assert.equal(encodeAddress("Define404 <john@define404.com>"), `"Define404" <john@define404.com>`);
  assert.equal(encodeAddress("john@define404.com"), "john@define404.com");
  assert.equal(encodeWord("plain ascii"), "plain ascii");
});

test("text/plain 과 text/html 이 multipart/alternative 로 함께 들어간다", () => {
  const html = `<div><p>점수 72점</p><p><a href="https://type.define404.com">다시 검사</a></p></div>`;
  const raw = buildMime({
    from: "한글 타이포 린트 <john@define404.com>",
    to: "john@define404.com",
    subject: "리포트",
    html,
    headers: { "List-Unsubscribe": "<https://type.define404.com/api/unsubscribe?t=x>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  });
  const head = raw.split("\r\n\r\n")[0];
  for (const h of ["From: ", "To: john@define404.com", "Date: ", "Message-ID: <", "MIME-Version: 1.0", "List-Unsubscribe: <https://", "List-Unsubscribe-Post: List-Unsubscribe=One-Click"]) {
    assert.ok(head.includes(h), `머리글 ${h}`);
  }
  assert.match(head, /Content-Type: multipart\/alternative; boundary="/);
  assert.equal(partBody(raw, 'text/html; charset="UTF-8"'), html);
  const text = partBody(raw, 'text/plain; charset="UTF-8"');
  assert.match(text, /점수 72점/);
  assert.match(text, /다시 검사 \(https:\/\/type\.define404\.com\)/);
  assert.ok(raw.endsWith("--\r\n"));
});

test("cid 이미지가 있으면 multipart/related 안에 alternative 와 이미지가 들어간다", () => {
  const raw = buildMime({
    from: "a <john@define404.com>",
    to: "john@define404.com",
    subject: "s",
    html: `<img src="cid:shot-1">`,
    attachments: [{ filename: "shot-1.jpg", content: "AAAA", content_id: "shot-1" }],
  });
  assert.match(raw, /Content-Type: multipart\/related; boundary="[^"]+"; type="multipart\/alternative"/);
  assert.match(raw, /Content-Type: multipart\/alternative/);
  assert.match(raw, /Content-Type: image\/jpeg; name="shot-1.jpg"\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <shot-1>\r\nContent-Disposition: inline/);
});

test("머리글 줄바꿈 주입을 막는다", () => {
  const raw = buildMime({ from: "a <john@define404.com>", to: "john@define404.com\r\nBcc: x@example.com", subject: "s", html: "x" });
  assert.ok(!/^Bcc:/m.test(raw));
});

test("html 에서 글자만 뽑는다", () => {
  assert.equal(htmlToText("<style>p{}</style><p>가&amp;나</p><ul><li>하나</li></ul>"), "가&나\n- 하나");
});
