# Revenues / invoicing API (static analysis)

Area: sales invoices, credit notes, other revenues, quotes, clients, document templates, recurring invoices, PEPPOL integration.
Base URL `https://app.accountable.eu/api`; Bearer auth; the axios response interceptor unwraps `response.data`, so all response shapes below are the JSON body.

Files: `IDX` = `research/bundle/index-DbupgLzd.js`, `OBA` = `research/bundle/OnlyBeforeAuthRoute-BCInpor-.js`.

**Important limitation:** the invoice/quote form chunks (`Form-*.js`), the revenues list page and `useRevenuesFilters-*.js` are lazy chunks NOT present in `research/bundle/`. The API wrapper functions (URLs, methods, simple params) are fully visible, but the exact set of list filters and the exact email/send/status bodies are partly inferred (marked **(unverified)**).

## 0. Conventions

### Fixed-point numbers (very important)
All money/quantity/percent fields on revenue items are integers scaled by 1000 (`multiplyBy1000`/`divideBy1000`, IDX:118810-118813; `getInvoiceItemInclVAT`, IDX:163360-163380):
- `quantity`: 1000 = 1 unit.
- `unitAmountExclVAT` / `unitAmountInclVAT`: euros x 1000 (12.50 EUR = 12500).
- `VATRate`: x1000 as a fraction, i.e. 21% -> `210`, 6% -> `60`, 12% -> `120`, 0 -> `0` (the UI default rates are `[0, 0.06, 0.12, 0.21]`, IDX:162207; `formatInvoiceFromTransaction` does `VATRate * 1000` on a 0.21 fraction, IDX:198490). **(the 210 scale is inferred from `(VATRate/1e3)` being applied as a fraction in `getInvoiceItemInclVAT`: `unit + unit * (VATRate/1e3)`.)**
- `discountPercentage`: x1000 fraction: `disc = discountPercentage/1e3` is multiplied directly (1000 = 100%, 100 = 10%).
- Totals returned by the API (`totalAmountInclVAT`, etc.) are also x1000 (`E9(...)` conversion in OBA:9720; `divideBy1000(r.totalAmountInclVAT)` in IDX:165900).
- Dates: `YYYY-MM-DD` strings. `expenseDateNumber`-style `YYYYMMDD` ints exist only on expenses.

### Enums (IDX:142563-142640, 159921-159930, 162084-162126)
- `type` (InvoiceTypeEnum): `invoice` | `other-revenue` | `credit-note` | `quote`.
- `status` invoices (InvoiceStatusEnum): `sent` | `not-sent` | `paid` | `draft`.
- quote status (QuoteStatusEnum): `sent` | `not-sent` | `approved` | `rejected`.
- `fileType`: `generated` (made in Accountable) | `imported` (uploaded PDF/OCR).
- `whyZeroVAT`: `user-franchisee` | `local-reverse-charge` | `intra-eu-reverse-charge` | `extra-eu-export` | `exempt-item` | `diplomatic`.
- item `unit` defaults: `items` | `hours` | `days` | `km` (custom units allowed, see `/custom-units`).
- client `type`: `business` | `private` | `diplomatic`; client `location`: `local` | `intra-eu` | `extra-eu`; client VAT status: `subjectToVAT` | `franchisee` | `exempt`.
- Revenue item `category` ids (RevenueItemCategory): `be.revenue.sales_goods`, `be.revenue.sales_services`, `de.revenue.sales_services`, `de.revenue.sales_goods`, `be.revenue.copyright`, `be.revenue.passerelleCrise`, `be.revenue.passerelleRelance`, `be.revenue.subsidyNotTaxable`, `be.revenue.insurancePayoutForLostAsset`, `be.revenue.indemnity165`, `de.revenue.corona_grants|commission|royalties_licensing|rent|gifts|interest_income|refunds`.
- Download types (`downloadTypeEnum`): `pdf`, `zugferd`, `ubl21`, `ubl31`, `ublBe`. BE: pdf/ubl21/ublBe (IDX:162241); DE: pdf/ubl31/zugferd (IDX:201038).
- Invoice log slugs: `created`, `email-sent`, `reminder-sent`, `email-opened`, `reminder-opened`, `email-received`, `reminder-received`, `email-bounced`, `reminder-bounced`, `peppol-sent`, `peppol-failed`, `peppol-processed`, `selfbill-accepted`, `selfbill-rejected` (IDX:142617-142632).
- Installment types (project invoicing): `advance` | `progress` | `final`; amount shown as `percentage` | `value`.

### Query string serialization
List endpoints use `qs.stringify(params, {skipEmptyString:true, arrayFormat:"comma"})` - arrays are comma-joined (`ids=a,b,c`).

### Item shape (InvoiceItem; keys from `C$` map, OBA:29412-29430, and `formatInvoiceFromTransaction`, IDX:198470)
```ts
interface RevenueItem {
  _id?: string;
  name: string;                    // line title
  description?: string;
  quantity: number | null;         // x1000
  unit: string;                    // "items" default (gZ coerces falsy -> "items")
  unitAmountExclVAT: number|null;  // x1000
  unitAmountInclVAT: number|null;  // x1000
  doesUnitPriceIncludeVAT: boolean;// which of the two unit amounts is authoritative
  discountPercentage: number|null; // x1000 fraction
  VATRate?: number;                // x1000 fraction (210 = 21%)
  whyZeroVAT?: WhyZeroVAT|null;    // set when VATRate==0; client location extra-eu forces "extra-eu-export", intra-eu forces "intra-eu-reverse-charge" (OBA:29345)
  categoryId?: string; category?: object;
  assetId?: string;
  _priceItemId?: string; _priceItem?: object; // link to saved price-list item (UI only?)
}
```

