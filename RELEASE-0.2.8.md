# dsh-model-fusion 0.2.8

Large usage histories no longer require a full document scan for every status request. An incremental SQLite index preserves the existing status totals, supports cancellable asynchronous backfill, and resumes unfinished backfill on a later request. Status components for the same session share polling within a page, back off while collapsed, and pause while hidden or unmounted.

Fusion also supplies its frozen session routes to Compact Saviour through the optional `compactionRoutes` v1 service. With Compact Saviour 0.2.8, capacity planning and summary generation use the same physical model, effort and output limit. Model changes, cancellation and owner unload invalidate an old plan before it can commit a summary.

The changes were exercised on macOS with synthetic histories and the actual Desktop Host. The original reporter's approximately 4 GB OOM and complete abnormal compaction chain have not been reproduced. This release addresses the confirmed status-scan bottleneck and compaction routing mismatch; it does not claim that every symptom of issue #11 is resolved. Native Electron interaction and multi-hour production workloads remain unverified.

## Validation

On macOS, the release sources passed 287 unit tests, 241 native Host tests and 10 cross-plugin Host tests; one Windows-specific test was skipped. Type checking, build, DSHX checks and archive validation passed. Both runtime entry files exactly match the v9 installation previously exercised through the real Desktop Host. The 10 cross-plugin tests use synthetic adapters and attempted no network calls. A fresh authenticated Web run was blocked by an expired private browser handoff; no new real-model call was made for this release.
