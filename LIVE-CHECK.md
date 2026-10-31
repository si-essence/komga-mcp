# Live check against a Komga server

**Result: PASS, passed=16, failed=0** (31 Oct 2026).

Server: real Komga 1.29.2 (local `komga-1.29.2.jar` on `http://127.0.0.1:25600`). Fresh instance, unclaimed at the start of the check. `DATABASE_URL` unset. Throwaway admin `admin@example.com` created through `POST /api/v1/claim`. Password generated in `scripts/live-check.mjs` and never printed. A tiny 3-page CBZ was written under `/workspace/tools/komga-lib/Series1`. Library `mcp-live` pointed at that directory and was scanned.

Command: `KOMGA_URL=http://127.0.0.1:25600 npm run live-check`

Checks (all PASS): claim server, create library, scan library, lists tools, server info, claim status, current user, user redacts secrets, libraries, series, books list, age ratings, series unknown id (404), library delete preview, mark-read preview, mark series read (confirm).

Auth path exercised live: HTTP basic auth after claim. API-key header mode is mock-tested only. Other mapped operations are mock-tested only.

Caveats: scan wait was a short poll for a series id. About 16 of 155 mapped operations ran live.
