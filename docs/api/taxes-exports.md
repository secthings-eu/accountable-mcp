# Taxes, exports, documents, credit-card statements, AI conversations, support, gratifications

Static analysis of the production bundle. Base URL `https://app.accountable.eu/api`; the axios instance returns
`response.data` directly (`index-DbupgLzd.js:215380-215470`), so all "response" shapes below are the JSON body.
Default timeout is 60 s. Bearer auth, see BRIEF.

References: `index-DbupgLzd.js` = `I:`, `OnlyBeforeAuthRoute-BCInpor-.js` = `O:`,
`exportCompletionToast-BE4vsoEV.js` = `E:`, `App-DxaMWFae.js` = `A:`.

**Update.** The lazy chunks are now in `research/bundle/`. References such as `Tax-CqguZWk6.js:2767` are to those chunks (all in `research/bundle/`).
Translations (French labels) are NOT in the bundle (loaded at runtime); French labels below are my own rendering of the i18n keys and are **(unverified)**.
Taxes-page chunks: `Tax-CqguZWk6.js` (detail page), `index-DTih1Hb6.js` (list page), `index-DG989owB.js` (v1 tax API), `useUpdateTaxMutation-BlxI46y2.js`,
`useUpdateTaxStatusMutation-Bgy6NFQJ.js`, `useGetTaxBySlug-D4mDKRcn.js`, `getPeriodSlug-EW7N6AWD.js`, `IntervatUploadReminderBar-BQID4XPd.js`,
`SubmissionsTable-kVB76Kl5.js`, `StatementTablesBreakdown-DpO6zUuC.js`, `getTaxAmount-BgfMiUnR.js`. Export chunks: `index-BbZeXjA2.js`, `usePerformExport-qpZJ-KUh.js`,
`index-CGEZy76n.js` (accountant export page), `index-BT6L6J5X.js` (expenses), `index-HYF-epX_.js` (revenues), `DocumentsRepositoryIntro-DSs0iktd.js`.

---

## 1. `/v2/taxes`: VAT declarations / tax obligations

A "tax item" is one obligation for one period. The frontend gets a whole year at once, grouped by quarter.

### 1.1 `GET /v2/taxes/{year}?expand=document`  (`getTaxesByYear`, I:194510)
Main call behind the Taxes page and the sidebar badge. `year` is a number (e.g. `2026`). Query: `expand=document`
(attaches `documents` to each item, see 1.7). Wrapped by `useGetTaxesByYear` (I:194967-195030), which is only enabled when
`customer.firstTaxComputationYear <= year`, uses `gcTime: 0`, react-query key `["Taxes", year, ...]`.

Response (fields read by UI):
```ts
interface TaxesByYearResponse {
  data: {                       // each value: { items: TaxItem[] }
    q1: { items: TaxItem[] }; q2: ...; q3: ...; q4: ...;
    annual: { items: TaxItem[] };   // income tax, trade tax, EUR, uste, vat-franchisee, client listing ...
  };
  meta: {
    actionsRequired: Record<string /*year*/, number>;   // e.g. {"2025": 2, "2026": 1}
    dueItems: Record<string /*year*/, Array<{ _id: string; type: TaxType; dueDate: string; period: {year,quarter?,month?};
                                              indexKey: string; readableType: string; hasDueDatePassed: boolean }>>;
    requiredActions?: Record<string /*year*/, unknown>;  // passed as `requiredActions` prop to each quarter block (index-DTih1Hb6.js:2108) **(unverified shape)**
  };
}
```
- **Sidebar "Taxes N" badge** = `sum(Object.values(meta.actionsRequired))` over ALL years in the response (O:2159-2187, `_sum`). Red if any `dueItems[*][*].hasDueDatePassed`, yellow otherwise; hidden while on the Taxes page.
- The list page shows a banner "late obligations" for the latest year before the current tab with `actionsRequired[year] > 0`, count = `actionsRequired[year]`; clicking opens the tab, or, if exactly 1, jumps straight to the earliest `dueItems` entry via `/taxes/{readableType}/{getPeriodSlug(item)}` (index-DTih1Hb6.js:743-798). Green "taxes in order" banner when the sum is 0 (index-DTih1Hb6.js:801-812). Per-year empty state `taxes.empty.nothing_to_review` (:895).
- `dueItems[year][i].indexKey` **(unverified)** probably identifies the item inside `data.q*.items` / `annual.items`; `_id` = tax id; `readableType` + `period` give the detail-page URL.
- The list is computed server-side: **"action required" per type is NOT computed in the client**; `meta.actionsRequired` counts items the backend considers overdue/to-do for that year. The client-side rules that colour the cards (below) are the best proxy.

#### TaxItem fields observed
| field | meaning | ref |
|---|---|---|
| `_id` | tax id used in all `/v2/taxes/{id}/...` calls | I:194536 |
| `type` | `TaxTypeEnum` value (below). `vat` is a composite item that has nested `submission` and `payment` items, each with its own `type` (`vat_submission` / `vat_payment`) | I:165112, 194982 |
| `period` | `{year, quarter?}`, `{year, month?}` or `{year}`; `quarter` 1-4, `month` 1-12 | I:194700-194760 |
| `status` | `TaxStatusEnum`: `done` \| `not_done` \| `unknown` | I:142640 |
| `submissionStatus` | `TaxSubmissionStatus`: `not_done` \| `done` (has the declaration actually been filed with the authority) | I:142646 |
| `submissions[]` | list of submissions; last one has optional `submissionRef` (authority reference, set when filed through Intervat) | I:164960 |
| `documents[]` | with `expand=document`; each has `documentFields[]` with `{referenceType: "tax"\|..., value}`; `DocumentReferenceType`: `tax_payment_reminder`, `tax_prepayment`, `tax_assessment`, `tax_receipt`, `tax` | I:164887-164910, 144995 |
| `guarantee.taxChecks.failed` | array of failed `TaxCheckEnum` ids (see 1.5) | I:194543 |
| `paidAmount`, `incomeTaxToPay`, `projectedIncomeTax`, `incomeTaxPrepaymentTotal`, `employeeSalary` | income-tax items | I:165128-165140 |
| `isSpecial` | client-only flag for special VAT | I:194982 |

