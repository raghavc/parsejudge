-- Document and page counts kept on the run, so a report keeps them after its documents are deleted.
ALTER TABLE runs ADD COLUMN document_count INTEGER;
ALTER TABLE runs ADD COLUMN page_count INTEGER;
UPDATE runs SET
  document_count = (SELECT COUNT(*) FROM run_documents rd WHERE rd.run_id = runs.id),
  page_count = (SELECT COALESCE(SUM(d.page_count), 0) FROM run_documents rd JOIN documents d ON d.id = rd.document_id
                WHERE rd.run_id = runs.id)
WHERE data_deleted_at IS NULL;
