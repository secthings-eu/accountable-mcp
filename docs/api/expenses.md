# Accountable API: expenses (+ document upload flow)

Source: `research/bundle/index-DbupgLzd.js` (abbrev. `I:`), static analysis only. Base URL `https://app.accountable.eu/api`.
All calls go through `axiosInstance` (I:215342): Bearer auth, response interceptor returns `response.data` (so axios `.then(r => r.expense)` below means the JSON body has key `expense`). Default timeout 60 s.

**Sources.** `I:` = `research/bundle/index-DbupgLzd.js` (line numbers re-based on the current pretty-printed file). Lazy chunks now available and cited: `BT:` = `index-BT6L6J5X.js` (expenses list page + dropzone), `D6:` = `index-D6LEqBSY.js` (expense side panel/form), `SC:` = `ShoppingCartIcon2.component-BzTlIOWc.js` (upload+create helper), `FV:` = `FlieViewer-GcqJ9ubk.js` (document viewer "Remplacer"), `CC:` = `index-ccfRCGR-.js` (extra `/v2/expenses/*` calls), `UF:` = `useExpensesFilters-BlRkW2vs.js`, `OB:` = `OnlyBeforeAuthRoute-BCInpor-.js`. Minified aliases of main-file exports are noted (`createExpense = iE`, `uploadFile = dH`, `updateExpenseById = p9`, `patchLockedExpense = zs`, `addExpense = vg`, `deleteExpenseById = zp`, `cleanExpenseDataForSubmit = pa`, `bulkUpdateExpensesV3 = o9`, `patchExpense = tH`, `getExpenses = iD`).

## 0. Verified call sequences (summary)

**A. "Uploader une nouvelle dépense" / dropzone (BT:2505-2530, 2714, 2829, 3559; helper SC:35-40)**
1. `uploadFile({ file, onProgress, category: UploadTypesEnum.expense })` -> category is exactly **`"expense"`** (`l.expense`, `dI` = `UploadTypesEnum`, SC:36). i.e. `GET /v2/users/upload-url?category=expense&contentType=<mime>&n=<n>` then multipart POST to the returned presigned URL (section 1).
2. `createExpense(key, options?.isFake)` -> `POST /v3/expenses/from-file?cache=<ms>` body `{file_name: basename(key), file_path: key, is_fake}`; resolved value is the `expense`; the UI then uses `expense._id` (e.g. invalidates "new expenses count", opens the expense in the side panel). The expenses page never uses `/v3/conversations/documents`; that path is only the AI chat/autopilot dropzone (`useIsAutopilotDropzoneEligible`, I:204228).
3. Dropzone config: accepted `expensesAcceptedFileUploaderTypes` (pdf, jpeg, png, xml), up to 10 MB; uploads run through a scheduler (rate limit 2/s bucket 3, 5 concurrent jobs; I:~261700 `useParallelScheduler`). `onAfterDropAccepted` is only a paywall counter check.

**B. "Remplacer" on an existing expense (FV:3200-3210, 3374-3395; D6:9265-9300)**
1. File picker -> `uploadFile({ file })` with **no category -> default `"document"`** (FV:3200 `Bt({file:C})`; `Bt`=`dH`=uploadFile; default category `UploadTypesEnum.document`, I:159560). Max size/accept come from viewer props.
2. Callback `onReplace({key})` only does `form.setValue("file.path", key, {shouldDirty:true})` (D6:9265). **Nothing is sent yet**; the new path is persisted when the user clicks "Sauvegarder" (PUT, section B2 below), where it is sent as `file: {path, name, hash: undefined}`. The viewer's delete button sets `file.path = null` (then saved as `file: null`).
3. Exception: the bank-transaction row "attach document" (`index-nB-8JcPU.js:2063-2078`) does `uploadFile({file})` (category default `document`) then immediately `PATCH /v3/expenses/<documentId>` body `{expense:{file:{path:key,name:file.name}}}` (via `patchExpense`).

**B2. "Sauvegarder" in the expense side panel (D6:8941-8957, 9067)**
`values = cleanExpenseDataForSubmit(formValues)` (= `formatExpenseForSubmit`, I:197560). Then:
- no `_id` (new manual expense): `addExpense(values)` -> `POST /v3/expenses`.
- expense is locked (`reviewStatus==="reviewed"` or `taxLock.length` or exported; D6:8890-8895): `patchLockedExpense(id, values)` -> `PATCH /v3/expenses/:id` (restricted body, 3.9).
- otherwise: `updateExpenseById(id, values)` -> **`PUT /v3/expenses/:id`** body `{expense: values-without-shouldUpdateTaxStatus/create_recurrence, options:{update_tax_status, create_recurrence}}`.
Full field list/format: section 4.1.

**C. Validation ("Revoir" tag removal)**: there is no separate validate call. `formatExpenseForSubmit` deliberately sets `isValidated: undefined` (dropped from JSON) and the only save path is the PUT above; the list tabs are driven by the filter `is_validated=false` ("to review", BT:1929-1960) and the expense leaves it after the form is saved, so **the server marks the expense validated as a side effect of PUT /v3/expenses/:id** (inferred: nothing else in the UI changes `isValidated`; expenses created from a transaction are created with `isValidated:true`, I:198410, via POST). Accountant "reviewed" state is separate (`accountantReview.reviewStatus`, locks the doc).