`TaxTypeEnum` (I:142662): `income_tax_submission, trade_tax_submission, intracom_listing, vat_submission, client_listing,
sc_subject, EUR, vat, ustva, ustva_submission, ustva_payment, special-vat, special_vat_payment, special_vat_submission,
vat_payment, uste_submission, uste_vat_payment, uste_vat_submission, vat_franchisee, income_tax_payment,
income_tax_prepayment, company_tax_payment, company_tax_prepayment, trade_tax_prepayment, uste_payment, sc_exonerated, sc_settings`.
Belgium: VAT (monthly/quarterly), `client_listing` (annual customer listing), `intracom_listing`, income tax payment /
prepayment / submission, social contributions (`sc_*`), company tax. Germany: `ustva` (VAT advance return), `uste` (annual VAT),
`zm` (intracom listing), `est-*`, `gewst-*` (trade tax), `eur`.

#### Tax types: French UI label (key -> **unverified** French rendering) and what "to do" means
Labels come from i18n keys `taxes.filters.types.<type>[.<frequency>]` (index-DTih1Hb6.js:1630-1660; useUpdateTaxStatusMutation-Bgy6NFQJ.js); the French strings are not in the bundle, so the labels are guesses. Items with `type` outside the list in `ys()` (index-DTih1Hb6.js:943-964) are shown "locked, unlock on mobile".
| `type` (backend) | readableType | French label (unverified) | what "action required" most likely means (client rules; server rule **unverified**) |
|---|---|---|---|
| `vat` (composite; BE/DE, quarterly/monthly/yearly) | `be/vat`, `de/ustva` | Declaration TVA (trimestrielle) / Voranmeldung | has `submission` (`vat_submission`) and `payment` (`vat_payment`) sub-items. To do while `submission.status` or `payment.status` is `not_done` (index-DTih1Hb6.js:821 `hs`): (1) review + file the return, (2) pay (or "recovered" if `payment.toClaim`). Pending upload = `status=done && submissionStatus=not_done && no submissionRef` |
| `vat_submission` / `vat_payment` | `be/vat/submission`, `/payment` | Declaration TVA / Paiement TVA | the two halves of `vat`; payment amount `payment.amount`, `toClaim` = refund |
| `special-vat`, `special_vat_submission`, `special_vat_payment` | `be/special-vat` | TVA speciale (OSS/one-off) | same as vat, has IBAN/BIC in submit body |
| `intracom_listing` | `be/intracom-listing`, `de/zm` | Listing intracommunautaire | file the listing (XML) when there are intra-EU B2B sales; pending upload applies |
| `client_listing` | `be/client-listing` | Listing clients TVA (annuel) | annual Excel/XML upload to Intervat; pending upload applies |
| `vat_franchisee` | `be/vat-franchisee` | Franchise de TVA (regime de franchise) | not a task: shows turnover vs threshold (success/warning/error theme) |
| `income_tax_submission` | `be/income-tax-submission` | Declaration a l'impot des personnes physiques | file annual return (opens from `startDateForIncomeTaxSubmission`, May 1st BE); `status` toggled when submitted |
| `income_tax_payment` | `be/income-tax-payment` | Paiement de l'impot (solde) | pay the assessed/estimated balance (`incomeTaxToPay`), `paidAmount` when done |
| `income_tax_prepayment` | `be/income-tax-prepayment` | Versements anticipes | pay the quarterly advance (`suggestedPrepaymentAmount`/`estimatedQuarterTax`, or DE `totalTaxAmountRequested`); mark as paid |
| `company_tax_payment`, `company_tax_prepayment` | `be/company-tax-*` | Impot des societes (solde / acompte) | same as personal, uses `companyTaxToPay`, `paidAmount` |
| `trade_tax_submission` / `trade_tax_prepayment` | `de/gewst-*` | Gewerbesteuer (declaration / acompte) | DE only; prepayment amount `requestedPrepaymentByTaxOffice` |
| `uste_submission`, `uste_payment`, `uste_vat_submission`, `uste_vat_payment` | `de/uste-*` | Declaration annuelle de TVA (DE) | DE annual VAT; amounts in `statement.l.f820` / `statement.k.f820` (>=2025) / `statement.820` |
| `ustva`, `ustva_submission`, `ustva_payment` | `de/ustva` | Voranmeldung TVA (DE) | normalised to `vat` client-side |
| `EUR` | `de/eur` | Einnahmenuberschussrechnung | DE annual profit statement; submitted flag |
| `income_tax_submission` (DE) | `de/est-submission`, `de/est-payment`, `de/est-prepayment` | Einkommensteuer | as BE income tax |
| `sc_subject` | `be/social-contribution-subject` | Cotisations sociales (trimestrielles) | pay quarter contribution (`settings.quarterPayment`); mark as paid (MarkSCSubjectAsPaid) |
| `sc_settings` | | Parametrage cotisations sociales | setup task: user must configure their social-fund settings |
| `sc_exonerated` | `be/social-contribution-exonerated` | Exonere de cotisations | informational |
Card sub-labels (i18n keys, index-DTih1Hb6.js:1700-1790): `taxes.vat.exported_not_paid`, `taxes.exported`, `taxes.submitted`, `taxes.paid`, `taxes.initially_due_on`, `taxes.due_on`, `taxes.see_tax_statement`.
Card colour: pending upload = yellow; `isUrgent` (due soon + not done, computed client side from `dueDate`: diff in days **(threshold unverified)**) = red; `isDueSoon` = yellow; done or zero payment = green; `status: "unknown"` = faded (backend could not compute). Zero-amount payments count as nothing to do.
`status: "unknown"` also counts as "initially due on".

