-- Screenshots that ran out of classification attempts used to be filed as
-- rejected, which made them permanent. They were never judged, so mark them
-- errors: the next collection uploads them again and they are classified anew.
-- A genuine rejection carries no classification either, so the attempt count is
-- the only mark of an exhausted one; a real rejection on the fifth try is
-- reconsidered once, which costs a model call and nothing else.
UPDATE `source_candidates` SET `status` = 'error', `lease_until` = 0
WHERE `status` = 'rejected' AND `classification` IS NULL AND `attempts` >= 5;