## 1. Revenues (`/v2/revenues`, `IDX:165956`)

All paths relative to `/api`. "Revenue" = invoice / credit note / other-revenue (type field). Quotes use `/v2/quotes`.

### GET /v2/revenues - list
`getRevenues(params)` IDX:166155. Called with the qs serialization above.
Known params:
- `page`, `perPage` (seen: `getAutoreviewPendingRevenues`, IDX:166311, OBA:9745 with perPage 100)
- `sort`: `<field>_<asc|desc>`, default `invoiceDate_desc` (IDX:162218); `autofiledAt_desc` is used for autoreview.
- `autoreviewPending=true` (documents auto-filed by autopilot awaiting review)
- Other filters are built in the missing `useRevenuesFilters` chunk **(unverified)**. Probable: `isValidated` (list groups invoices by `isValidated`, IDX:162175), `status`, `type`, `clientId`, `text`/search, date range, `period`. Use `GET /v2/revenues/filters` to discover (see below).
Response (confirmed from `R$`/`m9` usage and list code): `{ data: Revenue[], paging: { page, perPage, pageCount, pagesCount?, totalCount } }`. Autoreview consumer reads `r.data`, `paging.pageCount`, `paging.totalCount` (OBA:9745-9758).
Revenue fields read in list/autoreview: `_id`, `client.name`, `invoiceDate`, `totalAmountInclVAT`, `currency`, `autofiledAt`, `status`, `type`, `revenueNumber`.

### GET /v2/revenues/filters
`getRevenuesFilters` IDX:166152. Returns filter option metadata (cache key `Revenues:Filters`). Shape **(unverified)**.

### GET /v2/revenues/:id
`getRevenueById(id, isQuote)` IDX:165977. Query: `expand=transactions,taxLock`. Post-processed: `transactions` (expanded objects) -> array of ids, original objects kept as `_matchedTransactions`; if `revenueProject.snapshot.projectId` exists, `GET /v3/revenues/projects/:projectId` is also fetched.
Response fields observed in UI code: `_id`, `type`, `status`, `fileType`, `revenueNumber`, `invoiceDate`, `dueDate`, `paymentDate`, `period`, `taxPeriod`, `currency`, `currencyRate`, `items[]`, `client` (embedded), `clientId`, `communication`, `transactions[]`, `notes`, `paymentType`, `downPayment`(x1000), `filePath`/`files[{path}]`, `isValidated`, `settings{useCommunication, usePaymentQrCode, includeCopyrightReminder}`, `user{IBAN, accountHolderName, companyName, firstName, lastName}`, `template_entry_id`, `template_content_id`, `revenueProject{snapshot{items,revenues,projectId}, installmentAmountShownAs, installmentValue, installmentPercentage}`, `itemsCalculations`, `totalAmountInclVAT`, `taxLock`.

### POST /v2/revenues - create
`createRevenue(body)` IDX:166007; `createGeneratedRevenue` first calls `GET /v2/revenues/communication` to fill `communication` if `settings.useCommunication` and the user has IBAN. Body (generated invoice; inferred from form default value builders IDX:198470-198540 and `getBaseInvoiceData`):
```ts
interface CreateRevenueBody {
  type: "invoice"|"credit-note"|"other-revenue";
  fileType: "generated"|"imported";
  status: "draft"|"not-sent"|"sent"|"paid";   // default "sent" in getBaseInvoiceData
  revenueNumber?: string;                      // see next-number
  invoiceDate: string;                         // YYYY-MM-DD
  dueDate?: string;                            // default invoiceDate + 30 days (due_date_days_after_invoice_date: 30)
  paymentDate?: string;                        // when status paid
  currency: string;                            // "EUR" default
  currencyRate?: number;
  items: RevenueItem[];
  clientId?: string;                           // existing client
  client?: { name; location; type; VATNumber; address{street,city,zip,country}; email; ... }  // embedded snapshot **(fields unverified)**
  transactions?: string[];                     // bank transaction ids to link
  notes?: string;
  paymentType?: string|null;
  period?: object; taxPeriod?: object;        // VAT period (getPeriodFromDate)
  communication?: string;                      // structured communication (BE +++)
  downPayment?: number;                        // x1000
  settings?: { useCommunication, usePaymentQrCode, includeCopyrightReminder, ... };
  template_entry_id?: string; template_content_id?: string;  // document-template pair; both or neither
  filePath?: string; files?: {path}[];         // for imported
  revenueProject?: {...};                      // project/installment invoicing
}
```
Response: the created revenue (`_id` etc.). The UI wraps with GTM event only.
Imported-file flow: upload file -> `{key}`; `GET /v2/revenues/ocr?filename=<basename of key>&type=<type>` (timeout 5 min) returns prefilled fields; then POST with `filePath`, `files:[{path:key}]`, `fileType:"imported"` (IDX:198544; adaptRevenueOCRResult sets due date = invoiceDate+1d when missing and takes `paymentDate`/`status` from the first matched transaction: valueDate -> `paid`, else `sent`).

