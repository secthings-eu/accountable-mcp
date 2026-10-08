# Accountable API: auth and users

Source: `research/bundle/*.js` (static analysis only, no live calls). `I` = `index-DbupgLzd.js`,
`O` = `OnlyBeforeAuthRoute-BCInpor-.js`, `AD` = `App-DxaMWFae.js`, `AI` = `App-iYaHYaD1.js`, `W` = `useWorkspaces-B-xqmQ5V.js`.

IMPORTANT coverage gap: the login, signup, TOTP, recovery-code, Google and Apple sign-in and `MFASetup` pages are
lazy chunks that are NOT in `research/bundle/` (`AI:225-236` lists `useLogin-D34HSrph.js`, `google_signin-D_S3H4Xj.js`,
`MFASetup-B4BolJ8i.js`, `useRecoveryCodeInput-Y2-yHTG2.js`, `login.amplitude-*.js`, `MobileAppLoginRedirection-*.js`,
`resetPassword-*.js`, `getMicrosoftIdToken-*.js`). Only the API wrappers living in `index-*.js` are visible, so
login request bodies are partly unverified. Fetch those chunks if exact login bodies are needed.

---------------------------------------------------------------------------------------------------

## 1. Practical answer for a headless MCP: how to get and keep a session

Facts (all from `I:118419-118459`, `I:215365-215470`):

- Session = `localStorage["auth"]` JSON: `{access_token, refresh_token, refresh_token_expires_at, exp, iat, ...}`.
  `exp`/`iat` are JWT-style epoch seconds. The client rewrites `exp` as `exp - iat + Date.now()/1000` after every
  login/refresh (`I:118456`, `AI:367`), so the access-token lifetime is `exp - iat` (value not visible in code; JWT, **unverified** length).
- Access token is sent as `Authorization: Bearer <access_token>`.
- Client refreshes proactively: if `exp - now < 600 s` it fires a refresh in the background and still returns the old token;
  if `< 5 s` it awaits the refresh (`I:118429-118437`). It stops trying when `refresh_token_expires_at < now`.
- Refresh: `POST {base}/v2/users/refresh-access-token`, body `{"refresh_token": "<rt>"}`, header `Content-Type: application/json` only
  (plain `fetch`, NOT axios, no x-client headers, no Authorization; `I:118445-118449`).
  Response `{access_token, finalPayload}`; stored as `{...old, access_token, ...finalPayload}`.
  `finalPayload` presumably carries `exp`, `iat` and possibly a new `refresh_token`/`refresh_token_expires_at`, because everything in it
  overwrites the stored object. Whether the refresh token is rotated is **unverified**: the MCP MUST persist every field of
  `finalPayload` (merge over stored auth) after each refresh and must not assume the old refresh_token stays valid.
- Refresh failure (`!res.ok`) => client logs out. The server error codes that trigger a refresh+retry of the original request are
  `jwt-expired`, `no-auth-token`, `invalid-token`; `jwt-issuer-invalid-expected*` forces logout (`I:215425-215440`).
- Refresh-token lifetime: stored in `refresh_token_expires_at` (ISO date string, parsed with `new Date(...)`); duration not in client code (**unverified**).
- No API key, personal access token or app-password mechanism exists in the client (no such endpoints in any chunk). The
  only non-interactive credentials are email+password (`POST /v2/users/login`) and the refresh token.
  `/v2/users/auth-continuation` (below) is a one-time token handoff (used for mobile-app/web redirect), not a long-lived key.

Design used by the MCP:
1. The user logs in once in a browser the MCP owns (or pastes `localStorage.auth`); the MCP stores the auth JSON in
   `~/.config/accountable-mcp/auth.json` (mode 0600) and refreshes the access token itself. When the refresh token
   expires it re-reads the session from that browser profile. Password login is protected by Turnstile and optional
   TOTP and is out of scope for automation: the human completes it in the window.
2. Refresh calls are serialised (the web client uses `deparallelize`, `I:111965-111968`) and the original request is
   retried once after a refresh.

---------------------------------------------------------------------------------------------------

## 2. Base URL and request headers

Base `https://app.accountable.eu/api` (`I:55337`). axios instance (`I:215380-215390`), timeout 60000 ms.