**D. Delete**: single: `deleteExpenseById(id)` (I:243614): first cancels scheduled Swan payments of linked transactions, then `DELETE /v3/expenses/:id`. If the expense has `recurrence`, the UI offers "delete expense only" (DELETE) or "expense + recurrence" (`POST /v3/expenses/recurrences/<recurrence._id>/pause` then DELETE; D6:9240-9250). Asset items trigger an amortisation confirm modal. Bulk (list selection): **`DELETE /v2/expenses/bulk?ids=<id1,id2,...>`** (comma list, CC:28-35; scheduled payments cancelled first).

---------------------------------------------------------------------------

## 1. Document upload flow (local file -> `file_path`)

Implemented by `getUploadURL` / `uploadFileToS3` / `uploadFile` (I:159538-159599). Same helper is used for expenses, revenues, credit-card statements, AI conversation attachments, etc.

### Step 0: client-side checks
- Accepted types for expenses: `expensesAcceptedFileUploaderTypes` (I:111383) = `image/jpeg (.jpeg)`, `image/png (.png)`, `application/pdf (.pdf)`, `application/xml (.xml)` (e-invoice XML). Generic list `globalyAcceptedFileUploaderTypes` (I:111360) = jpeg/png/pdf. `maxFileSize` = 10 MB (`ONE_MB*10`, I:111391; ONE_MB = 1000*1000) (dropzone limit; server limit unverified).
- MIME type = `file.type`, else lookup by file name via `mime` lib; `text/xml` is normalised to `application/xml` (`unifyFileType`). No MIME -> error "Unsupported file type".

### Step 1: request a presigned S3 POST
```
GET /v2/users/upload-url?category=<UploadType>&contentType=<mime>&n=<counter>
Authorization: Bearer ...
```
- `category` (enum `UploadTypesEnum`, I:158129): `profile-picture`, `invoice-logo`, `expense`, `invoice`, `document` (default if none given), `email-attachment`, `repository-document`, `conversation-attachment`, `human-conversation-attachment`, `payslip`. **For the expenses dropzone it is `expense` (verified, SC:36); "Remplacer" and attach-from-transaction use the default `document`.** The AI conversation-drop path explicitly uses `document` and then creates documents server-side (see 1b).
- `contentType`: MIME from step 0. `n`: incrementing integer (cache buster).
- Response (shape read by `uploadFile`): `{ url: { url: string, fields: Record<string,string> } }`. `url.url` is the S3 (presigned-POST) endpoint, `url.fields` are the form fields (policy, signature, ... and **`key`**).

### Step 2: upload to S3 (multipart/form-data, no Authorization header)
```
POST <url.url>            (defaultAxiosInstance, plain axios, 60 s timeout, no Accept/JSON headers, no bearer)
Content-Type: multipart/form-data
form fields: every entry of url.fields (in order), then "file" = <binary>  (file field must be LAST)
```
Success is any 2xx (response body ignored). `uploadFile` resolves to `url.fields`, so the caller reads **`{ key }`** = the storage path (e.g. `<prefix>/<uuid>.pdf`).

### Step 3: use the key
- `file_path` / `file.path` = `fields.key` (full key). `file_name` = `key.split("/").pop()` (createExpense derives it that way: `ee.split("/").pop()`).
- Other callers pass `filename: key.split("/").pop()` to OCR endpoints (revenues, credit-card statements) - same pattern.

### Step 4: create/attach
- New expense via OCR: `POST /v3/expenses/from-file` (section 3.1) with the key.
- Attach to an existing/manual expense ("Remplacer", or add a doc to a manual expense): put `file: { path: <key>, name: <basename or original name> }` in the `expense` body of `PUT`/`PATCH /v3/expenses/:id` (verified, section 0.B). Remove attachment = `file: null`. `hash` is read-only.

### Step 1b (alternative): "AI conversation drop" ingestion
`useCreateConversationDocuments` (I:204228): for 1-25 files: `uploadFile({category:"document"})` for each, then
`POST /v3/conversations/documents` body `{ idempotencyKey: "drop-<uuid>" | given, message?: {content}, documents: [{file:{path:key,name,contentType,sizeInBytes}}], conversationId?, aita_version:"1.0.2" }` (I:204122). The server classifies each document (expense / revenue / repository_document / credit_card_statement; `targetResource: {type,id}`) and creates the record; poll `GET /v3/conversations/:cid/documents?messageId=<id>` every 5 s while status in `queued|processing`; `POST /v3/conversations/:cid/documents/:docId/reclassify` and `/undo`. Used by the AI chat dropzone only, not by the expenses page.

### Reading a stored file
`GET /v2/users/file-url?filePath=<key>` (I:213495 `getFileUrl`; also `getFilePath` I:165927 with `params`) -> presigned download URL (response shape unverified).

---------------------------------------------------------------------------