Obligation helpers (I:164945-164975):
- `isManualUploadObligation`: type in `vat_submission`, `client_listing`, `intracom_listing` (Belgium: user must upload to Intervat manually/with XML).
- `isPendingIntervatUpload(item)`: `status==done && submissionStatus==not_done && !last(submissions).submissionRef` = "declaration computed and reviewed but not yet submitted to Intervat".
- `isObligationPendingUpload`: applies the above to `vat` (via `.submission`), `client_listing`, `intracom_listing`.
- `isTaxDone(item)`: `status==="done"`.

Belgium country config: `hasXMLSubmission: true`, `download_vat_submission_xml: true`, `required_data_for_vat_submission: ["VATNumber","Address"]`,
VAT statement grids c00-c03, c44-c49 (sales), c81-c88 (purchases), c54-c57,c61,c63 (due), c59,c62,c64,c66 (deductible), c71,c72,c91 (net) (I:164990-165060).
The receipt of a VAT filing arrives as a document with `referenceType: tax_receipt` (usually 24 h after filing) (I:165113).

Frequency: `customer.settings.taxes.VATReturnFrequency` or feature flag `taxes.default_vat_return_frequency` (`useVATReturnFrequency`, I:194573); values `monthly|quarterly|yearly` **(unverified)**. `getBackendReturnFrequencyFromTaxItemPeriod` returns `"0"/""` for month, `"4"` for quarter (I:194503).

### 1.2 `GET /v2/taxes?types=...&statuses=done&perPage=500`  (`getClosedVATPeriods`, I:194512)
List filter. Query exactly: `types` (comma list: `vat_submission,uste_submission,vat_payment,intracom_listing`, or just `uste_submission` for Germany yearly), `statuses=done`, `perPage=500`.
Response: `{ data: TaxItem[] }`; UI maps `item.period`. Use: "which periods are already closed". Other filters (`years`, `page`) **(unverified)**.

### 1.3 `GET /v2/taxes/resource/{country}/{taxSlug}/{periodSlug}?expand=document`  (`getTaxBySlug`, I:194499; hook `useGetTaxBySlug`, useGetTaxBySlug-D4mDKRcn.js:33)
`ignoreToast`, returns the unwrapped `data` = ONE full tax item (with nested `submission`/`payment` for `vat`, `breakdown`/`statement`, `submissions[]`, `documents`).
Called by the detail page with `"{country}/{taxSlug}/{periodSlug}?expand=document"` from the route `/taxes/:country/:taxSlug/:periodSlug` (Tax-CqguZWk6.js:2767-2771).
The list page navigates with `/taxes/{item.readableType}/{getPeriodSlug(item)}` (index-DTih1Hb6.js:770), so **`item.readableType` = `"{country}/{taxSlug}"`**.
`getPeriodSlug(tax)` (getPeriodSlug-EW7N6AWD.js:`s`): `month ? "{year}-{month}" : quarter ? "{year}-4{quarter}" : "{year}"`, i.e. Q2 2026 -> `2026-42`, March 2026 -> `2026-3`, year -> `2026`.
Examples: `GET /v2/taxes/resource/be/vat/2026-42?expand=document` (Belgian VAT Q2 2026), `be/income-tax-submission/2025`, `de/ustva/2026-3`, `be/client-listing/2025`.
Known `readableType` values = route keys in Tax-CqguZWk6.js:530-553: `be/social-contribution-subject`, `be/social-contribution-exonerated`, `be/income-tax-prepayment`, `be/income-tax-payment`, `be/client-listing`,
`be/vat` (+ `be/vat_submission`, `be/vat/submission`, `be/vat/payment`), `be/special-vat`, `be/intracom-listing`, `be/income-tax-submission`, `be/company-tax-prepayment`, `be/company-tax-payment`, `be/vat-franchisee`,
`de/est-payment`, `de/est-prepayment`, `de/uste-submission`, `de/est-submission`, `de/vat-franchisee`, `de/ustva` (+`/payment`,`/submission`), `de/zm`, `de/eur`, `de/gewst-submission`, `de/gewst-prepayment`.
Client post-processing (useGetTaxBySlug-D4mDKRcn.js:36-80): for `vat`, `_id` is overwritten with `submission._id`; `ustva`/`special-vat` -> `vat`; adds `guarantee.taxChecks` (from last `submissions[]`.taxChecks: `{failed[],passed[],reviewed[]}`), `isGuaranteed`.

### 1.4 `GET /v2/taxes/{taxId}/submissions/{submissionId}?showBreakdown=<bool>`  (`getSubmissionDetails`, I:194528)
Returns `data`. `showBreakdown` toggles per-document breakdown of the amounts **(unverified)**. Cache key `Submissions`.

### 1.5 Tax checks (the "guarantee" / review warnings)
- `GET /v2/taxes/{taxId}/checks/{checkId}` (`getTaxCheck`, I:194534). Query: `expense_version=3`, `lang`, `page`, `perPage=25`, `status=failed|reviewed` (`failed` if `checkId` is in `tax.guarantee.taxChecks.failed`, else `reviewed`). Returns a paged list of the expenses/revenues that triggered the check **(shape unverified)**.
- `POST /v2/taxes/{taxId}/checks/{checkId}/review` (I:194555): mark check reviewed (no body). Write.
- `POST /v2/taxes/{taxId}/checks/{checkId}/undo-review` (I:194559): revert.
- After these, UI invalidates `taxChecks` => expenses + revenues page keys (I:286316).

`TaxCheckEnum` ids (I:142742-142814), grouped. Useful for "what is left to review for a quarter":
`expense.missing-document`, `expense.not-reviewed`, `revenue.not-reviewed`, `revenue.not-sent`, `revenue.not-paid`, `expense.duplicate`,
`expense.reverse-charge`, `expense.vat-claimed-above-21`, `expense.vat-claimed-above-19`, `expense.linked-to-vat-payment`,
`expense.mismatch-vat-rate-with-category`, `expense.payment-mismatch-with-document`, `revenue.payment-mismatch-with-document`,
`expense.invoice-without-vat-number`, `expense.ticket-with-vat-number`, `expense.personal-supplier`, `expense.restaurant-personal`,
`expense.above-1000-eur`, `expense.fake-receipt`, `revenue.fake-invoice`, `expense.franchisee-regime`, `revenue.franchisee-regime`,
`revenue.reverse-charge-vat-rate`, `expense.included-in-another-submission`, `revenue.included-in-another-submission`,
`submission.vat-refund-above-1000`, `submission.missing-vat-payment-quarterly`, `submission.missing-vat-payment-monthly`,
`submission.expense-different-year`, `submission.revenue-different-year`, `submission.ticket-above-250`, `submission.1p-rule-*`,
`submission.commuter-allowance-*`, `submission.homeoffice*`, `submission.revenue-above-ku-threshold`, `expense.germany-unpaid`, `AllReviewed`, ...

