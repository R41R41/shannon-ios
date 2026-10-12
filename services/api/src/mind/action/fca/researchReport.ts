/**
 * The shape of a research task's report (deep research, 2026-10-13): what its `task.send` and its completion summary carry, and
 * what the owner's app shows as `report.text`. Markdown the app renders; the spoken form is made elsewhere (`fcaSpokenReport.ts`).
 * At most 2,000 characters, the bound of a task message and of a completion summary.
 */
export const RESEARCH_REPORT_FORMAT = 'Write the report (the task.send message and the fca_complete summary) in Japanese Markdown, at most 2000 characters, '
  + 'answer first:\n'
  + '## 結論\n(one or two sentences that answer the request directly, with the explicit date when it matters)\n'
  + '## わかったこと\n- (a key finding) — [(source title)](URL) 「(short quoted span from that page, when one was cited)」\n'
  + '(three to six findings, each with the source it came from; only URLs from actual results)\n'
  + '## 未確認・注意\n- (what could not be confirmed, conflicts between sources, or how old the information is; omit the section when nothing)\n'
  + 'No other headings, no tables, no raw JSON, no invented URLs.';