## 2. Conventions
- IDs: Mongo-style `_id` strings.
- Date on wire: `expenseDateNumber` integer `YYYYMMDD` (form field `expenseDate` "YYYY-MM-DD" is converted at I:197560). Due date / payment date: `"YYYY-MM-DD"` strings under `payments.status`.
- `lang` query param (UI language `en|fr|nl|de`) is sent on reads, categories come back translated.
- Cache buster: `createExpense` appends `?cache=<Date.now()>`.

---------------------------------------------------------------------------

## 3. Endpoints (`service$1 = "/v3/expenses"`, I:243387)

### 3.1 `POST /v3/expenses/from-file?cache=<ms>` : create expense from uploaded document (OCR)
I:243388 `createExpense(filePath, isFake)`.
- Timeout 5 min (`FIVE_MINUTES$1`, I:120593).
- Body: `{ file_name: string /* basename of file_path */, file_path: string /* S3 key from upload flow */, is_fake: boolean|undefined }`. `is_fake`: marks demo/fake expense (also `isFake` on expense) **(meaning unverified)**.
- Response: `{ expense: Expense }` (function returns `.expense`). Side effects in UI: analytics event `createExpense`, invalidates `UserCacheKeys.FeatureCounts`.
- The created expense is OCR-filled (supplier, date, items, VAT, `guessed_data`) and typically `isValidated:false` until the user reviews it.

### 3.2 `GET /v3/expenses` : list / filter / search
I:243429 `getExpenses(opts)`. The function accepts camelCase aliases and rewrites them to the wire names (comma-joined arrays, empty strings skipped: `qs.stringify(..., {skipEmptyString:true, arrayFormat:"comma"})`).

| Wire param | Alias in UI opts | Notes |
|---|---|---|
| `page` | `page` | 1-based |
| `per_page` | `perPage` | |
| `search` | `text` | free text (supplier, notes...) |
| `categories` | `categoryIds` | comma list of category ids |
| `is_validated` | `isValidated` | bool; `false` = "to review" ("Revoir"), `true` = reviewed |
| `is_invoice` | `isInvoice` | bool; "facture en bonne et due forme" |
| `is_credit_note` | `isCreditNote` | bool |
| `sufficiently_documented` | `sufficientlyDocumented` | bool |
| `date_range` | `dateRange` | bank-transaction filters serialise ranges as `YYYY-MM-DD/YYYY-MM-DD` (useBankTransactionsFilters-Dt9T1ycd.js:~40); same format very likely here **(unverified for expenses)** |
| `vat_period` | `periods` | comma list of period codes. Live-confirmed: plain year `2026` works. Format of quarter/month: see below |
| `tax_period` | `taxPeriods` | UI passes a plain year number (`taxPeriods: a.period.year`, Tax-CqguZWk6.js:2701) |
| `ids` | `ids` | restrict to ids (BT:2164) |
| `attachment` | | `"true"`/`"false"` has/hasn't a file (BT:2155-2199) |
| `fields` | | projection, e.g. `"_id"` (BT:2185) |
| `expand` | | array: list page uses `["taxLock","recurrence"]`, `perPage:25` (BT:1906) |
| `reviewed` | | expert (accountant) view: `"false"` = not reviewed by accountant (BT:1929) |
| `exported` | | seen on revenues; exports exclude previously exported **(unverified for expenses)** |
| `lang` | auto | |
| `sort` | pass-through | built as `<cellId>_<direction>` (I:142493); expenses default `expenseDate_desc` (I:160403); autoreview uses `autofiledAt_desc` (OB:9667); table also sorts on `isValidated` (BT:1880). Other cell ids unknown. |
| `autoreview_pending` | pass-through | `true` returns docs auto-filed by Autopilot not yet acknowledged (OnlyBeforeAuthRoute:9667) |
| any other key | pass-through | e.g. `payment_status`, `unpaid`, `due` filters likely exist; see `GET /v3/expenses/filters` |

Period filter format. The expenses filter UI is **server-driven**: `GET /v3/expenses/filters` returns filter definitions `{key, title, options:[{key,title}]}` and the UI sends each selected `option.key` verbatim (UF:36-70, `filtersStoreCreatorV2` `onChange(key,value)`; arrays comma-joined by `getExpenses`). So the authoritative quarter/month value must be read from that response (call it once; look at the `vat_period` filter options). The sibling revenue filter (same store design) serialises periods as: yearly `"2026"`, quarterly `"q_3_2026"`, monthly `"m_3_2026"` (underscores; `filterConstraints-CJPES_Rt.js:17-23`), which is the best candidate for expenses (since `q-3-2026` is rejected live and `2026` works). The `q-<q>-<y>` / `m-<m>-<y>` / `y-<y>` form comes from `periodToValue` (I:166519) which is used by the form's period picker, not by list filters. Period *objects* in bodies are `{year}`, `{quarter,year}`, `{month,year}` (`getPeriodFromDate`, I:166455).

Response body: `{ expenses: Expense[], paging: { page, per_page, total_pages, total_count } }`. UI maps to `{data, paging:{page,perPage,pagesCount,totalCount}}`.