### Linking a bank transaction when creating (IDX:198470-198500)
`formatInvoiceFromTransaction`: creates a revenue from a transaction with `status:"paid"`, `invoiceDate=dueDate=paymentDate=<transaction date>`, `transactions:[txId]`, one item `{unitAmountInclVAT: abs(amount)*1000, quantity:1000, unit:"items", doesUnitPriceIncludeVAT:true, name: counterPartyName, VATRate?}`, `fileType:"generated"`; for `other-revenue` the client is `{location:"local", name}`.
Linking is done by the `transactions: string[]` array on the revenue (create/PUT/PATCH-locked). Reverse direction (transactions have `matchedItems[{type:"invoice", documentId, isCreditNote}]`; bulk updates key `revenueId` vs `expenseId`, IDX:198590) belongs to the transactions area.

### PUT /v2/revenues/:id - update (full)
`updateRevenue` IDX:166010 (`updateGeneratedRevenue` also fills communication). Same body as create. Not allowed on tax-locked docs -> use `/locked`.

### PATCH /v2/revenues/:id
`patchRevenue` IDX:166027; partial update; returns `response.data` of the (already unwrapped) body, i.e. expects `{data: revenue}`. Body fields **(unverified)**.

### PUT /v2/revenues/:id/status - mark sent/paid
`updateInvoiceStatus({id, params})` IDX:166165. Body is `{status, period?}` (verified, see section 10.4). UI helper `getStatusDisabledOptions` disables `not-sent` for some docs.

### PATCH /v2/revenues/:id/locked
Update of a tax-locked (VAT-submitted) invoice. `patchLockedInvoice` body: `{transactions, notes|null, paymentType|null, status}` (IDX:166275); `patchLockedInvoiceStatus` body `{status}` (IDX:166283). Only these fields are editable once locked.

### DELETE /v2/revenues/:id (query params passthrough, unknown) and DELETE /v2/revenues/bulk?ids=a,b (comma)
IDX:166093-166099. Destructive.

### GET /v2/revenues/:id/generate-invoice - render / download file
`generateRevenue(id, params)` IDX:166240. Params are probably the download type (`downloadTypeEnum`: pdf, ubl21, ublBe, ubl31, zugferd) **(unverified; param name unknown, likely `type`)**. Response likely `{url}` or a file path to be resolved with `GET /v2/users/file-url?filePath=` (IDX:165958, 213533) **(unverified)**. For imported invoices the original file is at `filePath`/`files[].path` -> `GET /v2/users/file-url?filePath=<path>` returns a signed URL.

### POST /v2/revenues/preview-invoice
`getInvoicePreview(body)` IDX:166309. Body = the invoice form values (same as create); returns a preview (HTML/PDF URL) **(unverified)**.

### POST /v2/revenues/:id/email - send invoice email (legacy)
`sendRevenueEmail(id, body)` IDX:166245. Body = EmailData (see section 10.5).

### POST /v2/revenues/:id/send - send via email and/or PEPPOL
`sendInvoiceEmailAndPeppol(id, ops)` IDX:166304 -> body `{ ops }`. `BulkEmailsMethods = { PEPPOL: "PEPPOL", EMAIL: "EMAIL" }` (IDX:166299). `ops` = array of `{method:"PEPPOL"|"EMAIL", data?}` (verified, see section 10). Result recorded in logs as `email-sent`, `peppol-sent`, `peppol-failed`, `peppol-processed`.

### POST /v2/revenues/:id/reminders - send payment reminder email
`sendReminderEmail(id, body)` IDX:166287. Body **(unverified)**.

### GET /v2/revenues/:id/logs?page=N
IDX:166289. Email/peppol/reminder event log (slugs above).

### GET /v2/revenues/:id/tax-submissions, GET /v2/revenues/:id/duplicates
Tax submission history (IDX:166209); duplicates with `expand=taxLock&perPage=10&page=1`, timeout 2 min, response `{duplicates[], types[{revenueId,type}]}` (IDX:166213-166230).

### GET /v2/revenues/next-number?type=<type>&invoiceDate=<YYYY-MM-DD>
Invoice numbering. Response `{nextRevenueNumber}` (quotes: `/v2/quotes/next-number?type=quote&quoteDate=`, response `{nextQuoteNumber}`). IDX:166168-166186.
### GET /v2/revenues/number-exists?type=<type>&revenueNumber=<n>
Response `{exists: boolean}` (quotes use `quoteNumber`). IDX:166187-166200.
### GET /v2/revenues/communication?clientId=&revenueNumber=
Response `{communication}` - Belgian structured communication. IDX:166074.
### GET /v2/revenues/payment-qr-code?...
Params (from `getQRCodeDependencies`): IBAN, currency, amount, name, communication, usePaymentQrCode. IDX:166084. Response shape **(unverified)**.
### POST /v2/revenues/calculated-data
Server-side totals. Body `{type, items, clientId?, invoiceDate, options:{currency}}`; response `{calculations:{items[], totalAmountInclVAT, totalAmountExclVAT, totalVATAmount, totalVATAmount_<rate>, baseCurrencyTotalAmountInclVAT, currencyRate}, copyRight:{copyrightRevenueAmountExclTax, copyrightRevenueTaxAmount}, currencyRate, legalNotes}` (IDX:166033-166060, 111557). Useful to compute totals without a client-side tax engine.
### GET /v2/revenues/currencies -> `{currencies}`; GET /v2/revenues/exchange-rates?documentDate= -> `{exchangeRates}`
IDX:166101-166115.
### POST /v2/revenues/tax-impact (params `taxImpactRequested=true`), POST /v2/revenues/tax-lock
Tax impact / lock status; `tax-lock` body = invoice fields + `taxDate`. IDX:166204, 166262.
### GET /v2/revenues/categories, GET /v2/revenues/categories/:a/:b, POST /v2/revenues/custom-type-data
Revenue categories and custom form data. IDX:166201, 166296, 166293.
### Price list items: `/v2/revenues/document-item` (GET list `page,perPage=100,sort=name_asc`, response `{items, paging}`; GET/PUT/DELETE `/:id`; POST; DELETE `/bulk?ids=`), `/v2/revenues/suggested-items?perPage=1` (-> `customUnits`), `DELETE /v2/revenues/custom-units/:unit`. IDX:166117-166150.

