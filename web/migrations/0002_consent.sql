-- [Define404] hangul-type-lint 웹판: 광고 수신 철회와 처리 기록
-- unsub_token: 메일 속 수신 거부 링크용 무작위 값 (신청마다 하나)
-- consent_marketing_withdrawn_at: 광고 수신 동의를 철회한 시각
ALTER TABLE leads ADD COLUMN unsub_token TEXT;
ALTER TABLE leads ADD COLUMN consent_marketing_withdrawn_at TEXT;
CREATE INDEX IF NOT EXISTS leads_unsub_token ON leads (unsub_token);
