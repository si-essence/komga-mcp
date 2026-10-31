# komga

MCP connector for a self-hosted [Komga](https://github.com/gotson/komga) server (v1.29.2). It speaks the HTTP API over stdio and over stateless Streamable HTTP on localhost.

Komga is MIT-licensed software. This connector does not copy that code. It only calls the HTTP API on the server you configure. It is not affiliated with Komga.

The spec file `komga.openapi.json` is copied from Komga 1.29.2 (MIT, gotson/komga). It has 177 operations. This connector covers 155 of them in 34 tools. It leaves out 22 endpoints that return files, images, page bytes, font bytes, or multipart uploads. `scripts/gen-operations.mjs` writes `src/operations.ts` from the spec. Do not edit that file by hand.

Self-hosted servers only. There is no default base URL. `KOMGA_URL` is required.

## Setup

```bash
npm install
npm run ci
npm start
npm run start:http
```

`npm start` speaks stdio. `npm run start:http` serves Streamable HTTP at `http://127.0.0.1:3000/mcp` and `GET /health`. HTTP mode has no authentication of its own. Keep it on localhost.

```json
{
  "mcpServers": {
    "komga": {
      "command": "node",
      "args": ["/workspace/connectors/komga/dist/index.js"],
      "env": {
        "KOMGA_URL": "http://127.0.0.1:25600",
        "KOMGA_API_KEY": "...",
        "KOMGA_ALLOW_WRITES": "false",
        "KOMGA_TOOLSETS": "libraries,series,books,collections,readlists,referential_metadata,management"
      }
    }
  }
}
```

You can set `KOMGA_USERNAME` and `KOMGA_PASSWORD` instead of `KOMGA_API_KEY`. The connector then sends HTTP basic auth.

Docker (HTTP, no authentication, keep it on localhost):

```bash
docker build -t komga .
docker run -p 127.0.0.1:3000:3000 \
  -e KOMGA_URL=http://127.0.0.1:25600 \
  -e KOMGA_API_KEY=... \
  komga
```

Do not put keys in the image.

Regenerate the registry after an OpenAPI bump.

```bash
npm run gen:operations
```

`scripts/live-check.mjs` talks to a real server over stdio. It needs `KOMGA_URL` and either `KOMGA_API_KEY` or `KOMGA_USERNAME` plus `KOMGA_PASSWORD`. It can also claim a fresh server when `KOMGA_CLAIM=true`. It sets `KOMGA_TOOLSETS=all`. Gated writes run only when `KOMGA_ALLOW_WRITES=true`. It prints pass or fail lines only. This workspace does not start Komga.

## Config

| Variable | Meaning |
| --- | --- |
| `KOMGA_URL` | Required. Self-hosted origin, `http` or `https`, no userinfo, query, or hash. Example `http://127.0.0.1:25600`. |
| `KOMGA_API_KEY` | API key from User settings. Sent as the `X-API-Key` header. |
| `KOMGA_USERNAME` | Optional login, usually the account email. Set together with `KOMGA_PASSWORD` when no API key is set. |
| `KOMGA_PASSWORD` | Password for that login. Sent as HTTP basic auth. Redacted everywhere. |
| `KOMGA_ALLOW_WRITES` | Must be the literal `true` before a confirmed write is sent. |
| `KOMGA_TOOLSETS` | Comma list of toolsets, or `all`. Default is the read-focused set below. |
| `KOMGA_PER_MINUTE` | Local request budget. Default 30. Cache hits do not spend it. |
| `KOMGA_TIMEOUT_MS` | Upstream timeout. Default 20000. |
| `KOMGA_CACHE_TTL_SEC` | Read cache TTL. Default 60. Writes clear the cache. |
| `KOMGA_CONTACT` | Contact token in the User-Agent. Must not contain a secret. |
| `MCP_TRANSPORT` | `stdio` or `http`. `--http` overrides. |
| `PORT` | HTTP port. Default 3000. |

Invalid values are reported by field name and issue code. The rejected value is not included. API keys, passwords, and emails are redacted in logs, errors, tool results, thrown messages, and URLs.

Auth is `X-API-Key` when `KOMGA_API_KEY` is set. Otherwise it is `Authorization: Basic` from `KOMGA_USERNAME` and `KOMGA_PASSWORD`. The connector never puts credentials in the API URL.

## Safety

GET is a read. POST, PUT, PATCH, and DELETE are writes, except a reviewed list of POST queries in `READ_POST_PATHS` (book list, series list, series groups, filesystem listing). `GET /api/logout` and `GET /api/v1/login/set-cookie` are writes (`GET_SIDE_EFFECT_PATHS`). Anything not on the read list stays a write.

A write needs `confirm: true` as a boolean and `KOMGA_ALLOW_WRITES=true`. The string `"true"` is rejected. Otherwise the tool returns a dry-run preview of method, path, query, and redacted body, and it sends nothing. Destructive, credential, and exposure operations add a warning line on the tool and on the preview. That set covers deletes, scans, analyze, refresh, trash empty, user changes, API key create and revoke, password change, settings, session, and claim.

API key create returns the key once, with a shown-only-once note. Later list and get calls redact it. User `email`, `password`, `key`, and `token` fields are redacted. Library folder paths stay in successful responses. Error text drops stack traces and filesystem paths.

HTTP 401 is unauthorized. HTTP 403 is forbidden. HTTP 404 is not found. HTTP 400 and 422 are invalid input. HTTP 429 includes Retry-After. Other failures are server, network, or timeout. Response bodies are capped.

File downloads, poster and page images, raw page bytes, font files, CSS, epub resources, and multipart poster uploads are not exposed.

## Tools

Default `KOMGA_TOOLSETS` publishes 7 tools. `KOMGA_TOOLSETS=all` publishes 34 tools (155 operations, 91 reads and 64 writes). Each tool takes `action` plus optional `params`, `query`, `body`, and `confirm`.

`action` `help` with optional `target` returns the path, query, and body fields for one action. Descriptions list action names only, so the tool list stays small.

| Toolset | Tool | Operations | Default |
| --- | --- | --- | --- |
| libraries | `komga_libraries` | 9 | yes |
| series | `komga_series` | 16 | yes |
| books | `komga_books` | 16 | yes |
| collections | `komga_collections` | 5 | yes |
| readlists | `komga_readlists` | 5 | yes |
| referential_metadata | `komga_referential_metadata` | 13 | yes |
| management | `komga_management` | 1 | yes |
| announcements | `komga_announcements` | 2 | no |
| api_keys | `komga_api_keys` | 3 | no |
| book_pages | `komga_book_pages` | 1 | no |
| book_poster | `komga_book_poster` | 5 | no |
| claim | `komga_claim` | 2 | no |
| client_settings | `komga_client_settings` | 6 | no |
| collection_poster | `komga_collection_poster` | 4 | no |
| collection_series | `komga_collection_series` | 1 | no |
| current_user | `komga_current_user` | 3 | no |
| deprecated | `komga_deprecated` | 13 | no |
| duplicate_pages | `komga_duplicate_pages` | 6 | no |
| file_system | `komga_file_system` | 1 | no |
| fonts | `komga_fonts` | 1 | no |
| history | `komga_history` | 1 | no |
| import | `komga_import` | 3 | no |
| mihon | `komga_mihon` | 4 | no |
| oauth2 | `komga_oauth2` | 1 | no |
| readlist_books | `komga_readlist_books` | 3 | no |
| readlist_poster | `komga_readlist_poster` | 4 | no |
| releases | `komga_releases` | 1 | no |
| series_poster | `komga_series_poster` | 4 | no |
| server_settings | `komga_server_settings` | 2 | no |
| sync_points | `komga_sync_points` | 1 | no |
| tasks | `komga_tasks` | 1 | no |
| user_session | `komga_user_session` | 3 | no |
| users | `komga_users` | 7 | no |
| web_pub_manifest | `komga_web_pub_manifest` | 7 | no |