### 1.6 Mark an item done / not done (verified)
Two different writes:
1. **`PUT /v1/taxes/{taxId}`** with body = **the whole tax item with `status` flipped** (`status: "done" | "not_done"`): `useUpdateTaxMutation` -> `index-DG989owB.js:150` (`N`; for `EUR`, `uste_submission`, `vat_submission` the `breakdown` field is omitted from the body). Used for "mark as paid / recovered / submitted" (label chosen by `Ns()`: index-DTih1Hb6.js:1273) and for `{...tax.payment ?? tax, status:"done", paidAmount: Number(amount)}` after a successful payment redirect (Tax-CqguZWk6.js:2778). For a `vat` composite item the sub-item (`submission` or `payment`) is what is sent. After success: invalidate Taxes, refetch the year. Response = updated tax.
2. **`PATCH /v2/taxes/{taxId}/submission-status`** body `{submissionStatus: "done" | "not_done"}` (`updateTaxSubmissionStatus`, I:194549; useUpdateTaxMutation-BlxI46y2.js:39-47). For manual-upload obligations the UI calls it right after (1) with `submissionStatus = status==="done" ? "done" : "not_done"`; alone it is the "I uploaded to Intervat" button.
Both are state writes with legal meaning; the MCP should require explicit confirmation.

### 1.7 Prepayment setup
- `POST /v2/taxes/income-tax/yearly-prepayments` body `ee` (I:194564)  - income-tax advance payments plan (`PrepaymentMethodEnum`: `none | front_loaded | gradual`, I:142698).
- `POST /v2/taxes/trade-tax/yearly-prepayments` body `ee` (I:194566)  - German Gewerbesteuer prepayments.
Body shape not visible (built in missing chunk) **(unverified)**; likely `{year, method, amounts/quarters}`.
- `POST /v2/taxes/de/employee-expenses/calculations` (I:194568; `ignoreToast`) German employee-expense calc. Returns `data`.

### 1.8 Submission to the authority, "proof" and downloads (verified in lazy chunks)
There is **no "upload proof" request**. Belgian VAT / client listing / intracom listing are `isManualUploadObligation`; the flow is:
1. `POST /v1/taxes/{taxId}/submit` (index-DG989owB.js:157): body (index-CX0M3mf7.js:710, Payment-Cx0j0tAn.js:660, index-B69xqRel.js:160)
   ```ts
   { skipGuarantee: boolean,                       // true = ignore failed tax checks
     usecase: "validate" | "send" | "email",       // UseCase enum, I:142718. send = file/transmit; validate = dry-run/generate; email = email the file to the user (VAT payment page)
     name: string /*companyName or "first last", sliced to 45 (30 for intracom_listing)*/, email: string, address: Address,
     VATNumber?: string, steuernummer?: string, firstName?, lastName?, activity?,
     IBAN?, BIC? /* special VAT only */ }
   ```
   config `{ignoreToast:true}` on some pages. On success for non-`send` usecases of manual-upload obligations the UI then PATCHes `submission-status: not_done` (index-ClSS2-Eg.js:266). Response: `{...updated tax}` (`{...res, tax}`), exact fields **(unverified)**. Backend error codes under `response.data.errors[].code` (`backend.errors.<code>`).
   `POST /v1/taxes/income-tax/submission-user-details` (index-DG989owB.js:163) saves user details before income-tax submission.
2. The user downloads the generated XML (VAT, `hasXMLSubmission`) or Excel (client listing) from `submission.filepath`/`tax.filepath` (SubmissionsTable-kVB76Kl5.js:165-230),
   uploads it to Intervat (MinFin) by hand, then clicks "I uploaded it" = **`PATCH /v2/taxes/{taxId}/submission-status {submissionStatus:"done"}`** (IntervatUploadReminderBar-BQID4XPd.js:`cta_uploaded`). "Unmark as submitted" = `PUT /v1/taxes/{id}` with `status:"not_done"` (1.6).
   If an Intervat/MinFin session exists (`isMinFinSessionActive`, `POST v2/users/minfin/synchronize` O:938) the backend files it and `submissions[].submissionRef` appears, plus a `tax_receipt` document (available ~24 h after).
3. Files are downloaded via `GET /v2/users/file-url?filePath=<path>` -> `{url}` (signed), then a blob GET of that URL (downloadFileFromPath-D1Wg0yvs.js:`s`,`i`; downloadDocument-D9PDD6jc.js).
   Submission-level exports: `POST /v2/exports/tax/{taxId}` and `POST /v2/exports/submission/{submissionId}` with body `{modules:{excel:{include:true}}}` / `{modules:{pl:{include:true}}}` / `{modules:{datev:{include:true,accountingCode:"skr03"}}}` / `{modules:{ubl:{include:true,version:"ublBe"}}}` / `{modules:{pdf:{include:true}}}` / `{modules:{original_documents:{include:true}}}` (SubmissionsTable-kVB76Kl5.js:255-420, index-BbZeXjA2.js:22-23). Result handled like section 4.2.