### 3.3 `GET /v3/expenses/filters`
I:243533. Params `{lang}`. Response `{ filters: [{ key, title, options?: [{ key, title }] , ...}] }`; the UI maps each to `{label:title, options:[{label:n.title,value:n.key}]}` and sends `option.key` as the filter value (UF:36-70). Read this once to learn exact filter keys (incl. the `vat_period` option keys).

### 3.4 `GET /v3/expenses/:id`
I:243478 `getExpenseById`. Params: `expand=payments.transactions,taxLock,guessed_data,recurrence`, `lang`. Response `{ expense }`.
- Additional fields read by the panel that are not in the list payload: `origin: {from, process}` (`process` in `web|dropzone|email|experts|unknown|mobile|peppol`, = `ECreatedFrom` I:159962; D6:9529-9540 shows "created via <origin.from> on <created>"), `imported` (bool), `created` (date), `autofiledAt`, `autofileOpenedAt`, `references.ubl31_file_path` (Peppol UBL file), `references.exported_in_workspaces`. **`createdFrom` is NOT an expense field; on expenses it is `origin.process`/`origin.from`** (`createdFrom` appears on revenues/linked revenues). Whether the list payload includes `origin` is not visible; use get-by-id.
- `autofiledAt`: set when Autopilot (AI) filed AND auto-reviewed the document without user action (UI text key `autopilot.marked_as_reviewed_by_ai`; D6:9539, index-wqD2-7U-.js:4810 puts an "auto-reviewed by AI" entry in the document timeline). `autofileOpenedAt` is set when the user first opens it (acknowledge call, 3.14). Origin can be email inbox, dropzone, Peppol etc.; autofile is independent of origin.
- `expand` tokens seen: `payments.transactions` (populates `payments.transactions[]` with full transaction objects; UI then converts to ids and keeps full objects in `_matchedTransactions`), `taxLock` (array of locks; see locking), `guessed_data` (OCR/ML provenance per field, see `ExpenseGuessedFromTypesEnum`), `recurrence`.
- Locked statuses: `taxLock.length>0` (document included in a VAT/tax submission) or `accountantReview.reviewStatus==="reviewed"`, or validated and `exportedInWorkspaces`/`references.exported_in_workspaces` non-empty (I:143041-143060). Locked expenses can only change `file`, `notes`, `payments.*` (use `patchLockedExpense`; enabled fields `taxLockEnabledFields` I:160469).

### 3.5 `GET /v3/expenses/:id/duplicates`
I:243404. Query: `perPage=10&page=1&lang&expand[]=taxLock` (qs default array format). Timeout 2 min. Response `{ expenses: Expense[], reasons: [{expense_id, reason}] }`; UI merges to `expense.duplicateReason`.

### 3.6 `GET /v3/expenses/:id/export-history`
I:243500. No params; response shape unverified (accountant exports of this doc).

### 3.7 `POST /v3/expenses` : create manual expense (no document)
I:243515 `addExpense(expenseForm, extraOptions)`.
Body: `{ expense: <ExpenseSubmit>, options: { update_tax_status: boolean, create_recurrence?: RecurrenceInput, ...extra } }`. Note `create_recurrence` and `shouldUpdateTaxStatus` are lifted out of the expense into `options` (the expense object submitted by `formatExpenseForSubmit` also carries them but `addExpense` destructures them away). Response `{ expense }`. UI analytics + FeatureCounts invalidation. Omit `file` (or `file:null`) for no document; a document can be attached with `file:{path,name}`.

### 3.8 `PUT /v3/expenses/:id` : save from the side panel ("Sauvegarder"; also marks validated)
I:243502 `updateExpenseById(id, {shouldUpdateTaxStatus, create_recurrence, ...expense}, extra)`; called from D6:8957.
Body: `{ expense: ExpenseSubmit, options: { update_tax_status: boolean, create_recurrence?: RecurrenceInput, ...extra } }` (`ExpenseSubmit` exactly as section 4.1). Response `{ expense }`. There is no `isValidated` in the body; server validates on save (section 0.C). Also timeout 60 s default.

### 3.9 `PATCH /v3/expenses/:id` : partial update
- `patchExpense(id, partial)` I:243584: body `{ expense: partial }`. Response `{ expense }`. Use for single-field edits (notes, category per item, flags).
- `patchLockedExpense(id, data)` I:243550 (used for locked expenses on Sauvegarder, D6:8957): body is `{ expense: { file: {name,path}|null, notes: string|null, accountantReview: undefined, payments: { cash:boolean, other_accounts:boolean, transactions: string[] (transaction ids), status: { type?: "paid"|"unpaid"|"pending", due_date?: "YYYY-MM-DD" } } } }`. For tax-locked expenses.

### 3.10 `DELETE /v3/expenses/:id` and `DELETE /v2/expenses/bulk?ids=a,b,c`
See section 0.D. I:243614 / CC:28-35. Response unverified. Destructive; cancel linked upcoming Swan scheduled payments first (`cancelOneTimeScheduledPayment`).