## 2. Revenue projects & export history (`/v3/revenues`, `IDX:165831`)
- `GET /v3/revenues/:id/export-history` (IDX:165833)
- `POST /v3/revenues/projects/calculations/next-items` (IDX:165836) - body/response unknown
- `GET /v3/revenues/projects/:projectId` - response `{revenues[{revenueId,totalAmountInclVAT,...}], ...}`, UI filters `revenues` with `revenueId` (IDX:165847).
- `POST /v3/revenues/autoreview/acknowledge` (OBA:9679) - body unknown, `ignoreToast`; acknowledge an autopilot-filed revenue (also `/v3/expenses/autoreview/acknowledge`).
- `POST /v2/exports/revenues?<qs>` (exportCompletionToast-BE4vsoEV.js:40) - accounting export job; poll `GET /v2/exports/:id`.

## 3. Recurring invoices (`v2/revenues/recurrings`, OBA:29700)
Note path has no leading slash in source (axios joins with base).
- `GET /v2/revenues/recurrings` -> `{data[]}` (UI synthesizes paging, no real pagination)
- `GET /:id` -> `{data}`; `POST` create; `PUT /:id`; `DELETE /:id`; `POST /:id/pause`; `POST /:id/resume`.
Body: `{ revenueId?, revenueData: <invoice body incl. items, clientId, currency, template ids>, every:number, unit:"week"|"month", dayToken:"first"|"last"|<dayNumber>, dayNumber, startDate, endDate|null, shouldSendEmail:boolean, shouldSendViaPeppol:boolean, emailOptions }`. `pauseReason` on response (`manual-pause` or system reasons). Field names from `OZ()` (OBA:29776-29785).

## 4. Quotes (`/v2/quotes`, IDX:165957)
- `GET /v2/quotes/:id?expand=transactions` (IDX:165960)
- `POST /v2/quotes` create (IDX:166021) - body like revenue with `type:"quote"`, `quoteDate`, `quoteNumber`, `status` (QuoteStatusEnum), `items`, `clientId`/`client`, template ids, expiry **(unverified)**.
- `PUT /v2/quotes/:id` (IDX:166024).
- `GET /v2/quotes/next-number?type=quote&quoteDate=` -> `{nextQuoteNumber}`; `GET /v2/quotes/number-exists?type=quote&quoteNumber=` -> `{exists}`.
- Quote list: probably `GET /v2/quotes` with `page/perPage/sort` **(unverified; not in visible code)**; `getRevenueById(id, true)` switches to quotes. Quote-to-invoice conversion happens client side (open invoice form with quote data, `_templateSourceId`).

## 5. Credit notes
No separate endpoint: `type:"credit-note"` on `/v2/revenues` (IDX:142566, 162084). The UI opens the new-invoice form with `type=credit-note` (OBA:29618). `isCreditNote` flag appears on matched items. Import of an existing credit note is `import_credit_note` action. Amounts presumably positive with the type deciding sign **(unverified)**.