### 1.8b VAT return figures (grids) for a quarter
`GET /v2/taxes/resource/be/vat/{year}-4{quarter}?expand=document` (1.3). On the returned vat item (`submission` sub-item holds the statement):
- `breakdown` (live/computed) or `statement` (history, when already filed) is a map keyed by grid code: `statement["c71"]` is a number or `{amount, line?, documents?:[...]}` (StatementTablesBreakdown-DpO6zUuC.js:`ne`,`te`,`H`; DE variants `statement.EUR.*`, `statement.AVEUR.*`).
  `ne()` reads `statement.<cell>.amount ?? statement.<cell>`. Cells for Belgian VAT, grouped (I:164990-165060): sales `c00 c01 c02 c03 c44 c45 c46 c47 c48 c49`; purchases `c81..c88`; due `c54 c55 c56 c57 c61 c63` (+`xx` total due); deductible `c59 c62 c64 c66` (+`yy`); net `c71` (to pay) `c72` (to reclaim) `c91`. Special VAT: `c71..c73,c75..c78`, `c80..c84`. `vat.payment.amount` falls back to `xx - yy`.
- Per-grid composition: each cell's `documents[]` entries `{type:"expense"|"invoice"|asset|transaction, contribution, document:{...expense|revenue fields}}`; invoices may be under `documents.invoices` (StatementTablesBreakdown:130-330). Clicking a cell opens the list of contributing expenses/invoices.
- `GET /v2/taxes/{taxId}/submissions/{submissionId}?showBreakdown=true` (1.4) returns the same for a specific submission (historical).
- Client listing: `statement.clients[]`; intracom: `listing[]`.

### 1.9 Settings related
- `PATCH /v2/users/settings/taxes`, `.../settings/taxes/{x}` (I:213553-213556) tax settings (VAT frequency etc.). Owned by users area.
- `GET /v2/users/settings/profit` (I:194527).
- `GET /v2/users/tax-office`, `GET /v3/users/tax-audit-protection` (I:157418, 259725): other areas.

---

## 2. `GET /v2/calculations/taxes?year=<n>`  (`getTaxesHeaderCalcs`, I:194523)
Header numbers of the Taxes page (default `year=current`). Response shape not visible (consumer is in the missing chunk) **(unverified)**; expected: VAT to pay, projected income tax, social contributions, profit estimates for the year.

## 3. Quarter filters on expenses (how to enumerate the "to review" items for a quarter)
Expense list `GET /v3/expenses` (I:243462-243510) accepts `vat_period` (alias `periods`) and `tax_period` (alias `taxPeriods`), comma-joined arrays
(`arrayFormat: comma`, `skipEmptyString`). Value format (verified): `periods`/`vat_period` serialisation is `{frequency[0]}_{value}_{year}` e.g. `q_2_2026` (quarter), `m_3_2026` (month), or just `2026` for yearly (filterConstraints-CJPES_Rt.js:`l`); `tax_period`/`taxPeriods` is passed a bare year (`taxPeriods: tax.period.year`, Tax-CqguZWk6.js:2701). The available values come from `GET /v3/expenses/filters` (`filters[].key=="period"`, `values[]={frequency,value,year}`). Bank transactions use `toClassify=yes` + `periods` (index-BvN-3bLc.js:2717). Other filters sent: `per_page`, `page`, `sufficiently_documented`, `is_invoice`, `search`, `categories`, `is_validated`, `is_credit_note`, `date_range`, `lang`. Response `{expenses, paging:{page, per_page, total_pages, total_count}}`. `GET /v3/expenses/filters` (I:243574) lists available filter values (possibly the period values). Revenues have `period` object `{quarter,year,month?}` (Joi, I:164668) and `getPeriodFromDate(freq, date)` (I:166489). `isValidated` on expense/revenue is the "reviewed" flag; the tax check `expense.not-reviewed` counts those.

**Recommended approach for MCP "VAT quarter status"**: call `GET /v2/taxes/{year}?expand=document`, read `data.q{n}.items` (type `vat`, nested `submission`/`payment`, `status`, `submissionStatus`, `guarantee.taxChecks.failed`), then drill into failed checks with `GET /v2/taxes/{id}/checks/{checkId}`.

---

## 4. `/v2/exports`: data exports (verified in lazy chunks)

### 4.1 Requests
| purpose | request | ref |
|---|---|---|
| Period export for the accountant (all data between two dates) | `POST /v2/exports` body `{startDateNumber: 20260401, endDateNumber: 20260630, modules: {...}, markAsExported?: true}` -> `{exportId}` | index-BbZeXjA2.js:20-21, index-CGEZy76n.js:745-765 |
| Single full-period report (BWA / P&L / EUR) | same endpoint, `modules: {bwa|pl: {include:true}}` with its own dates | index-CGEZy76n.js:770-782 |
| Amortisation table | `POST /v2/exports` `{startDateNumber:20000101, endDateNumber:<today>, modules:{amortisation_table:{include:true}}}` | Amortization.component-jPNzfNQu.js:168 |
| Profit & loss PDF | `POST /v2/exports` `{startDateNumber, endDateNumber, modules:{profit_and_loss:{include:true}}}` | ProfitAnalytics.component-BzyFAJrd.js:2940 |
| Export of the expenses list | `POST /v2/exports/expenses?{filters}` body `{modules:{<module>:{include:true},...}}` | E:38, index-BT6L6J5X.js:2159, 2196-2205 |
| Export of the revenues list | `POST /v2/exports/revenues?{filters}` same body | E:40, index-HYF-epX_.js:2321, 2364-2373 |
| Export of the Documents repository | `POST /v2/exports/repository-documents?{filters}` body `{modules:{repository_documents:{include:true}}, sendEmail:false}` | E:39, DocumentsRepositoryIntro-DSs0iktd.js:896-902 |
| Export tied to a tax item | `POST /v2/exports/tax/{taxId}` body `{modules}`; `POST /v2/exports/submission/{submissionId}` body `{modules}` | index-BbZeXjA2.js:22-23, SubmissionsTable-kVB76Kl5.js:267-420 |
| Poll | `GET /v2/exports/{exportId}` | E:35 |