### 3.11 `POST /v3/expenses/bulk`
I:243622 `bulkUpdateExpensesV3(ids, changes)`: body `{ expenses_ids: string[], changes: object }`. Only verified use: bulk "mark as paid" = `changes: { payment_status_type: "paid" }` for the selected expenses whose `payments.status.type==='unpaid'` (BT:2956-2965). No bulk validate seen.

### 3.12 `POST /v3/expenses/tax-impact`
I:243539. Body `{ expense: ExpenseSubmit, options: { tax_impact_requested: true } }`. Response `{ data: ... }` -> returns `data` (deductible amount / VAT impact preview; `TaxImpactDocumentType`). Read-only preview.

### 3.13 `POST /v3/expenses/recurrences/:recurrenceId/pause`
I:243618. No body. (Id = `expense.recurrence._id`, D6:9247.) Recurrence creation: `create_recurrence` option on POST/PUT, body `{ frequency: "daily"|"weekly"|"monthly"|"quarterly"|"yearly", start_date: "YYYY-MM-DD", end_date: string|null, include_file: boolean, interval?: number }` (I:197560). Stored on expense as `recurrence` (`status`: `ongoing|paused|completed|failed`); only `ongoing` recurrences are kept in form.

### 3.14 `POST /v3/expenses/autoreview/acknowledge`
OnlyBeforeAuthRoute-BCInpor-.js:9678. Body `{ reason: "opened"|"dismissed", ids: string[] }` (max 500 ids per call). Acknowledges Autopilot auto-filed docs. List them with `GET /v3/expenses?autoreview_pending=true&sort=autofiledAt_desc&page&per_page` (response `expenses[]` with `autofiledAt`, `paging.total_pages/total_count`).

### 3.15 Additional `/v2/expenses` and `/v1/expenses` calls (CC:28-90, index-BOSSbTRo.js:20-40, index-nB-8JcPU.js:7141)
- `GET /v2/expenses/:id/tax-submissions` : tax submissions including the expense.
- `POST /v2/expenses/tax-lock` (ignoreToast) body `{expenseDate, period, user:{VATType, VATReturnFrequency}}` -> `{taxLock}`; checks whether the date/period is already locked by a filed VAT return.
- `GET /v2/expenses/drive-to-work/working-days/:year[?expenseId=]` -> `{days, amount}`.
- `GET /v2/expenses/guess/categories?filename=<key basename>&supplierName&transactions[]` -> category suggestions from the OCR'd file.
- `GET /v2/expenses/:id/ocr/bounding-boxes` -> `{entities:[{field_name,value,vertices}]}` for the viewer.
- `GET /v1/expenses/guessMerchantData?name=` -> supplier autocomplete list `[{name,...}]`.
- `GET /v1/expenses/categories/:country(be|de)?lang=` -> full category tree (see 3.16a); `GET /v1/expenses/categories/:id/...` single category (index-nB-8JcPU.js:7141, path order `/:x/:y` unverified).
- `GET /v1/calculations/expenses/deductible?year&endDate` -> deductible totals.
No endpoint found for: **split expense**, dedicated replace-attachment, dedicated validate.

### 3.16 `GET /v2/expenses/categories/search`
I:215491. Params `{ text, lang="en" }` (UI only calls when text length > 2). Response `{ data: [{ category_id, similarity }] }` (useCategoriesPicker-FuY7Ktr3.js:1095); map ids to the category tree.
### 3.17 `GET /v2/expenses/categories/predict`
I:215495. Params `{ text }` (supplier/description, > 2 chars). Response `{ data: { category: {id}, predictedSearchText, notDeductible } }` (D6:1678-1690).

### 3.16a `GET /v1/expenses/categories/<country>?lang=<lang>` : category tree
`<country>` = `be` or `de` (`AvailableCountries`, I:66830; user `country`). Response: nested list (`list` children) of groups/leaf categories with `id`, `title`/`displayName`, `icon`, `parent`, `maxDeductibleVAT`, `dnaPercentage`, `suggestedVATRate`, etc. (useExpensesCategories-Boh4RiyT.js). This is the way to enumerate valid category ids.

Category object fields seen in code: `id`, `type` (`"good"|"service"`, `ExpenseCategoryType`), `maxProfessionalPart` (0-1), `incomeTaxDeductibility` (0-1), `dnaPercentage`, `allowsVAT`, `maxDeductibleVAT` (0-1), `suggestedVATRate` (number|null), `suggestedAmortizationPeriod`, `minAmortizationAmount` (default 250), plus translated label/name.

---------------------------------------------------------------------------

## 4. Data model