## 6. Clients (`/v2/clients`, OBA:29432)
- `GET /v2/clients?<qs>` - params `page`, `perPage`, `sort` (default `clientName_asc`, IDX:159952), `text` (search) **(unverified)**; response `{data: Client[], paging}` (paging as above).
- `GET /v2/clients` (no params) -> `{data}` mapped to options `{label:name, value:_id}`.
- `GET /v2/clients/:id` (404 handled as "client deleted"); `POST /v2/clients`; `PUT /v2/clients/:id`; `DELETE /v2/clients/:id`; `DELETE /v2/clients/bulk?ids=a,b`.
- `GET /v2/clients-temp?page=1&perPage=25&...` - **(unverified)** temp/suggested clients (e.g. from transactions/PEPPOL).
- `GET /v2/clients/:id/peppol-exists?documentTypes[]=<type>` -> `{exists, data:{isReceivingOptionEnabled, identifierType, isValidIdentifier, isRegisteredOnNetwork, routing, source}, routings}`: check if client can receive e-invoices (OBA:29467).
Client fields seen: `_id`, `name`, `type` (business/private/diplomatic), `location` (local/intra-eu/extra-eu), `VATNumber`, `address{street,city,zip,country}`, `email`, `VATStatus`. Required for invoice creation (BE): companyName, VATNumber, address.street/city/zip, IBAN (these are the *user's* fields, IDX:162153).
Peppol client list filter `peppolStatus` values: `all|active|active_send_only|inactive|unregistered|verification_required|pending|registered_elsewhere|unknown` (OBA:5405-5420).

## 7. Document templates (`/v3/document-templates`, OBA:29479)
Layout templates for invoices/quotes, referenced from a revenue by the pair `template_entry_id` (preset id) + `template_content_id` (content).
- `GET /v3/document-templates?document_type=&is_default=&per_page=&page=` -> `{templates[]}` (entry: `_id`, `name`, `document_type`, `is_default`, `content_id`, `style_settings`, `details_settings`, `deleted_at`).
- `GET /v3/document-templates/:id` -> `{template}`; `POST /v3/document-templates` create (body `{name<=100, document_type, blocks, style_settings, details_settings}`, OBA:29312); `PUT /:id` -> `{template}`; `DELETE /:id`.
- `POST /v3/document-templates/:id/default` body `{document_type}`.
- `GET /v3/document-templates/contents/:contentId` -> `{content}` ; `POST /v3/document-templates/contents` -> `{content}` (blocks).
- `POST /v3/document-templates/from-legacy` body `{document_type, revenue_id? | quote_id?}` -> `{template, document_content_id}` - migrate legacy invoice layout.
`document_type` for invoices vs quotes is derived by `P1(type)` (mapping unverified). For MCP, templates can be ignored: creating an invoice by sending `template_entry_id`/`template_content_id` of the default template (`GET ...?document_type=invoice&is_default=true&per_page=1`) mirrors the UI (OBA:29497).

## 8. PEPPOL (`/v2/integrations/peppol`, IDX:235684)
- `GET /v2/integrations/peppol` -> `{integration}`; 404 = not registered. `documentExchangeType` defaults `send_and_receive`. Status enum: `available|active|inactive|waiting_callback|pending|verification_required`.
- `POST /v2/integrations/peppol` body unknown (scheme enum `IBAN`, `BE:VAT`, `DE:VAT` = PeppolIntegrationScheme, IDX:235601) -> `{integration}`.
- `PATCH /v2/integrations/peppol/:id/document-exchange-type` body probably `{documentExchangeType: "send_only"|"send_and_receive"}` **(unverified)** -> `{integration}`.
- `DELETE /v2/integrations/peppol/:id`.
- `GET /v2/integrations/peppol/lookup-participant` - lookup whether the user's own participant exists on network.
- Sending e-invoices: `POST /v2/revenues/:id/send` with PEPPOL op; download UBL via `generate-invoice` with ubl type. Check client reachability with `/v2/clients/:id/peppol-exists`.
- Receiving: expenses carry `createdFrom: "peppol"` (ECreatedFrom, IDX:159993-160002), so received PEPPOL invoices appear as **expenses** (list `GET /v3/expenses`), not revenues (inferred; no receive endpoint exists). Revenue logs include `peppol-processed`.

## 9. Not determined
- Exact list filter names for `/v2/revenues` and `/v2/quotes` (hook chunk missing); try `GET /v2/revenues/filters`.
- Exact bodies of `/status`, `/email`, `/send`, `/reminders`, `/preview-invoice`, `generate-invoice` params, PATCH body, `POST /v2/integrations/peppol` body, client create body.
- Whether credit-note amounts are signed.
- Where PDF is downloaded from after generate (likely `file-url` signed URL).

## 10. UPDATE (lazy chunks now available) - verified details

This section SUPERSEDES the "(unverified)" guesses above where they conflict. Chunk refs: `HYF` = `index-HYF-epX_.js` (revenues list page), `SUB` = `useRevenuesSubNav-COPqDoX0.js`, `FLT` = `useRevenuesFilters-qCaSIKPk.js`, `FRM` = `Form-h1jZ-JWC.js` (invoice form), `DEF` = `useRevenueDefaultValues-BZfd4MbG.js` (form defaults + submit serializer), `MAIL` = `RevenueEmailClient-DBUaS4FR.js`, `VAL` = `validations-BOaexkfW.js`, `QIDX` = `index-CR1tecqR.js` (quotes API), `TXN` = `index-nB-8JcPU.js` (transactions UI).

### 10.1 Number formats (confirmed)
- `VATRate` is per-mille of the rate: **210 = 21.0%**, 60 = 6%, 120 = 12%, 0 = 0%. UI renders `dividBy10(VATRate) + "%"` (index-BOjM-jIX.js:288 with `dividBy10`, IDX:118815). Line totals use `unit * (1 + VATRate/1000)` (IDX:163362-163372). A null `VATRate` is sent as `null` (DEF:178 "VATRate: D.VATRate ?? null") and is allowed.
- `quantity`, `unitAmountExclVAT`, `unitAmountInclVAT`, `discountPercentage`, `downPayment`, `paymentAmount`(?) are all x1000 integers (quantity 1000 = 1.0; 12.50 EUR = 12500; discount 100 = 10%). List `totalAmountInclVAT` / `baseCurrencyTotalAmountInclVAT` also x1000 (HYF:2218-2226 passes with `shouldDivideBy1000`).
- Dates `YYYY-MM-DD`. `period` object (VAT period) = `getPeriodFromDate(freq, invoiceDate)` -> `{month, year}` (monthly) | `{quarter, year}` (quarterly) | `{year}` (yearly), default quarterly (IDX:166455-166464). In Germany `period` is not sent for status changes (HYF:1267).

### 10.2 GET /v2/revenues - exact list params
Main list page fetches (SUB:~Pe): `GET /v2/revenues?` + `qs.stringify({page, sort, ...filtersData, perPage: 25, expand: ["taxLock"]}, {skipEmptyString, arrayFormat:"comma"})`. Response `{data: Revenue[], paging: {page, perPage, pagesCount|pageCount, totalCount}}` (HYF:2552, 2234). Params seen anywhere in the UI:

| param | type / values | evidence |
|---|---|---|
| `page`, `perPage` | ints (UI uses 25; 50 for "latest"; 100 for autoreview) | SUB, HYF:444 |
| `sort` | `<field>_<asc\|desc>`; sortable fields: `client.name`, `type`, `created` (imported date), `revenueNumber`, `invoiceDate`, `status`, `totalAmountInclVAT` (HYF:1778-1812); also `isValidated` (page default asc, SUB `De`), `autofiledAt` (autoreview) | |
| `text` | free text search (UI strips `text` for export-count calls: HYF:2315) | |
| `expand` | `["taxLock"]` -> comma `expand=taxLock` | SUB Pe |
| `fields` | projection array e.g. `["_id"]`, `["type","fileType"]` | HYF:444, 2326 |
| `ids` | array of revenue ids (comma) | HYF:2326 |
| `isValidated` | `"true"`/`"false"` (false = "to review/incomplete" tab) | HYF:2245-2280 |
| `reviewed` | `"true"`/`"false"` (expert review state) | HYF:2234 |
| `autoreviewPending` | `true` | IDX:166311 |
| `status` | `sent`, `not-sent`, `paid`, `draft` (options come from `/filters`) | FLT:_ |
| `type` -> serialized as **`types`** | `invoice`, `credit-note`, `other-revenue`, maybe `peppol` pseudo-choice | FLT:U maps key `type`->`types` |
| `periods` (key `period` -> `periods`) | VAT period tokens built by filter util `I(e)` (format unverified) | FLT:U |
| `categoryIds` (key `categories`) | revenue category ids (e.g. `be.revenue.sales_services`) | FLT |
| `clientIds` | client `_id`s (options from `/filters` -> `{_id,name}`) | FLT |
| `reviewedBy` | `not-reviewed`, `ai`, `me`, `accountant` | FLT:E |
| `payment`, `isInvoice`, `source`, `isInstallment` | filter keys enabled in UI; value sets come from `/filters` **(values unverified)** | FLT:_ |
| `dateRange` | two-element array `[from, to]` (comma-joined on the wire: `dateRange=2026-01-01,2026-03-31`), date strings **(format unverified, likely YYYY-MM-DD)** | Filters.component-DIhEBbMR.js:138-149 |
| `amount_range` | 3-element array `[currency, min, max]` (`[s,t,u]`) **(unverified order/units)** | Filters.component:~152-175 |
| `has_attachment` | `"true"`/`"false"` | HYF:2327 |
| `exported` | `exported` filter (values from `/filters`) | FLT:D |
| `includeUnvalidated` | used only in export POST filters | HYF:2372 |
The filter definitions are server-driven: `GET /v2/revenues/filters` returns an array of `{key, values}`; keys the UI keeps: `status,type,reviewedBy,payment,isInvoice,source,period,categories,dateRange,clientIds,isInstallment,amount_range,has_attachment` (FLT:_). `values` for `categories` are `{id}`, for `clientIds` `{_id,name}`, others plain strings. Fetch it once to learn the allowed values.
Footer in the UI computes the sum with sign: credit notes negative, `not-sent` invoices excluded (HYF:2227-2232).
Quotes list: `GET /v2/quotes?` same serialization, default sort `quoteDate_desc`, `perPage:25`, filters `status`, `categoryIds`, `dateRange` (SUB:140-190, `QIDX`). Quotes also have `GET /v2/quotes/filters`, `DELETE /v2/quotes/bulk?ids=`, `DELETE /v2/quotes/:id`, `POST /v2/quotes/:id/status` body `{status}` (response `.data`), `POST /v2/quotes/:id/email`, `POST /v2/quotes/preview` (QIDX:20-52).

### 10.3 Create / update invoice - exact body
Form submit = `POST /v2/revenues` (new) or `PUT /v2/revenues/:id` (edit), FRM:657 `(id ? updateGeneratedRevenue(id, X) : createGeneratedRevenue(X))`. `X = serialize({...formValues, ...preSubmitResult, settings:{...settings, ...styleSettings}})` where `serialize` = DEF:135-232 (undefined keys stripped except `VATRate, orderReference, paymentType, comments, deliveryDate, deliveryPeriod, companyName, email, phoneNumber, IBAN, SWIFT, accountHolderName`, which may be `null`). Optional download flags `generateUbl21|generateUblBe|generateUbl31|generateZugferd: true` (FRM:~598) make the server produce the XML and return `filePathUbl21|filePathUblBe|filePathUbl31|filePathZugferd`; PDF is `filePath` on the response (FRM:~640).
```ts
interface InvoiceBody {            // POST/PUT /v2/revenues
  type: "invoice" | "credit-note" | "other-revenue";
  fileType: "generated";
  status: "not-sent" | "sent" | "paid" | "draft";  // form default "not-sent"; "draft" only when saving draft
  revenueNumber?: string;          // omit -> server may allocate? UI pre-fills via next-number (useRevenueNumber)
  invoiceDate: string;             // YYYY-MM-DD
  dueDate: string;                 // default invoiceDate + payment term (30 days)
  deliveryDate?: string | null;    // DE; or deliveryPeriod (mutually exclusive)
  deliveryPeriod?: ... | null;
  paymentDate?: string;            // only if country config has_payment_date
  paymentType?: string | null;
  currency: string;                // "EUR" default
  paymentAmount?: number;          // foreign currency: base-currency total (x1000)
  period?: {month?,quarter?,year}; taxPeriod?: object;
  clientId?: string;
  client: Client;                  // embedded snapshot, full client object
  items: Array<{ name, description?, quantity, unit, unitAmountExclVAT, unitAmountInclVAT,
                 doesUnitPriceIncludeVAT, discountPercentage, VATRate|null, whyZeroVAT?, categoryId?, category?, assetId?, _id? }>; // UI-only _localId/_deleting/_duplicating stripped
  comments?: string | null;
  orderReference?: string | null;
  communication?: string;          // BE structured communication; fetched via GET /communication
  downPayment?: number;            // x1000, only if settings.useDownpayment
  transactions: string[];          // linked bank transaction ids (objects mapped to _id)
  quoteId?: string;                // when converted from a quote
  template_entry_id?: string; template_content_id?: string;
  din5008?: boolean;               // DE
  settings: { doesUnitPriceIncludeVAT: boolean /* every item */, usePaymentQrCode: boolean,
              useCommunication: boolean, useDownpayment: boolean, includeCopyrightReminder?: boolean,
              termsAndConditions: string, logo?: {filePath}, language: string /* "en"|"nl"|"fr"|"de" */,
              header: {color:{r,g,b}}, templateType: "straight"|"basic"|"rounded"|"circle",
              fontFamily: string, showDeliveryPeriod: boolean };
  user: { companyName|null, address:{street,city,zip,...}, VATNumber, phoneNumber|null, email|null,
          steuernummer?, SWIFT|null, accountHolderName|null, IBAN|null, VATReturnFrequency, VATType, firstName, lastName }; // sender snapshot, from account profile
  revenueProject?: {...};          // installment invoicing: installmentValue/Percentage, installmentAmountShownAs ("percentage"|"value"), installmentInvoiceType ("advance"|"progress"|"final"), snapshot{projectId, items, currency, baseCurrency}
}
```
Minimum an MCP should send: `type, fileType:"generated", status, invoiceDate, dueDate, currency, items, client (+clientId), user (copy from `GET /v2/users` profile), settings{language,...}` and the template ids. **(Whether the server tolerates omitting `user`/`settings` is unverified; safest is to clone the structure from an existing revenue via `GET /v2/revenues/:id`.)** Response = created revenue including `_id`, `revenueNumber`, `filePath`.
Credit notes use the same body with `type:"credit-note"` (form opened with `type=credit-note`); items stay positive, sign comes from type (list footer subtracts them, HYF:2229).
Imported invoices (`fileType:"imported"`, via OCR flow) use the same endpoint without items/template (IDX:198544).

### 10.4 Status / mark paid
`PUT /v2/revenues/:id/status` body `{ status: "sent"|"paid"|"not-sent", period?: <period object> }` (HYF:1285-1300: `{status: Z.paid, period: w}`; also after sending: `{status:"sent", period}`). No `paymentDate` is sent; `period` omitted for Germany. When the doc is tax-locked (`isLocked`), use `PATCH /v2/revenues/:id/locked` with `{status}` (HYF `An/Rn` = patchLockedInvoice(Status)). Tax-lock pre-check: `POST /v2/revenues/tax-lock` with the invoice fields (see §1). Marking paid with a transaction match: set `transactions` via PUT, or link from the transaction side (10.6).
Quotes: `POST /v2/quotes/:id/status {status: "sent"|"not-sent"|"approved"|"rejected"}`.

### 10.5 Sending
`POST /v2/revenues/:id/send` body `{ ops: Array<{method:"PEPPOL"} | {method:"EMAIL", data: EmailData}> }` (MAIL:1267-1280, 1432). Response `{ ops: [{method, ok:boolean, error?:[{code}], reason?}] }`; `ok:false` entries signal failure (codes translated as `backend.errors.<code>`). Both methods may be sent in one call. Preconditions (UI): PEPPOL needs own integration `status=="active"` + `GET /v2/clients/:id/peppol-exists` -> `exists && isReceivingOptionEnabled` (MAIL:1250). After a successful send the UI calls `PUT /:id/status {status:"sent", period}` (index-wqD2-7U-.js:5215).
```ts
interface EmailData {               // MAIL:383-440, 1448-1466, VAL:2184-2210
  to: string[];                     // min 1
  cc: string[]; bcc: string[];      // default cc=[own email]
  subject: string;                  // required
  htmlTemplate: string;             // HTML body, supports {{variable}} placeholders (revenueNumber, ...)
  saveTemplate: boolean;            // persist subject/body as default template
  enableTracking: boolean;          // open tracking (default true in BE)
  attachInvoicePdf?: boolean; attachInvoiceUbl21?: boolean; attachInvoiceUblBe?: boolean;
  attachInvoiceUbl31?: boolean; attachInvoiceZugferd?: boolean; attachQuotePdf?: boolean;
  externalAttachments?: Array<{filePath: string; name: string}>;  // uploaded via upload flow, category emailAttachment
  // form also spreads sendViaPeppol/sendViaEmail/to_draft/cc_draft/bcc_draft: harmless extras
}
```
`POST /v2/revenues/:id/email` takes the same `EmailData` (no `ops` wrapper); the UI uses it to send a **test email** (`to:[own email], saveTemplate:false, enableTracking:false`, MAIL:1405) and for quotes/legacy flows. Quote sending: `POST /v2/quotes/:id/email` same data. Reminders: `POST /v2/revenues/:id/reminders` (body not visible in the chunks inspected **(unverified)**).

### 10.6 Linking a revenue to an incoming bank transaction
Three equivalent mechanisms:
1. **From the revenue**: put the transaction ids in `transactions: string[]` on `POST/PUT /v2/revenues` (DEF:~165 maps `_matchedTransactions` -> ids). On a tax-locked invoice use `PATCH /v2/revenues/:id/locked` with `{transactions, notes, paymentType, status}`. `GET /v2/revenues/:id?expand=transactions` returns the objects.
2. **From the transaction (single)**: `PUT /v1/transactions/:id` with the full transaction object plus `matchedItems: [{type:"invoice", documentId:<revenue _id>, isCreditNote:boolean}]` (TXN:6886, 8226-8233; `createInvoiceMatchedItem`, IDX:198628). Clear with `matchedItems: [], taxPeriod:null, transactionCategory:null` (TXN:9509).
3. **From the transactions list (bulk)**: `PATCH /v2/transactions/bulk` body `{ ops: [{ resourceId: <txId>, body: { transactionCategory?, revenueId: <revenue _id> } }] }` (TXN:7519-7526; key `revenueId` for invoice type, `expenseId` for expense, IDX:198589-198592).
Helpers to find candidates: `GET /v1/transactions/:id/guess?document=invoice` (suggest matching revenue, TXN:7150) and `GET /v1/transactions/suggested-transaction?amount=&date=&...` -> `{isFound, transaction}` (useHasTransactions-CQEK6lrz.js:44-52) to find the bank transaction for a given amount/date. Creating a paid revenue straight from a transaction: build body with `formatInvoiceFromTransaction` (§1).

### 10.7 Still not determined
Exact wire format of `dateRange`/`amount_range`/`periods`; values of `payment`, `source`, `isInvoice`, `isInstallment` (use `/v2/revenues/filters`); reminders body; `PATCH /v2/revenues/:id` body; whether `user`/`settings` are required server-side; PEPPOL registration body; the `generate-invoice` params.

## Proposed MCP tools
| Tool | Description | Input | Mode |
|---|---|---|---|
| `accountable_list_revenues` | List invoices/credit notes/other revenues | page, perPage, sort, status?, type?, clientId?, text? (extra filters passed through) | read-only |
| `accountable_get_revenue` | Revenue detail with linked transactions | id | read-only |
| `accountable_get_next_revenue_number` | Next invoice/quote number | type, date | read-only |
| `accountable_check_revenue_number` | Does number exist | type, revenueNumber | read-only |
| `accountable_calculate_revenue_totals` | Server-side totals for items | items, invoiceDate, currency, clientId? | read-only |
| `accountable_create_invoice` | Create invoice/credit note/other revenue (human-unit inputs converted to x1000) | type, client or clientId, invoiceDate, dueDate, currency, items[{name, quantity, unitPriceExclVat, vatRate}], status, notes, transactionIds | write |
| `accountable_update_revenue` | PUT/PATCH revenue | id, fields | write |
| `accountable_mark_revenue_paid` | Set status paid + paymentDate (+ link tx) | id, paymentDate, transactionIds? | write |
| `accountable_link_revenue_transactions` | Set `transactions` on a revenue (uses /locked if tax-locked) | id, transactionIds | write |
| `accountable_send_invoice` | Send via email and/or PEPPOL | id, methods, email options | write (external side effect) |
| `accountable_send_invoice_reminder` | Payment reminder email | id | write (external) |
| `accountable_download_invoice` | Get signed URL/file for pdf/ubl | id, format | read-only |
| `accountable_delete_revenue` | Delete revenue(s) | id / ids | destructive |
| `accountable_get_revenue_logs` | Email/PEPPOL delivery history | id, page | read-only |
| `accountable_list_quotes` / `accountable_get_quote` / `accountable_create_quote` / `accountable_update_quote` | Quote CRUD | per above | read / write |
| `accountable_list_clients` / `accountable_get_client` | Client search/read | text, page, perPage, sort / id | read-only |
| `accountable_create_client` / `accountable_update_client` | Client write | client fields | write |
| `accountable_delete_clients` | Delete clients | ids | destructive |
| `accountable_check_client_peppol` | Can client receive PEPPOL | clientId, documentType | read-only |
| `accountable_get_peppol_integration` | Own PEPPOL registration status | - | read-only |
| `accountable_list_document_templates` | Templates (find default) | documentType, isDefault | read-only |
| `accountable_list_recurring_invoices` / `accountable_pause_recurring` / `accountable_resume_recurring` | Recurring invoice management | id | read / write |