**Filters on the wire** for `/v2/exports/expenses|revenues|repository-documents`: query string built with `qs.stringify(filters, {skipEmptyString:true, arrayFormat:"comma"})` (E:37). `filters` is either
`{ ids: [<selected row ids>], includeUnvalidated: true }` (selected rows) or `{ ...currentListFilters, includeUnvalidated: true }` (everything matching the list filters, excluding the free-text `text`). The list filters are the same camelCase names as the list pages
(expenses: `periods`, `categoryIds`, `attachment` ("true"/"false"), `dateRange`, `isValidated`, ...; revenues: `periods`, `types`, `categoryIds`, `clientIds`, `has_attachment`, `dateRange`, `amount_range`, `isInstallment`, ...) - the export pages count before exporting with the list endpoint (`PreExportSelectedInfo` / `PreExportFilteredInfo`, index-BT6L6J5X.js:2160-2195). Whether the export endpoints use the snake_case names the list endpoint uses (`vat_period`, `tax_period`) is **(unverified)**; expenses list rewrites camelCase to snake_case in the client (I:243462-243510) but the export call passes the filters as-is.

### 4.2 Modules (the "formats") and result
`modules` is an object `{<name>: {include: true, ...options}}` only for the ticked modules. Names (`ExportModulesEnum`, I:164882): `excel`, `original_documents`, `pdf`, `ubl`, `coda`, `datev`, `amortisation_table`, `profit_and_loss`, `pl` (EUR/P&L), `bwa`; plus `repository_documents`, `chift`(?).
Per country (config, I:165170-165190, 202351-202375): BE periods: `excel, original_documents, profit_and_loss, ubl, coda, pdf, amortisation_table`, full-period: `pl`. DE: `excel, original_documents, datev (plan lock "datev"), pdf, amortisation_table`, full-period `bwa`, `eur` (lock `report_PL`). List-page exports offer `excel, original_documents, pdf, ubl, datev`.
Options: `datev: {include:true, accountingCode:"skr03"|"skr04", withDocuments?:true}` (+ `original_documents:{include:true}` when DATEV with documents), `ubl: {include:true, version:"ubl21"|"ublBe"}`. Excel = CSV-like spreadsheet export (the bundle only says "excel"); no separate CSV module. `markAsExported:true` marks the bookings as exported (period export).
Default period offered by the page: previous quarter (BE) or previous month (DE) (index-CGEZy76n.js:712-720); `maxDate` = end of previous month; `minDate` = `firstTaxComputationYear` or 2020.

Poll `GET /v2/exports/{exportId}` every 1 s until done (usePerformExport-qpZJ-KUh.js:80-110):
```ts
{ export: { status: "success" | "failed" | <pending>,
            linkToFile?: string,         // full URL of the result (zip / xlsx / pdf); filename = last path segment, default "Export.zip"
            error?: ..., modules?: string[],
            result?: { chiftExport?: {expense_errors[],invoice_errors[],transaction_errors[]}, mailboxExport?: {expense_errors[],invoice_errors[]} } } }
```
**Download:** `linkToFile` is fetched directly as a blob with the browser (`downloadDocument` XHR GET `responseType: blob`, then saved as file) - no Authorization needed to be assumed since it is a signed URL **(unverified; the helper uses the axios client `j`, which may attach the Bearer token)**. If the only module is `excel` the UI does not show the "details" toast; other modules also appear in the "past exports" view `/expenses?showPastExports=true&exportId=` (E:179). Failed: `export.error` shown. For Chift/mailbox exports there is no `linkToFile`; `result.chiftExport.*_errors` list per-item failures; the status is polled by `chift-poll` (A:13973).
The expense/revenue export completion is also announced by Pusher events **(unverified)**.

### 4.3 Chift / accountant integrations
Integration slugs `horus-chift, octopus-chift, exact-chift, odoo-chift, yuki-chift, winbooks-chift` (O:3598). Integrations are managed through the accountant-workspace API `GET/POST /v3/access/workspaces/integrations`, `PATCH|PUT|DELETE /v3/access/workspaces/integrations/{id}`, `.../{id}/folders`, `.../{id}/folders/{fid}/vat-codes`, `POST .../{id}/link`, `PUT .../{id}/link/{linkId}`, `DELETE .../links/{linkId}`, `PATCH .../links/{id}/active {is_active}`, and `/v3/access/workspaces/clients/{id}/mailbox-export-settings` (useIntegrationSelectionModal-BhBXiqEJ.js:1266-1290, FolderPickerForm:1268). That belongs to the accountant/expert area. The call that actually triggers a Chift sync of expenses/revenues/transactions was not found (it posts to `/v2/exports/...` with a chift module and `chiftExportType`, tracked in chiftExportLoading.store) **(unverified)**.

---

## 5. Documents repository: `/v2/repository-documents` (verified)

Page `/repository` (DocumentsRepositoryIntro-DSs0iktd.js). Documents are generic files with AI-extracted "fields", tags, origin (`origin.process`: `minfin` = pulled from MyMinfin, otherwise manual upload).
- **List:** `GET /v2/repository-documents?{params}` (O:1985). Params: `page`, `perPage` (UI uses 10), `opened` (bool), sort + filters from the generic table store: keys seen in the UI are columns `file.name`, `created`, `dateNumber` (default sort `dateNumber desc`), `origin.process`, `tags` and filters `dateRange`, `tags` (tag ids), plus choice filters whose keys/values come from `GET /v2/repository-documents/filters` -> `{filters:[{key, values[]}]}`; free text `text` search. Exact query names for sort/filters **(unverified)** (built by the shared table helper). Response `{repositoryDocuments: Doc[], paging:{totalCount, pageCount, page}}`.
  Doc: `{_id, file:{name,path}, created, dateNumber, opened, origin:{process}, tags:[...], AISummary}`.
