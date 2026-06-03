-- Extend report_audit.action CHECK constraint to allow import_schwab + delete_import.
-- Previously only ('upload','delete','archive','login') were allowed, which silently
-- rejected Schwab CSV import audit rows (the sbInsert call was wrapped in .catch()).
-- This left imports invisible in the Imports panel even though data landed correctly.

ALTER TABLE report_audit DROP CONSTRAINT IF EXISTS report_audit_action_check;
ALTER TABLE report_audit ADD CONSTRAINT report_audit_action_check
  CHECK (action = ANY (ARRAY[
    'upload'::text,
    'delete'::text,
    'archive'::text,
    'login'::text,
    'import_schwab'::text,
    'delete_import'::text
  ]));