### 4.1 `ExpenseSubmit` (what `formatExpenseForSubmit` sends, I:197560)
```ts
interface ExpenseSubmit {
  _id?: string;
  supplier: { name: string };               // only name is sent (object, not string)
  expenseDateNumber?: number;               // integer YYYYMMDD, built from form `expenseDate` ("YYYY-MM-DD", regex I:111435) via `+dayjs(d).format("YYYYMMDD")`; `expenseDate` itself is sent undefined
  currency: string;                         // ISO, default "EUR"
  currencyRate: number | null;              // 1 if EUR; foreign: rate (base per unit? unverified direction)
  items: ExpenseItem[];
  isInvoice: boolean;                       // "facture en bonne et due forme" (proper invoice w/ VAT number). Form default: existing value, else true for DE / false BE
  isCreditNote: boolean;                    // form forces false; read value can be true (amount sign then flipped in form: negative amounts)
  isFake: boolean;
  isValidated?: boolean;                    // undefined in formatted submit
  notes: string | null;
  period: {year;quarter?;month?} | null;    // VAT period; joi: year int <= currentYear+1; quarter 1-4 required if user.VATReturnFrequency=quarterly; month 1-12 required if monthly (D6:8736-8760)
  taxPeriod: object | null;                 // income-tax/other period (same shape)
  file: { path: string; name: string; hash?: undefined } | null;
  payments: {
    cash: boolean; other_accounts: boolean;      // "rest paid in cash / from other accounts"
    transactions: string[];                      // linked bank transaction _ids (form holds objects; wire = `_id` strings, I:197560)
    suggested_method?: "credit_transfer"|"direct_debit"|"card"|"online_payment_service"|"cash"|"cheque"|"standing_agreement";
    status: { type?: "paid"|"unpaid"|"pending"; payment_date?: "YYYY-MM-DD"; due_date?: "YYYY-MM-DD" };
  };
  user?: { VATType; VATReturnFrequency; country };   // snapshot, form-only, sent through `pick`
  accountantReview?: object;                         // undefined on submit
  shouldUpdateTaxStatus?: boolean;                   // -> options.update_tax_status
  create_recurrence?: {frequency; start_date; end_date|null; include_file; interval?};
}
interface ExpenseItem {
  _id: string | null;
  currencyAmount: number;                    // gross (incl. VAT), signed, in expense currency (rounded to cents). Negative total = credit note (form shows credit notes negative; `isCreditNote` is forced false in the payload, D6 getDefaultValues I:197160)
  VATRate: number | null;                    // FRACTION, not percent: 0.21, 0.06, 0.12, 0 (BE `vat_rates:[0,0.06,0.12,0.21]` I:160394; DE `[0,0.07,0.19]` I:199439). null when VATRegime is foreign-vat (joi: must be null) or not applicable
  localVATRate?: number | null;
  VATRegime?: ExpenseVATRegime;              // required (joi) when applicable; strings below
  category: Category;                        // the whole category OBJECT as held by the form (joi `D.object().required()`, D6:8563); formatExpenseForSubmit picks it unchanged. Minimum a server will accept is unknown; send `{id, ...}` from the tree (verify)
  professionalPart: number;                  // FRACTION 0.01..1 (joi min .01 max 1; UI shows *100 %); default 1
  incomeTaxDeductibility?: number;           // 0..1 copy from category
  maxDeductibleVAT?: number;                 // 0..1
  isAsset?: boolean; amortizationPeriod?: number | null;   // years; amortisation if amount >= category.minAmortizationAmount (default 250)
  name: string | null;                       // line description
  vehicle?: string;                          // vehicle id (BE vehicle categories need it)
  tripType?: "BUSINESS_TRIP"|"DRIVE_TO_WORK"; tripVehicleType?: "CAR"|"MOTORBIKE"; tripTotalKm?: number; tripWorkingDays?: number;
  deduction?: ...;                           // read-only (computed)
}
```
Read-only extras on `Expense` (seen): `expenseDateNumber`, `VATAmount`/`baseCurrencyAmount` on items, `sufficientlyDocumented`, `guessed_data`, `taxLock[]`, `accountantReview {reviewStatus:"reviewed"|"not_reviewed", comments}`, `references.exported_in_workspaces`, `autofiledAt`, `createdFrom` (`web|dropzone|email|experts|unknown|mobile|peppol`), `recurrence`, `_matchedTransactions` (UI-only).

Form field names (`ExpenseFormNames`, I:160063): `supplier.name, expenseDate, notes, items, currency, currencyRate, taxPeriod, period, payments, user.VATType, payments.transactions, payments.status.type, payments.status.payment_date, payments.status.due_date, payments.cash, payments.other_accounts, accountantReview.comments, accountantReview.reviewStatus, isInvoice, isCreditNote, isValidated, file.path, create_recurrence, recurrence`.