- **Get:** `GET /v2/repository-documents/{id}`; **fields** `GET /v2/repository-documents/{id}/fields` (array `{_id, value, ...}`; UI hides `value` null/"null"), `PATCH /v2/repository-documents/{id}/fields/{fieldId}` body = field object, `GET /v2/repository-documents/{id}/fields/bounding-boxes` (FormSlideOver-Z-f_nL68.js:251,457,785). `GET /v2/repository-documents/duplicates/{id}?perPage=9999&page=1` -> `{duplicates}` (FormSlideOver:107).
- **Update:** `PATCH /v2/repository-documents/{id}` (e.g. `{opened:true}`, tags, name) (useUpdateDocument-BnPgslJt.js:32); **delete:** `DELETE /v2/repository-documents/{id}` (:30).
- **Tags:** `GET /v2/repository-document-tags?perPage=1000000&page=1`, `POST /v2/repository-document-tags {name,color}`, `PUT /v2/repository-document-tags/{id} {name}`, `DELETE /v2/repository-document-tags/{id}` (FormSlideOver:194-240).
- **Upload (verified, 3 steps)** (DocumentsRepositoryIntro:228-242):
  1. `GET /v2/users/upload-url?category=repository-document&contentType=<mime>&n=<counter>` -> `{url:{url, fields}}`
  2. multipart `POST` to `url.url` with all `fields` then `file` (S3 presigned post; no Authorization header). Returned key = `fields.key`.
  3. **`POST /v2/repository-documents` body `{filename: <last path segment of key>, name: <original file name>}`** -> created document (the UI then opens it).
  Server also creates documents asynchronously (Pusher `repository-document.created`) e.g. from MinFin sync (`POST /v2/users/minfin/synchronize`, O:938) or the conversation drop.
- **Export:** 4.1.

## 6. `GET /v3/credit-card-statements/{id}`  (I:243357)
Returns `{ statement }` (unwrapped to `statement`). Cache key `BankTransactionsCacheKeys.CreditCardStatementById`. Fields not visible **(unverified)**. A credit-card statement is a document type that a user can classify an uploaded PDF into (instead of expense/revenue); list endpoint (`CreditCardStatementsList` cache key, I:243201) is not in this chunk **(unverified)**.

## 7. AI assistant: `/v3/conversations` (brief)
`AITA_VERSION = "1.0.2"` is added as `aita_version` to bodies (I:215440).
- `POST /v3/conversations/stream` body `{...message payload, aita_version}` creates a conversation + streamed (SSE-like) reply.
- `POST /v3/conversations/{id}/messages/stream`, `POST /v3/conversations/{id}/messages/{msgId}/stream` (regenerate), `PATCH /v3/conversations/{id}`, `PATCH /v3/conversations/{id}/messages/{msgId}`.
- `GET /v3/conversations?target=aita,tax-coach&...` list; `GET /v2/conversations/{id}`, `DELETE /v2/conversations/{id}`, `GET /v2/conversations/{id}/metadata`, `POST /v2/conversations/metadata`, `GET /v2/conversations/messages/monthly-usage`.
- `POST /v3/conversations/{id}/handover-to-tax-coach` body `{bypass_usage_limits}`; `GET /v3/conversations/authors/{id}`, `GET /v3/conversations/authors/suggested`.
Not useful for MCP (the MCP itself is the assistant).

### 7.1 `/v3/conversations/documents` (document drop; useful: AI-classified document intake)
- `POST /v3/conversations/documents` (I:204159-204161):
  ```ts
  { idempotencyKey: string,                 // "drop-<uuid v4>"
    message?: { content: string },          // optional caption
    documents: { file: { path: string /*S3 key from upload*/, name, contentType, sizeInBytes } }[], // 1..25
    conversationId?: string, aita_version: "1.0.2" }
  ```
  Response `{ conversation: { _id, ... }, batch: { messageId, status, documents[] } }` (I:204327-204340). Files first uploaded with category `document` (upload flow in section 5). Works like `createExpense` but lets the backend AI classify each file.
- `GET /v3/conversations/{conversationId}/documents[?messageId=<id>]` returns `{ batch }`; polled every 5 s while `batch.status` is `queued|processing` (I:204163, 204178-204190). Batch status computed `queued|processing|completed|completed_with_errors|failed` (I:243034-243045).
  Document item: `{_id, filename, status: queued|processing|completed|failed, classification: <doc type>, summary, targetResource: {type: expense|revenue|credit_card_statement|repository_document, id}, error, manualAction: {type: reclassify|undo, status: requested|completed, toDocumentType}, isValidated, isCreditNote, targetExists, autoValidationReasons}` (I:243063-243130). Real-time events `conversation-document.created|updated`.
- `POST /v3/conversations/{cid}/documents/{docId}/reclassify` body `{ toTargetType: "expense"|"revenue"|"revenue_ticket"|"credit_card_statement"|"repository_document" }` (I:204166, 250170-250200; `ignoreToast`). Moves the created record into another domain.
- `POST /v3/conversations/{cid}/documents/{docId}/undo` no body (I:204172): deletes/reverts the created record **(destructive)**.

## 8. `/v3/support` (all read-only except dismiss/read marks) (I:206764-206785)
`GET /v3/support/videocalls?always_send_team=true`; `POST /v3/support/expert-access/grant` (`{}`; grants temporary access of an accountable expert to the account, `ignoreToast`: **sensitive**, do not expose); `GET /v3/support/banners`, `POST /v3/support/banners/{id}/dismiss`; `GET /v3/support/custom-text`; `GET /v3/support/outbound-messages`, `POST /v3/support/outbound-messages/{id}/read`, `POST /v3/support/outbound-messages/{id}/triggered` body `{trigger}`.

## 9. Gratifications (brief)
`service$6 = "/v1/gratifications"` (I:208128): `GET /v1/gratifications/{id}`, `PUT /v1/gratifications/{id}` (body = update payload, unknown). In-app reward/onboarding "gratification" messages with i18n keys `gratifications.<n>.*` (I:210837+, `gratificationsData` I:211036). No `/v3/gratifications` found in the bundle. Not relevant to MCP.

---

## Proposed MCP tools

