-- [Define404] hangul-type-lint 웹판 저장소
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  score INTEGER NOT NULL,
  report TEXT NOT NULL,          -- 검사 결과 JSON (캡처는 메일 발송 뒤 지운다)
  mock INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT,
  check_id TEXT,
  url TEXT,
  consent_required_at TEXT NOT NULL,   -- 개인정보 수집·이용 동의(필수) 시각
  consent_marketing INTEGER NOT NULL DEFAULT 0,
  consent_marketing_at TEXT,           -- 광고성 정보 수신 동의(선택) 시각
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_email ON leads (email);

CREATE TABLE IF NOT EXISTS usage (
  day TEXT PRIMARY KEY,
  checks INTEGER NOT NULL DEFAULT 0,
  mails INTEGER NOT NULL DEFAULT 0
);