### 4.2 `ExpenseVATRegime` (item `VATRegime`, I:160114) - the "vat-exemption / reverse-charge reason"
| value | meaning |
|---|---|
| `standard` | normal VAT (rate > 0) |
| `foreign-vat` | foreign VAT charged by supplier (`localVATRate`) |
| `exempt-item` | exempt/no VAT (rate 0) |
| `eu-reverse-charge` | intra-EU autoliquidation (services/goods from EU supplier) |
| `extra-eu-supplier` | non-EU supplier (reverse charge on services; goods = import) |
| `franchisee-supplier` | supplier under VAT franchise (small business) |
| `local-reverse-charge` | domestic autoliquidation (cocontractant, BE) |
Allowed/disallowed combos depend on `isInvoice` and category type good/service (`getVATRegimesStatus`, I:197739-197860): e.g. `extra-eu-supplier` only for proper invoices & service categories; not-an-invoice receipts only `exempt-item`/`franchisee-supplier`; hidden for some categories. `user.VATType`: `exempt|franchisee|subjectToVAT|exonerated`; `VATReturnFrequency`: `monthly|quarterly|yearly`.
Related OCR evidence reasons (`ExpenseEvidenceReasonEnum`): `extra_eu_supplier_vat_number, intra_eu_supplier_vat_number, local_supplier_vat_number, local_supplier_steuernummer, local_supplier_tax_number, *_supplier_address, local_vat_rate, non_local_vat_rate, zero_vat_found, reverse_charge_note, small_business_exemption_note, extra_eu_currency, intra_eu_currency, other_item_with_foreign_vat_rate, other_item_with_standard_vat_rate`. (`WhyZeroVATEnum` at I:142555 is the revenue-side equivalent: `user-franchisee, local-reverse-charge, intra-eu-reverse-charge, extra-eu-export, exempt-item, diplomatic`.)

### 4.3 VAT rates
Rates are fractions. Default (`getDefaultVATRate`, I:197271): BE -> category `suggestedVATRate` else 0.21; DE -> suggested else 0.19 (Q4-2020 special: 0.16/0.05). Typical BE values 0, 0.06, 0.12, 0.21; DE 0, 0.07, 0.19. Whether the server restricts values is unknown.

### 4.4 Categories (ids are strings)
Use `GET /v2/expenses/categories/search?text=` to resolve (full list is server-side). Known ids from constants (I:160132-160250):
- BE accounting-code style: `610000c` rent, `610100b` water/electricity/heating, `612201`/`612202` maintenance & decoration (goods/services), `612150e` IT services, `618020` social contributions, `618000` director compensation, `618050/618060` lunch vouchers (admin/vouchers), `623000` other personnel, `620500` worker comp, `659000` interest & bank charges, `640500` import fees, `640501` import VAT, `613310a` flights, `613350b` local public transport, car: `613430b` parking, `613410` maintenance, `613420` fuel, `613420b` electricity, `613530` insurance, `613400` leasing/rental, `640000` road/registration taxes, `6450a` fines, `613455` operational leasing, `252010` financial leasing contract, `613000` financial leasing monthly invoice, `613425` car parts, `241000` investment: car; moto `6450b/613001`; bike `613002`, ebike `613003`; utility `613432b,613412,613422,613422b,613532,613402,613459,252014,613004,613415,640002,6450c`.
- Other known BE ids in AllYouCanDeduct link map (I:67071-67264): `615100` restaurant, `615200` canteen, `612400` workspace, `613200a/b/c` accounting/legal fees, `612150b/c` software subscriptions, `612100/612120` phone, `615500` professional contributions, `613540` professional insurance, `618030` pension plan, `603000` subcontracting, `602000` studies/works/services, `612000` tools, `600000` raw materials, `604000` goods for resale, `610000a/b` rent, `612200a-f` decorative items, `613600a/b` training, `615300a/b` business gifts, `615400` advertising goods, `613330` per diems, `613340` taxi, `613320` hotels, `220000..241220` fixed assets.
- DE dotted slugs: `de.travel.for_employee.flights`, `de.travel.for_self_employed.flights`, `de.travel.for_self_employed.car_private_use`, `de.technology.hardware`, `de.technology.software_subscription`, `de.workplace.decoration|renovation|rent.inside_main|rent.inside_secondary|rent.homelumpsum|maintenance.outside|maintenance.inside_main|maintenance.inside_secondary`, `de.taxes_and_insurance.vat_payment`, `de.revenue.vat_reimbursement`, `de.taxes_and_insurance.for_self_employed.private_insurances|import_vat|import_fees`, `de.compensation.health_insurance`, `de.interest_and_bank_charges.bank_charges`, `de.vehicle.business_car.fuel|parking|other|repair|leasing|insurance|taxes|road_and_registration_taxes|purchase|purchase.other`. Revenue slugs `de.revenue.private_usage_business_car`, `be.revenue.sales_goods`, `de.revenue.sales_goods`.
Locale chunks (`fr-*.js`, `en-*.js`, small ones) contain no expense category/VAT label data (grep for regime/reverse found nothing); full category taxonomy is only available from the API.

### 4.5 Misc enums
- `ExpensePaymentStatusType`: `paid, unpaid, pending`. Default status in form = `paid`. Paid with linked bank transactions normally sets `payments.transactions`.
- `ExpenseRecurrenceFrequency`: `daily, weekly, monthly, quarterly, yearly`; `ExpenseRecurrenceStatus`: `ongoing, paused, completed, failed`.
- `ReviewStatusEnum`: `reviewed`, `not_reviewed` (accountant review).
- Tax check codes (`TaxCheckEnum`, I:142711): e.g. `expense.vat-claimed-above-21`, `expense.reverse-charge`, `expense.missing-document`, `expense.not-reviewed`, `expense.duplicate`, `expense.invoice-without-vat-number`, `expense.ticket-with-vat-number`, `expense.above-1000-eur`, `expense.personal-supplier`, `expense.restaurant-personal`, `expense.mismatch-vat-rate-with-category`, `expense.payment-mismatch-with-document` ...
- Upload `category` enum: see section 1.
- Auto-schedule payment helpers (`DUE_DATE_BUFFER_DAYS=3`, `MAX_SCHEDULE_MONTHS_AHEAD`): when `payments.status.due_date` or total changes on an expense with upcoming Swan transfers, UI re-creates the scheduled payment (`changesScheduledPaymentTerms` I:243381).