| Header | Value | Notes |
|---|---|---|
| `Accept` | `application/json` | |
| `Content-Type` | `application/json` | multipart uploads override |
| `x-bundleversion` | `1.0.30` | web bundle version at the time of writing |
| `x-client` | `accountable-web` | |
| `x-client-session` | random 8 char id from `Math.random().toString(32).slice(2,10)` | generated once per page load (`I:215223`); any stable random string |
| `X-Accountable-Context` | `JSON.stringify({path: location.pathname, search: location.search \|\| undefined})` | set on every request (`I:215396-215402`); MCP can send `{"path":"/"}` |
| `Authorization` | `Bearer <access_token>` | omitted when request config has `noHeaders: true` |
| `x-on-behalf-of` | `<customerId>` | ONLY for accountant ("expert") accounts reading a client's data (`O:5472`); also read at `I:215270` to find cached user |
| `x-workspace` | `<workspaceId>` | ONLY on `/v3/access/workspaces/*` calls, added from `currentWorkspaceId` in localStorage (`O:5476-5483`) |

Custom axios config flags (not sent on wire): `ignoreToast`, `noHeaders`, `stepUpRetried`.
Response interceptor returns `response.data` (so API bodies are used directly; envelope `{data: ...}` is part of the body for many endpoints).

Error body format (`I:215310-215340`): `{ errors: [{code, message, collection?}], type?: string }`.
Codes the client treats as silent (no toast): `no-auth-token`, `invalid-refresh-token`, `backend.errors.unexpected_error`,
`invitation.errors.accountant_not_found`, `no-account-connected`, `mfa-required`, `request-verification-failed`,
`could-not-verify-the-request-with-the-challenge-provider`. Type `forbidden_request_error` is special-cased in the toast code.
Step-up 403 body: `{error:"step_up_required", method:"totp"|"email_otp"}`.

---------------------------------------------------------------------------------------------------

## 3. Login flows (`/v2/users/*`, service `service$a = "/v2/users"`, `I:111847`)

### POST /v2/users/login (`I:111857`)
Signature `login(body, axiosConfig)`; used by the (missing) login chunk. Side effects: sets the analytics user from
`response.data` (`_id`, `email`). So the response shape is `{ data: User, ...auth fields }`.
Request body: not visible in available chunks. **(unverified)** probable `{ email, password, clientId?, code? | recoveryCode? }`; sign-in with Google/Apple very likely goes through
this same endpoint with `googleIdToken` / `appleIdToken` (field names confirmed in the signup form, `I:201200-201201, 201428, 201454`: signup `POST v2/users` body has `googleIdToken`, `appleIdToken`). Captcha token field name unknown.
Response (inferred from the near-identical auth-continuation handler, `AI:360-372`): `{ data: User, clientId, access_token, refresh_token, refresh_token_expires_at, exp, iat, ...}`.
Client stores `clientId` in `localStorage.clientId` (only if not set) and everything except `data`/`clientId` as `localStorage.auth`.

### 2FA (TOTP) / recovery
- Server signals the need for a second factor with HTTP error whose body `type === "mfa_required"` or `errors[0].code === "mfa-required"` (`I:111989-111990`).
- Client stores the entered credentials in an in-memory map for 300 s (`TTL_MS`, `I:111937-111958`) and routes to `/login/totp`
  (`/login/recovery-code` for recovery codes; routes at `AD:14600-14615`, `AI:1065-1072`). The totp page then re-submits credentials
  plus code (almost certainly to the same login endpoint, **unverified**; the field name for the code is unknown).
- 2FA management endpoints are in the missing `MFASetup` chunk; only the step-up map mentions `POST v2/users/mfa/totp` (enable 2FA, step-up reason `enable_2fa`, `I:215229`). Cache keys `MFA:Get/NewTOTP/VerifyTOTP/DisableTOTP` (`I:144924`). Request shapes **unknown**.

### Magic link / Turnstile / Google / Apple (what is known)
- A Cloudflare Turnstile challenge protects the password login; its token must be produced by a human in a real browser. Server errors
  `request-verification-failed` / `could-not-verify-the-request-with-the-challenge-provider` (`I:215327-215328`) mean the token was missing/invalid.
  Implication: password login is not automated by the MCP; the session created by the user in the browser is reused instead.
