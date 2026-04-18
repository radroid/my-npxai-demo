-- Fix regdoc_chunks.url: section anchors were appended as path segments
-- instead of URL fragments, producing 404 links. Convert "<base><anchor>"
-- into "<base>#<anchor>" for already-ingested rows so we don't have to
-- re-embed (embeddings are the expensive part; URLs are cosmetic metadata).
--
-- Two shapes exist in the data:
--   1. CNSC docs: base URL ends with '/', e.g.
--        .../regdoc1-1-1-v1-3/preface   →   .../regdoc1-1-1-v1-3/#preface
--   2. NSCA: base URL ends with 'FullText.html', e.g.
--        .../FullText.htmlsec1          →   .../FullText.html#sec1
--
-- Guards (url !~ '#') make this idempotent: safe to re-run.

-- Case 1: CNSC — take everything after the final '/' and turn it into a fragment.
UPDATE regdoc_chunks
SET url = regexp_replace(url, '^(.+/)([^/#]+)$', '\1#\2')
WHERE url LIKE 'https://www.cnsc-ccsn.gc.ca/%'
  AND url !~ '#'
  AND url !~ '/$';

-- Case 2: NSCA — split on the literal 'FullText.html' boundary.
UPDATE regdoc_chunks
SET url = regexp_replace(url, '^(.+FullText\.html)([^#]+)$', '\1#\2')
WHERE url LIKE '%FullText.html%'
  AND url !~ '#'
  AND url NOT LIKE '%FullText.html';