### 4.6 Linking a transaction to an expense
Set `expense.payments.transactions = [<transaction _id>...]` (and optionally `cash`/`other_accounts` for the remainder, `status.type:"paid"`) through PUT/PATCH; reading with `expand=payments.transactions` returns the full transactions. `formatExpenseFromTransaction` (I:198346) shows creating a new expense *from* a bank transaction: `POST /v3/expenses` with `supplier.name = counterPartyName`, one item `{currencyAmount: |sum|, VATRate default, category, professionalPart:1}`, `currency`/`currencyRate` from transaction, `payments:{transactions:[ids],cash:false,other_accounts:false}`, `period`, `taxPeriod`, `isValidated:true`, `isInvoice`.

---------------------------------------------------------------------------

## 5. Proposed MCP tools

| Tool | Description | Input | Mode |
|---|---|---|---|
| `accountable_list_expenses` | List/filter expenses | `page, per_page, search, categories[], is_validated, is_invoice, is_credit_note, sufficiently_documented, vat_period[] (q-3-2026), tax_period[], date_range, sort` | read-only |
| `accountable_get_expense` | Get one expense with payments/taxLock/guessed_data/recurrence | `id` | read-only |
| `accountable_get_expense_duplicates` | Possible duplicates of an expense | `id` | read-only |
| `accountable_search_expense_categories` | Search category ids by text | `text, lang` | read-only |
| `accountable_predict_expense_category` | Predict category from supplier/description | `text` | read-only |
| `accountable_get_expense_filters` | Available list filters | none | read-only |
| `accountable_preview_expense_tax_impact` | Tax impact of an expense payload | `expense` | read-only |
| `accountable_list_pending_autoreview_expenses` | Autopilot-filed docs awaiting review | `page, per_page` | read-only |
| `accountable_upload_document` | Local file -> presigned S3 upload (steps 1-2), returns `key` | `file_path, category?` | write (creates stored object) |
| `accountable_create_expense_from_file` | Upload + `POST /from-file` (OCR) in one go; also accept an existing `key` | `file_path` or `key`, `is_fake?` | write |
| `accountable_create_expense` | Manual expense without document (optionally with uploaded key) | `supplier_name, expense_date, currency, items[{amount, vat_rate, vat_regime, category_id, professional_part, name}], is_invoice, notes, period, payments{...}, file_key?` | write |
| `accountable_update_expense` | PATCH selected fields (notes, items, category, vat, payment status, due date, file) | `id, patch` | write |
| `accountable_attach_document_to_expense` | Upload and set `file` on an expense (replace/attach) | `id, file_path` | write |
| `accountable_validate_expense` | Mark reviewed: re-PUT the expense (read, rebuild ExpenseSubmit, PUT; server validates on save) | `id` | write |
| `accountable_link_transactions_to_expense` | Set `payments.transactions` (+ status paid) | `id, transaction_ids[], cash?, other_accounts?` | write |
| `accountable_set_expense_payment_status` | paid/unpaid/pending, payment date, due date | `id, type, payment_date?, due_date?` | write |
| `accountable_bulk_update_expenses` | Bulk changes | `ids[], changes` | write |
| `accountable_pause_expense_recurrence` | Pause recurring expense | `recurrence_id` | write |
| `accountable_delete_expense` | Delete expense (cancels scheduled Swan payments first) | `id` | destructive |
| `accountable_bulk_delete_expenses` | `DELETE /v2/expenses/bulk?ids=` | `ids[]` | destructive |
| `accountable_get_expense_category_tree` | `GET /v1/expenses/categories/<country>` | `country, lang` | read-only |

---------------------------------------------------------------------------

## 6. What could not be determined (remaining)
- Exact server acceptance of a minimal `category` (`{id}` only vs full object) and of omitted optional fields; the UI always sends the full form object.
- Quarter/month value format for `vat_period` on expenses: take it from `GET /v3/expenses/filters` options (best guess `q_3_2026` / `m_3_2026`, by analogy with revenues; yearly `2026` confirmed live). `date_range` format likely `YYYY-MM-DD/YYYY-MM-DD`.
- Whether PUT really validates server-side (strongly implied: no other client call sets `isValidated`), and whether `PATCH {expense:{isValidated:true}}` is accepted.
- Split expense: no endpoint exists in the bundle.
- Response shapes of DELETE, `/export-history`, `/tax-impact`, `/v2/users/file-url`; S3 host/key prefix (server-provided); server-side file size limit; whether list responses contain `origin`.
- Currency rate direction (`currencyRate`: UI computes `baseAmount/amount`, I:198430 `Ue/Ve`, i.e. base per foreign unit... inferred).