- Google sign-in: Google Identity Services script `accounts.google.com/gsi/client` (`I:90177`), GoogleLogin component yields an ID token sent as `googleIdToken`. Apple: `appleIdToken`. Microsoft token (`getMicrosoftIdToken` chunk) exists for some flow. All need a browser.
- Magic link for END USERS: no endpoint found. The only `magic-link` is the accountant one: `POST /v3/access/accountants/magic-link` body `{...email, redirect_uri: <origin>/expertlogin}` (`O:513-519`).
- Token handoff: `POST /v2/users/auth-continuation` body `{auth_continuation_token, clientId?}` (`I:213534-213548`); the token comes from URL query `?auth_continuation_token=` (`AI:358`). Response `{data: User, clientId, access_token, refresh_token, exp, iat, refresh_token_expires_at...}`. This is how another surface (e.g. mobile app, MobileAppLoginRedirection) hands a session to the web; token provenance **unknown**.

### POST /v2/users/logout (`I:111866`)
Body `{clientId}` where `clientId = localStorage.clientId` (skipped when absent or `logout(true)`). After it, client clears `localStorage.auth`, workspace id, redirects to `/`.
For the MCP: do NOT call logout on shutdown (may revoke the shared refresh token).

### POST /v2/users/refresh-access-token
See section 1.

### Other `/v2/users` auth-related
- `POST /v2/users/reset-password-request` body `{email}` (`I:111875`).
- `POST /v2/users/change-password` (step-up reason `change_password`, `I:215228`; body unknown).
- `GET /v2/users/auth-methods` (list login methods: password/google/apple/..), `POST /v2/users/auth-methods/{method}` body unknown, `DELETE /v2/users/auth-methods/{method}` (`I:111851-111856`). Settings page route `/settings/login-methods`.
- `POST /v2/users/delete-user-request` body `{email, password}` (`I:252704`; step-up reason `delete_account`). DESTRUCTIVE, do not expose.
- `GET /v2/users/email-check` params `{email}` (signup availability, `I:201130`).
- `POST /v2/users` signup (`I:201131`; body built by `formatValues`, includes `email,password,firstName,lastName,country,language,googleIdToken,appleIdToken,accountType,VATNumber,address,...`). Not recommended for MCP.
- `GET /v2/users/request-email-verification/{x}` (`I:213553`, the id is the argument of `sendVerificationEmail`).

---------------------------------------------------------------------------------------------------

## 4. Step-up authentication

Detection (`I:215221-215226`): `isStepUpRequiredResponse(body)` is true when `body.error === "step_up_required"` and `body.method` is `"totp"` or `"email_otp"`.
Applies to a 403 response (`I:215430-215432`).

Flow in the response interceptor (`I:215430-215462`), when `status === 403 && stepUp && !config.stepUpRetried`:
1. `reason = deriveStepUpReason(config)` (see below).
2. If `method === "email_otp"` and no reason can be derived: no verification is attempted (Sentry warning) and the original error is rejected.
3. Otherwise `runStepUpVerification({method, reason})` opens a modal (challenges are serialised and de-duplicated per `method:reason`).
4. On success the original request is replayed once with `stepUpRetried: true` (same method/url/body/headers). If the user cancels, the original error is rejected.

`deriveStepUpReason` (`I:215285-215301`): key = `"<method lowercase> <url without query and leading/trailing slashes>"`:
| Request | reason |
|---|---|
| `POST v2/users/change-password` | `change_password` |
| `POST v2/users/mfa/totp` | `enable_2fa` |
| `POST v2/users/delete-user-request` | `delete_account` |
| `POST v2/revenues`, `POST v2/revenues/recurrings`, `POST v2/quotes` | `change_iban` |
| `PUT v2/revenues/{id}`, `PUT v2/revenues/recurrings/{id}`, `PUT v2/quotes/{id}` | `change_iban` |
| `PATCH v2/users` with `email` changed and/or `IBAN` changed (compared to cached user; IBAN normalised: spaces removed, upper-cased) | `change_email`, `change_iban`, or `change_email_and_iban` |
(Fallback for PATCH v2/users: if a changed value cannot be compared, any non-empty `email`/`IBAN` in the body yields the reason.)
Note: this means creating/updating invoices and quotes (`/v2/revenues`, `/v2/quotes`) can trigger step-up when the IBAN is involved (**unverified** under which exact conditions the server demands it).

