-- Views and the full-text index.
--
-- Everything here is declared in src/db/schema/search.ts as `.existing()`, so
-- queries against it are typed while drizzle-kit leaves the DDL alone.

-- One FTS5 index across every text surface, keyed by entity id.
--
-- Deliberately NOT an external-content table: external content mirrors exactly
-- one source table, and the content here spans messages, screenshot summaries,
-- OKF bodies, web documents and agent prose. The app writes this on commit.
CREATE VIRTUAL TABLE `search` USING fts5(
	title,
	body,
	subject_id UNINDEXED,
	kind UNINDEXED,
	occurred_at UNINDEXED,
	tokenize = 'porter unicode61 remove_diacritics 2'
);
--> statement-breakpoint

-- Open decisions, blocking first, then by whichever deadline exists.
-- Backs the NEEDS YOU chip, the desktop aside, the header sentence and the
-- phone's rule that at most two entries are prominent.
CREATE VIEW `v_needs_you` AS
SELECT
	d.id                AS decision_id,
	d.title             AS title,
	d.body              AS body,
	d.blocking          AS blocking,
	d.opened_at         AS opened_at,
	d.due_at            AS due_at,
	d.subject_id        AS subject_id,
	e.kind              AS subject_kind
FROM decisions d
LEFT JOIN entities e ON e.id = d.subject_id AND e.deleted_at IS NULL
WHERE d.state = 'open'
ORDER BY d.blocking DESC, COALESCE(d.due_at, d.opened_at) ASC;
--> statement-breakpoint

-- The stats block on a workflow: Runs / Clean runs / Median / Last.
--
-- Median comes from a window function rather than a correlated LIMIT/OFFSET:
-- SQLite will not correlate an outer column into an OFFSET expression, so the
-- obvious formulation compiles but fails at query time with "no such column".
-- On an even count this takes the lower of the two middle values, which is what
-- a human reading "18m 40s" expects.
CREATE VIEW `v_workflow_stats` AS
WITH ranked AS (
	SELECT
		workflow_id,
		duration_ms,
		ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY duration_ms) AS rn,
		COUNT(*)     OVER (PARTITION BY workflow_id)                      AS n
	FROM workflow_runs
	WHERE duration_ms IS NOT NULL
),
medians AS (
	SELECT workflow_id, duration_ms AS median_duration_ms
	FROM ranked
	WHERE rn = (n + 1) / 2
)
SELECT
	w.id AS workflow_id,
	COUNT(r.id) AS runs,
	SUM(CASE WHEN r.state = 'done' THEN 1 ELSE 0 END) AS clean_runs,
	MAX(r.started_at) AS last_started_at,
	CAST(AVG(r.duration_ms) AS INTEGER) AS mean_duration_ms,
	m.median_duration_ms AS median_duration_ms
FROM workflows w
LEFT JOIN workflow_runs r ON r.workflow_id = w.id
LEFT JOIN medians m ON m.workflow_id = w.id
GROUP BY w.id, m.median_duration_ms;
--> statement-breakpoint

-- "reads: 31 times - last read Today 06:12", and the retirement signal for
-- facts nothing has referenced in months.
CREATE VIEW `v_okf_reads` AS
SELECT
	okf_uri AS okf_uri,
	COUNT(*) AS read_count,
	MAX(at) AS last_read_at
FROM okf_access_log
WHERE mode = 'read'
GROUP BY okf_uri;
--> statement-breakpoint

-- The evidence list under any object, already joined to its source kind so the
-- viewer knows whether to render an email, a thread, a screenshot or an article.
CREATE VIEW `v_evidence` AS
SELECT
	el.id         AS id,
	el.subject_id AS subject_id,
	el.ordinal    AS ordinal,
	el.why        AS why,
	el.pin_kind   AS pin_kind,
	el.pin_quote  AS pin_quote,
	el.source_id  AS source_id,
	e.kind        AS source_kind
FROM evidence_links el
JOIN entities e ON e.id = el.source_id
WHERE e.deleted_at IS NULL
ORDER BY el.subject_id, el.ordinal;
