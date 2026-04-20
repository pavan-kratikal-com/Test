-- Add subject and body preview to verdicts so SOC analysts can see email content.

SET @db = DATABASE();
SET @tbl = 'verdicts';

-- subject
SET @col = 'subject';
SET @q = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = @db AND table_name = @tbl AND column_name = @col) = 0,
  'ALTER TABLE verdicts ADD COLUMN subject VARCHAR(998) NULL AFTER recipient',
  'SELECT 1'));
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- body_preview (first ~500 chars of plain text body)
SET @col = 'body_preview';
SET @q = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = @db AND table_name = @tbl AND column_name = @col) = 0,
  'ALTER TABLE verdicts ADD COLUMN body_preview TEXT NULL AFTER subject',
  'SELECT 1'));
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;