Endpoints (`rootPath = "/v3/auth/step-up"`, all with `ignoreToast`, `I:215770-215795`):
- `POST /v3/auth/step-up/request-email-otp` body `{reason: StepUpReason}` -> server emails a 6-digit code to the account email. The modal calls this automatically once on open for `email_otp`; resend cooldown 30 s; HTTP 429 = rate limited.
- `POST /v3/auth/step-up/verify-email-otp` body `{code: "123456"}` (6 digits, `CODE_LENGTH = 6`).
- `POST /v3/auth/step-up/verify-totp` body `{code}` (for `method: "totp"`; no request call).
Verify failure mapping: 429 -> rate_limited, other 4xx -> invalid_code, else request_failed. Response bodies are not read (success = 2xx).
The server evidently records the step-up as satisfied for the session/short window (the replay carries no extra header/token), so the retried request succeeds with the same Bearer token. Window length **unknown**.
MCP handling: on 403 `step_up_required` return a structured error telling the user which `reason`, expose tools `accountable_step_up_request_email_otp(reason)` and `accountable_step_up_verify(code, method)`, then let the assistant retry the original tool. TOTP cannot be automated unless the user supplies the secret (do not).

---------------------------------------------------------------------------------------------------

## 5. Current user, profile, workspaces (multi-company)

### GET /v2/users (`I:111879`) - current user ("me")
Returns the user object directly (not wrapped): fields read by the UI include `_id`, `email`, `created`, `language` (index into [en, fr, nl, de]: `indexedLanguages`, `I:145060`), `country` (`belgium`/`germany`, enum `AvailableCountries`), `firstName`, `lastName`, `companyName`, `VATNumber`, `IBAN`, `address{street,city,zip,country}`, `accountType`, `VATType`, `VATReturnFrequency`, `complementaryDays`, `subscriptionPlan`, `aiUsageConsents`, `settings{...}`. Query key `User:UserData`; fetched once enabled when an access_token exists.
### PATCH /v2/users (`I:235846-235850`)
Partial update; body any of the user fields (`updateUserData` strips `password, installations, xerius, subscriptionPlan, promocodes, settings.invoices`). Language: `{language: <number>}`; AI consent: `{aiUsageConsents: {expenses|revenues|transactions|taxes|vehicles|documents_repository|summaries: "ask"|..., ai_tax_advisor: "deny"|...}}`.
Changing `email` or `IBAN` triggers step-up (section 4). Changing `firstName,lastName,VATNumber,companyName,address` can break an active Peppol/KYC registration; UI guards with `peppolDeactivationGuard` (reads `GET /v2/integrations/peppol` and `GET /v2/users/verifications`). MCP: treat profile writes as destructive.