| tool | description | input | mode |
|---|---|---|---|
| `accountable_get_tax_year_overview` | `GET /v2/taxes/{year}?expand=document`: all obligations for a year grouped q1-q4/annual, with status, submissionStatus, failed checks, plus `meta.actionsRequired` total (= sidebar badge) and due items | `year: number` | read-only |
| `accountable_get_vat_quarter_status` | Convenience: from the above, return the `vat` item for `{year, quarter}` (or month) with `status`, `submissionStatus`, `submissionRef`, failed checks count, `isPendingIntervatUpload`, deadline | `year`, `quarter` (1-4) or `month` | read-only |
| `accountable_list_tax_items` | `GET /v2/taxes?types=&statuses=&perPage=` (e.g. closed VAT periods) | `types?: string[]`, `statuses?: string[]`, `perPage?` | read-only |
| `accountable_get_tax_breakdown` | superseded by `accountable_get_tax_item` (VAT grids live in `breakdown`/`statement`) | | read-only |
| `accountable_get_tax_submission` | `GET /v2/taxes/{taxId}/submissions/{submissionId}` | `taxId`, `submissionId`, `showBreakdown?` | read-only |
| `accountable_list_tax_check_items` | `GET /v2/taxes/{taxId}/checks/{checkId}` items that triggered a warning (to see what to fix/review) | `taxId`, `checkId`, `status: failed\|reviewed`, `page?` | read-only |
| `accountable_review_tax_check` / `accountable_undo_review_tax_check` | POST review / undo-review of a check | `taxId`, `checkId` | write |
| `accountable_set_tax_submission_status` | `PATCH /v2/taxes/{id}/submission-status` mark VAT filed / not filed (confirm with the user first) | `taxId`, `submissionStatus` | write (legal state) |
| `accountable_get_tax_calculations` | `GET /v2/calculations/taxes?year=` | `year?` | read-only |
| `accountable_list_quarter_expenses` | Reuse the expense list with `vat_period`/`tax_period` + `is_validated=false` to enumerate what is left to review in a quarter (belongs to the expenses tool; mention here) | `vat_period`, `is_validated?`, `page` | read-only |
| `accountable_create_period_export` | `POST /v2/exports` `{startDateNumber, endDateNumber, modules}` -> `{exportId}` (accountant package: excel, original_documents, pdf, ubl, datev, ...) | `startDate`, `endDate` (YYYY-MM-DD -> YYYYMMDD), `modules: string[]`, `datevAccountingCode?`, `markAsExported?` | write (creates a file) |
| `accountable_create_list_export` | `POST /v2/exports/{expenses\|revenues\|repository-documents}?{ids or filters}&includeUnvalidated=true` body `{modules}` | `kind`, `ids?`/`filters?`, `modules` | write |
| `accountable_wait_for_export` | poll `GET /v2/exports/{id}` until `success`/`failed`, return `linkToFile` (+ optionally download it) | `exportId`, `timeoutSec` | read-only |
| `accountable_get_tax_item` | `GET /v2/taxes/resource/{country}/{taxSlug}/{periodSlug}?expand=document` (VAT grids `breakdown`/`statement`, checks, submissions) | `readableType` (e.g. `be/vat`), `year`, `quarter?`/`month?` | read-only |
| `accountable_submit_tax` | `POST /v1/taxes/{id}/submit` (usecase validate/send/email) **ask the user first** | `taxId`, `usecase`, `skipGuarantee?` | write (legal) |
| `accountable_set_tax_status` | `PUT /v1/taxes/{id}` with status flipped (needs the full item first) | `taxId`, `status` | write |
| `accountable_download_file` | `GET /v2/users/file-url?filePath=` -> signed URL (VAT XML, receipts, exports) | `filePath` | read-only |
| `accountable_get_export` | `GET /v2/exports/{id}`: poll status/result/errors | `exportId` | read-only |
| `accountable_list_repository_documents` | `GET /v2/repository-documents` | `page`, `perPage`, `opened?`, `text?` | read-only |
| `accountable_upload_repository_document` | upload-url -> S3 -> `POST /v2/repository-documents {filename,name}` | local file path | write |
| `accountable_update_repository_document` / `accountable_delete_repository_document` | `PATCH` / `DELETE /v2/repository-documents/{id}` | `id`, patch | write / destructive |
| `accountable_get_repository_document` | `GET /v2/repository-documents/{id}` | `id` | read-only |
| `accountable_get_credit_card_statement` | `GET /v3/credit-card-statements/{id}` | `id` | read-only |
| `accountable_upload_documents` | 1) `GET /v2/users/upload-url?category=document&contentType=`, 2) multipart POST to S3, 3) `POST /v3/conversations/documents` (AI classifies into expense/revenue/statement/repo doc) | local file paths (1-25), `caption?` | write |
| `accountable_get_document_batch` | `GET /v3/conversations/{cid}/documents?messageId=` poll classification result and `targetResource` | `conversationId`, `messageId` | read-only |
| `accountable_reclassify_document` | POST reclassify to another target type | `conversationId`, `documentId`, `toTargetType` | write |
| `accountable_undo_document` | POST undo (removes created record) | `conversationId`, `documentId` | destructive |

Not proposed: support/expert-access grant, gratifications, conversation streaming, prepayment setup (write-heavy, unknown payload).

## What could not be determined (after the lazy-chunk update)
- Server rule for `meta.actionsRequired` per type (only client-side card logic is visible); shape of `meta.requiredActions`; exact French labels (translations are fetched at runtime, not in the bundle); `isUrgent`/`isDueSoon` day thresholds.
- Body of `PUT /v1/taxes/{id}` beyond "whole tax object with status"; response of `/v1/taxes/{id}/submit`; meaning of `validate` vs `send` for Belgian VAT (send = transmit via MinFin session, validate = produce the file **(unverified)**); the prepayment setup bodies (`/v2/taxes/*/yearly-prepayments`, `/v2/calculations/prepayment-gain`, `/v1/taxes/income-tax/details?year=`).
- Whether export endpoints accept snake_case filters; full `linkToFile` auth (signed or bearer); the Chift sync trigger request; Pusher events for exports.
- Exact sort/filter query names of the repository-documents list; the `/v2/users/minfin/synchronize` body.
- Response of `/v2/calculations/taxes`; credit-card-statement fields and list endpoint.
- `/v3/gratifications` does not exist in the bundle (only `/v1/gratifications/{id}`).