### Multi-company / workspaces: how the active company is selected
- A normal Accountable user account is ONE company. There is no company switcher for end users and no company id on the wire in `index-*.js` requests; the Bearer token identifies the user/company.
- "Workspaces" belong to the ACCOUNTANT (expert) product: `useWorkspaces` (`W:22-40`) calls `getWorkspaces = GET /v3/access/accountants/workspaces` (`O:537`), response `{workspaces: [{_id, members: [{role: owner|admin|member, ...}], ...}]}`; selected workspace = `currentWorkspaceId` stored in `localStorage` (`I:118787-118806`).
- Selection mechanism for workspace-scoped calls = request HEADER `x-workspace: <workspaceId>` (not a path segment), added by the helper `it()` in `O:5473-5484` to `/v3/access/workspaces/*` calls.
- Accountant viewing a specific client's books = HEADER `x-on-behalf-of: <customerId>` (`O:5471-5473`; `customerId` is the client `_id` from `GET /v3/access/workspaces/clients`). Whether the same header is used on all client-data endpoints (expenses, revenues...) was not located (**unverified**), but the `readCurrentUser` code (`I:215270`) uses it to look up the cached user for that client, so it is a general header.
- Endpoints (accountant side, `O:511-545, 1027-1045, 5486-5530`):
  - `POST /v3/access/accountants/signup`, `POST /v3/access/accountants/signin` (body unknown, response has `accountant.emails[]`; `ignoreToast` option; MFA errors handled by `handleMfaRequired`), `POST /v3/access/accountants/magic-link`, `GET/PATCH /v3/access/accountants`, `POST /v3/access/accountants/change-password|reset-password-request|delete-request`, `POST|DELETE /v3/access/accountants/auth-methods/{x}`.
  - `GET /v3/access/accountants/workspaces`, `GET /v3/access/accountants/workspace-invites`, `GET|PATCH /v3/access/accountants/invitations` (params `status, page, per_page, token, workspace_id`).
  - Workspace admin (with `x-workspace`): `POST|PATCH|DELETE /v3/access/workspaces[/{id}]`, `POST|GET|DELETE /v3/access/workspaces/client-invites`, `POST|GET|DELETE /v3/access/workspaces/workspace-invites`, `DELETE /v3/access/workspaces/clients/{id}`, `GET /v3/access/workspaces/clients` (params `page, per_page, keyword, user_plan_type (csv), user_vat_type (csv)`, sorting params), `DELETE /v3/access/workspaces/members/{id}`, `PATCH /v3/access/workspaces/members/{id}/role` body `{role}`.
  - End-user side of sharing with an accountant (`hn = "/v3/access/clients"`, `O:1027`): `POST /v3/access/clients/invitations`, `GET|PATCH|DELETE /v3/access/clients/invitations` (`?token=`, params `page, per_page, status`), `GET /v3/access/clients/workspaces` (params `page,per_page`), `DELETE /v3/access/clients/workspaces/{workspaceId}`.
  - `POST /v3/access/accountants/pusher/auth` (Pusher private channel auth for accountants, Bearer header, `I:118748`); end users: `POST /v1/users/me/pusher/auth` (form-urlencoded `socket_id, channel_name`, `I:118631-118647`).
- MCP consequence: for a regular freelancer, no company selection is needed. Multi-client accountant support would require the accountant token plus `x-on-behalf-of` (**out of scope / unverified**).

### Other `/v2/users` endpoints
- `GET /v2/users/feature-counters` (`I:194421`): per-feature usage counters (shape not read in visible code; used as `FeatureCounts`, staleTime 0). **(shape unknown)**
- `GET /v2/users/file-url?filePath=<path>` (`I:213529`) or `params {..}` (`I:165958`): resolves a stored file path to a signed URL.
- `GET /v2/users/upload-url?<params>&n=<counter>` (`I:159571`): returns `{url, fields}` for S3 POST (multipart form, then `file` appended); see uploads area.
- `GET /v2/users/tax-office?steuernummer=&state=` (DE), `POST v1/users/check/tax-number` body `{state, steuernummer}` (`I:259725`).
- `GET /v2/users/accountable-professional-codes?...`, `GET /v2/users/accountable-professional-codes/{nace}` (occupation APC1/APC2; `I:259631-259641`).
- `GET /v2/users/search-enterprises?name=&country=&VATNumber=` (BE KBO lookup, comma array format, `I:201123`).
- `GET|POST|DELETE /v2/users/minfin/session|login?redirectUrl=|synchronize|(root)|intervat-grant` (Belgian MyMinfin / Intervat link; `O:925-945`; `intervat-grant` body `{workspaceId}`).

---------------------------------------------------------------------------------------------------

## 6. User settings: `/v2/users/settings/*` (`service$2`, `I:235836`)

All PATCH unless noted, body = the settings fragment, response unread (invalidate user query):
- `PATCH /v2/users/settings/email-aliases` body `{emailAliases: string[]}` (inbox addresses for document forwarding).
- `PATCH /v2/users/settings/datev` body object (DATEV export settings; shape unknown).
- `PATCH /v2/users/settings/accountable-banking` body object (unknown).
- `PATCH /v2/users/settings/daily-sales-book` body `{optIn: boolean}`.
- `PATCH /v2/users/settings/autopilot` body object (unknown).
- `PATCH /v2/users/settings/invoices` and `PATCH /v2/users/settings/quotes` (`I:166030-166034`, `saveInvoiceSettings({isQuote, ...body})`; invoice numbering/template settings; body unknown).
- `PATCH /v2/users/settings/taxes`, `PATCH /v2/users/settings/taxes/{taxYear}` (`I:213556-213565`; `updateTaxesSettings`, `updateTaxYearSettings`).
- `PUT /v2/users/settings/profit` (profit projection; `I:213551`) and `GET /v2/users/settings/profit` (`I:194527`).
`GET /v2/settings/cash-available` and `PATCH /v2/settings/cash-available` (`O:5699-5701`): response `{data: {...factors}}` (cash-available factors, shape unread here). No other `/v2/settings/*` endpoints found.

---------------------------------------------------------------------------------------------------

## 7. Identity verification: `/v2/users/verifications` (`service$4`, `I:235612`)
- `GET /v2/users/verifications` (ignoreToast; 404 => null): `{identity: {status, verifiedData{firstName,lastName}}, company: {status, verifiedData{vatNumber, companyName}}}`; status enum identity: approved, resubmission_requested, declined, expired, abandoned, review, not_started, submitted, started; company: approved, declined, not_started. Providers: Veriff, Swan, Access.
- `POST /v2/users/verifications` (create), `PUT /v2/users/verifications/start` (start/restart KYC session; response contains provider session data), `GET /v2/users/verifications/company-names/{vatNumber}` (BE only, response `{companyNames: string[]}`).
Used for Peppol/banking KYC; MCP: read-only status only.

---------------------------------------------------------------------------------------------------

## 8. Proposed MCP tools

Auth/session (internal module, plus a few tools):
- `accountable_auth_status` (read-only): reports whether a session exists, access-token expiry, refresh-token expiry, user email; no params.
- `accountable_auth_set_refresh_token` (writes local state only): params `refresh_token`, optional `refresh_token_expires_at`; validates by refreshing, persists merged auth JSON.
- `accountable_step_up_request_email_otp` (sends an email; low risk): param `reason` (`change_iban|change_email|change_email_and_iban|change_password|enable_2fa|delete_account`).
- `accountable_step_up_verify` (side-effect: unlocks session): params `code` (6 digits), `method` (`email_otp|totp`, default `email_otp`).
User:
- `accountable_get_me` (read-only): `GET /v2/users`.
- `accountable_get_feature_counters` (read-only): `GET /v2/users/feature-counters`.
- `accountable_get_verification_status` (read-only): `GET /v2/users/verifications`.
- `accountable_get_profit_settings` (read-only): `GET /v2/users/settings/profit`.
- `accountable_update_profile` (destructive, may require step-up): params partial user fields; PATCH `/v2/users`. Optional, low priority.
- `accountable_update_invoice_settings` / `accountable_update_email_aliases` (writes, low priority).
Do NOT expose: delete account, change password, logout, MFA changes, auth-method deletion.

Internal HTTP client requirements: send headers from section 2; on 401/403 with error code `jwt-expired|no-auth-token|invalid-token` refresh once and retry; on 403 `step_up_required` return the structured error above; 60 s timeout; serialise refresh.

---------------------------------------------------------------------------------------------------

## 9. Could not determine
- Exact login request body (email/password field names, clientId, captcha token field, TOTP/recovery code field, Google/Apple token field on login) because the login chunks are missing from `research/bundle/`.
- Whether the refresh token is rotated on refresh and its lifetime (only `refresh_token_expires_at` is read); access-token lifetime (`exp - iat`).
- Whether logout revokes the refresh token server-side; whether concurrent sessions (browser + MCP) invalidate each other.
- Whether any endpoint besides the login page requires Turnstile.
- Step-up validity window, and exactly when the server demands step-up for `/v2/revenues` and `/v2/quotes` writes.
- Shapes of `feature-counters`, `/settings/{datev,autopilot,accountable-banking,invoices,taxes}` bodies, MFA endpoints.
- How `x-on-behalf-of` is applied globally for accountant sessions; end-user multi-company switching appears not to exist.
