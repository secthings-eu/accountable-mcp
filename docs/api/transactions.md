# Bank transactions, connectors, classification and linking

Source: `research/bundle/index-DbupgLzd.js` (abbreviated `idx:LINE`). Static analysis only.

**Update (full bundle now available).** The lazy chunks are in `research/bundle/`. The bank-list page, the classification
panel and the linking views live in `index-nB-8JcPU.js` (abbrev. `nB:LINE`); connector settings/renewal live in
`index-D1RjOlPw.js` (`D1`), `RenewConnectorConsent.component-D3ZntysQ.js` (`Renew`), `useViewCardData-BsKkFhOJ.js`; list filters in
`useBankTransactionsFilters-Dt9T1ycd.js` (`Filt`). `idx:` = `index-DbupgLzd.js`. Minified names in `nB` are imports from `idx`
(e.g. `vc`=`getBulkDocUpdateKey`, `Gs`=`getMatchedItemAmounts`, `Pc`=`getDocumentTransactionCategory`, `Sc`=`getMatchedItemAmount`).
**Key result: classification and linking are done on the TRANSACTION via `PUT /v1/transactions/{id}` (single) and
`PATCH /v2/transactions/bulk` (several). The document is not patched for linking.**

Common: base URL `https://app.accountable.eu/api`; `axiosInstance` returns `response.data` (so a "response" below is the body).

---

## 1. Reading transactions

### `GET /v1/transactions` (list) - idx:255754-255772
`getTransactions(params)` builds the query string with `qs.stringify(..., {skipEmptyString: true, arrayFormat: "comma"})`
(arrays are comma-joined, empty strings dropped). Fixed/added by the client:

| query param | notes |
|---|---|
| `lang` | UI language (`en`/`fr`/`nl`/`de`), always sent |
| `expense_version` | always `3` (linked expenses are returned in v3 shape) |
| `toClassify` | UI value `"yes"` -> `"true"`, `"no"` -> `"false"` (the "A classer" filter); other/absent -> undefined (omitted) |
| `deleted` | UI value `"yes"` -> `"true"`, `"no"` -> `"false"` (hidden/deleted transactions filter) |
| `page`, `perPage` | pagination; seen at idx:288156: `getTransactions({accountNumbers: iban, page: 1, perPage: 1})` used as a cheap count |
| `accountNumbers` | IBAN(s) filtering by bank account (comma-joined list) - idx:288156 |
| `currency`, `expand` | the bank page sends `currency` (account currency) and `expand: "matchedItems"` (nB:17131-17134) |
| `page`, `sort`, plus all filter keys | see filter table below (nB:2404-2410: query = `{page, sort, ...filtersData}`) |

Response (idx:255744-255752): the body is spread as-is, with
`matchedItems` and `rawMatchedItems` run through `.filter(Boolean)` (nulls removed, i.e. these keys exist on the *response root*:
**(unverified)** most likely `matchedItems` is the transaction-level list; the code applies it to the list response root in `getTransactions`'s sibling `getTransaction`, see below).
Paging: root has `paging` with **camelCase** `{page, perPage?, totalCount, ...}` - the UI reads `data.paging.totalCount` (idx:288156-288165). The list array lives in `data` (UI reads `res.data`, cf. `ab-main-account-transaction-count` query). Contrast: `/v3/expenses` returns snake_case paging (`per_page`, `total_pages`, `total_count`) and `expenses` array.

### `GET /v1/transactions/{id}` - idx:255732-255752
`getTransaction(id, extra)`: query `lang`, `expense_version=3`, plus `extra` (comma arrays, empty skipped). Response is the transaction itself
(UI reads `.amount`, idx:269235) with `matchedItems` and `rawMatchedItems` filtered of nulls.


### List filters (wire names) - `Filt:36-58`, `nB:2404-2410`, `idx:142830`, `idx:198796`
Filter definitions come from `GET /v1/transactions/filters` (returns `[{key, values}]`); the UI keeps keys `toClassify, amountSign, transactionType, transactionCategory, period, statementPeriod, deleted` and renames three for the wire:
| UI key | wire param | value |
|---|---|---|
| `toClassify` | `toClassify` | `"true"`/`"false"` (the UI value `yes`/`no` is mapped by `getTransactions`, idx:255755; `getTransactions({toClassify:"yes"})` is how the "A classer" count is fetched, index-BvN-3bLc:2705) |
| `deleted` | `deleted` | `"true"`/`"false"` (hidden transactions) |
| `amountSign` | `amountSign` | values from the filters endpoint (sign of amount; exact values unverified, likely positive/negative) |
| `transactionType` | `transactionTypes` | comma list of `transactionType` values (e.g. `card_payment`, `withdrawal`...) |
| `transactionCategory` | `transactionCategories` | comma list of category enum ids |
| `period` | `periods` | `YYYY-MM-DD/YYYY-MM-DD` (start/end of the period, `x()` Filt:44) |
| `statementPeriod` | `statementPeriod` | credit-card accounts only (non-credit-card hides it; credit-card hides `transactionType`) |
| search box | `text` | free text; client drops it if length <= 1 (idx:142830) |
| `accountNumbers` | `accountNumbers` | IBAN of the connector (nB:17131) |
| `sort` | `sort` | `<column>_<asc|desc>`; default `valueDate_desc` (idx:198796); sortable columns: `valueDate`, `counterPartyName`, `amount` (nB:13437-13470) |
| `fields` | `fields=_id` | projection (useHasTransactions:349) |
No free amount range or explicit from/to date filters exist; date filtering is by `periods`.
List response: `{ data: Transaction[], paging: { page, pageCount|pagesCount, totalCount, perPage } }` (nB:2415-2420, 8051; `data` is the array key). Item fields: `_id, valueDate, executionDate, amount (signed, negative = outgoing), currency, baseCurrencyAmount, counterPartyName, communication, transactionType, transactionCategory, taxPeriod, matchedItems[], matchedItemsDetails[], deleted, provider, accountNumber, accountName, connectorId, modified`. Date shown = `valueDate` (fallback `executionDate`).

### Transaction object - fields the UI reads (union of idx:159806-159860, 111462, 198373, 198595-198680, 251362, 286416-286427, 243395-243401)
```ts
interface Transaction {
  _id: string;
  provider: "swan" | "ibanity" | "finAPI" | "tink" | "klarna" | "accountable" | "credit-card"; // BankProviders idx:157705
  provider_id?: string;                 // Swan transfer id; used to cancel upcoming transfers
  status?: "booked"|"rejected"|"pending"|"upcoming"|"canceled"; // TransactionStatus idx:~111240
  transactionType?: string;             // e.g. "card_payment","withdrawal","tap_to_pay","tap_to_pay_fee", sepa types
  amount: number;                       // signed, in `currency` (negative = outgoing)
  currency: string;
  baseCurrencyAmount?: number;          // signed, EUR-converted; UI prefers it when present
  counterPartyName?: string;
  communication?: string;               // free or structured (+++xxx/xxxx/xxxxx+++)
  executionDate?: string;               // ISO
  valueDate?: string;                   // ISO; UI date = valueDate || executionDate (getTransactionDate idx:198373)
  transactionCategory?: TransactionCategory;  // set when classified without a linked document
  matchedItems?: Array<{ type: "expense"|"invoice"|"credit-note"|"other-revenue"; documentId: string; isCreditNote?: boolean; amount?: number }>;
  matchedItemsDetails?: Array<Expense|Revenue>;   // expanded documents (expense_version=3 shape / revenue shape)
  rawMatchedItems?: unknown[];
  // not verified in this bundle: bank account ref / IBAN, deleted flag, isCustomSubAccount (on connector, not tx)
}
```
Derived state helpers (idx:159801-159832):
- `isMatched(tx)` = `matchedItems.length > 0`; `isCategorized(cat)` = cat in the enums below; `isClassified(tx)` = either.
- Displayed classification = `tx.transactionCategory` if categorized, else if matched: `"multiple"` when the matched items mix expense with invoice/credit-note/other-revenue, else
  `expense` -> `creditNoteOnPurchase` if `isCreditNote` else `professionalExpense`; `invoice|other-revenue` -> `professionalIncome`; `credit-note` (or `isCreditNote`) -> `creditNoteOnSales`.
- Bulk actions are disabled for a transaction that has any `matchedItems` or whose category is one of VATPayment, incomeTaxPayment, incomeTaxPrePayment, VATReimbursement, incomeTaxReimbursement, socialContributions, companyTaxPrePayment, companyTaxPayment, companyTaxReimbursement (idx:111442-111465).
- Amount a matched document represents (`getMatchedItemAmount`, idx:198656): `|baseCurrencyTotalAmountInclVAT/1000|` (negative for `type==="credit-note"`), else `|baseCurrencyAmount|`. Document amounts are stored in milli-units (x1000) for revenues.

### Transaction categories (`TransactionCategoryEnum`, idx:111299)
"With next steps" (create/link a document): `professionalIncome`, `professionalExpense`, `creditNoteOnSales`, `creditNoteOnPurchase`, `interest`, `cashback`.

"Without next steps" (pure category, no document; the "Autre" sub-types): `VATReimbursement`, `incomeTaxReimbursement`, `withholdingTaxReimbursement`,
`incomingLoan`, `incomingLoanReimbursement`, `incomingCapitalMovement`, `otherProfessionalIncomingPayment`, `realEstateActivities`, `financialIncome`, `miscellaneousActivities`,
`otherNonProfessionalIncome`, `personalIncomingPayment`, `VATPayment`, `withholdingTaxPayment`, `incomeTaxPayment`, `incomeTaxPrePayment`, `outgoingLoan`, `outgoingLoanReimbursement`,
`outgoingCapitalMovement`, `otherProfessionalOutgoingPayment`, `personalOutgoingPayment`, `socialContributions`, `personalPayment`, `VAT`, `incomeTax`, `loanRepayment`, `capitalMovement`, `other`,
`creditCardReimbursement`, `companyTaxPayment`, `companyTaxPrePayment`, `companyTaxReimbursement`, `tradeTaxPrePayment`.
(Mapping of French UI labels - "versement anticipe" = `incomeTaxPrePayment`/`companyTaxPrePayment`, "remuneration" = **(unverified)** probably `personalPayment`/`personalOutgoingPayment`, personal expense = `personalOutgoingPayment` **(unverified)** - to confirm from `fr-*.js` keys / missing chunks.)

Linking action vocabulary (`ClassificationActionTypes`, idx:111341): `create`, `import`, `scan`, `link_existing`, `classify_as`;
document types (`ClassificationDocumentTypes`): `expense`, `invoice`, `other_revenue`, `credit_note_on_sales`, `credit_note_on_purchase`.
Amplitude events show UI flows: classify-as-new-expense, classify-as-new-sales-invoice, classify-as-other-revenue, one-click classification (suggestions; cache key `SuggestedClassification`) - idx:207528-207581.

---

## 2. Classify, link, unlink, delete (all verified in `index-nB-8JcPU.js`)

### 2.0 Transaction write endpoints

**`PUT /v1/transactions/{_id}`** - `N9`, nB:6886 (hook `Xe`, nB:6887). Body = the **whole transaction object** (as read from the list/detail, `...transaction`),
with the fields to change overridden. Client always rewrites `valueDate` to `YYYY-MM-DD` (nB:6900). Extra non-model keys the UI may add: `_source`
(analytics tag, e.g. `"guessedAction"`), `shouldUpdateTaxStatus: boolean` (nB:9895-9930, only for tax categories in `transactionsTaxCategoriesMarkAsPaid`).
Returns the updated transaction. Whether the server also accepts a minimal body `{_id, transactionCategory, matchedItems}` is **not observable**; safest is GET then PUT the full object.
Writable fields used by the UI: `transactionCategory: string|null`, `matchedItems: MatchedItem[]`, `taxPeriod: {year, quarter?|month?, frequency}|null`.
```ts
type MatchedItem = {            // nB:8131-8142, idx:198618-198628 createExpenseMatchedItem/createInvoiceMatchedItem
  type: "expense" | "invoice";  // "invoice" is used for ALL revenue docs (invoice, credit-note, other-revenue)
  documentId: string;           // expense _id or revenue _id
  isCreditNote?: boolean;
  amount?: number;              // absolute amount shown in the link UI (see below)
}
```
**Link amounts**: when linking, the UI sets `amount = getMatchedItemAmount(doc)` (idx:198656): |`baseCurrencyTotalAmountInclVAT`/1000| (negative for credit-note revenue) or |`baseCurrencyAmount`| for expenses, i.e. the **document's full amount**. There is no input to edit a partial amount in the link view (nB:8157-8180); "restant à lier" is computed client-side by `getLinkingProgressAmounts` (idx:198700ff) comparing |tx amount| with the sum of the selected docs' amounts. Server-side handling of `amount` is **unverified** (it is sent back unchanged when re-saving).

**`PATCH /v2/transactions/bulk`** - `V9`, nB:7518 (hook `J1`, nB:7528). Used when several transactions are selected (bulk classify / link N tx -> one document).
```ts
{ ops: Array<{ resourceId: string /*transaction _id*/,
               body: { transactionCategory: string|null,
                       expenseId?: string,    // key = getBulkDocUpdateKey(type): "expenseId" for type "expense"
                       revenueId?: string } }> }   // "revenueId" for type "invoice"
```
`expenseId`/`revenueId` is set only if the item has `matchedItems[0]` (only the first matched item is sent; so bulk = N transactions -> exactly one document). Bulk classify without a document: `ops` with `body: {transactionCategory}` (nB:12988-13003). Bulk response not read.

**`DELETE /v2/transactions/{id}`** - `E0`, nB:6866. Panel button: for a credit-card/manual transaction it is **"Supprimer"** (nB:10049), for any other provider it is **"Masquer"/hide** (soft delete, nB:10096; the tx then has `deleted: true`, listed via `deleted=true`).
**`DELETE /v2/transactions/bulk?ids=a,b,c`** - `ai`, nB:1553 (comma arrays), bulk hide/delete from the list toolbar (nB:17932, 17958).
**`PATCH /v2/transactions/restore/bulk`** body `{ids: string[]}` - `T4`, nB:2215: un-hide ("Restaurer"; single restore uses it with `[t._id]`, nB:9560).
**`POST /v2/transactions`** - `k9`, nB:6884: create a manual credit-card transaction. Body (nB:6950-6975): `{currency:"EUR", bankAccountCurrency, transactionCategory:null, accountNumber: connector.bankAccountReference.IBAN, accountName, connectorId, provider:"credit-card", counterPartyName, amount, valueDate:"YYYY-MM-DD", communication...}` (form fields beyond those: unverified). Edit of such a tx uses the same PUT.
**`DELETE /v2/transactions/swan/{provider_id}`**: cancel upcoming Swan scheduled transfer (idx:243362).
Other reads: `GET /v2/transactions/{id}/duplicates?perPage=9999&page=1` (nB:6870; `{duplicates[], types[]}`), `GET /v1/transactions/{id}/guess?document=expense|invoice` (nB:7146-7150), `GET /v1/transactions/{id}/guess-classification-action?lang&expense_version=3` (nB:7333), `GET /v1/transactions/suggested-transaction?amount&date=YYYY-MM-DD...` (useHasTransactions:52, returns `{isFound, transaction}`), `GET /v1/transactions/filters` (Filt:36).

### 2.1 CLASSIFY (category only, no document)
`PUT /v1/transactions/{id}` with
`{ ...tx, transactionCategory: "<enum>", matchedItems: [], taxPeriod: null, _source? }` (nB:9660-9690 for plain categories; "mark as personal payment" nB:13015: `{...tx, matchedItems: [], transactionCategory}`).
Changing category always clears `matchedItems` (and `matchedItemsDetails`) unless it is the same category (nB:9514-9520, 9833-9840). Tax categories add `taxPeriod` (below).
Bulk: `PATCH /v2/transactions/bulk` with `ops[].body = {transactionCategory}`.

**Tax-period categories** (picked via a period sub-menu): `taxPeriod = {year, quarter}` (quarterly) | `{year, month}` (monthly) | `{year}` (yearly) plus `frequency: "quarterly"|"monthly"|"yearly"` (idx:166540 `dateToPeriod`, nB:9823-9850), and `transactionCategory = parent category id` (`ie = q ? fe : pe`). Frequencies: VATPayment/VATReimbursement = company VAT frequency (`taxes.vat_return_frequency`), incomeTaxPayment/incomeTaxReimbursement/companyTaxPayment/companyTaxReimbursement = yearly, incomeTaxPrePayment/companyTaxPrePayment = quarterly, socialContributions = quarterly (BE).
After the PUT, for categories in `transactionsTaxCategoriesMarkAsPaid` (VATPayment, VATReimbursement, incomeTaxPayment, incomeTaxPrePayment, incomeTaxReimbursement - idx:198763) the UI asks "mark tax item as paid?" and re-sends PUT with `shouldUpdateTaxStatus: true|false`. Side flows (optional, UI prompts): VATPayment / socialContributions then offer to **create a linked expense** (category ids from `transactionCategoryToCategoryIDMap`, BE: socialContributions -> `CATEGORY_SOCIAL_CONTRIBUTIONS`), reimbursements offer to create an `other-revenue` (nB:9850-9900).

### 2.2 Which categories the menu offers (nB:9006-9440 `Q1`; direction from sign of `amount`)
Outgoing (amount < 0): `professionalExpense` (creates/links expense), "another professional payment" -> {tax payment: `VATPayment`, `withholdingTaxPayment`, `incomeTaxPayment`, `incomeTaxPrePayment`, + country extras `companyTaxPayment`, `companyTaxPrePayment`, `socialContributions`, `tradeTaxPrePayment`(DE) ; `creditCardReimbursement`; loan: `outgoingLoan`, `outgoingLoanReimbursement`; `outgoingCapitalMovement`; `otherProfessionalOutgoingPayment`}, `creditNoteOnSales`, `personalOutgoingPayment`.
Incoming (amount > 0): `professionalIncome` (creates/links revenue), "another professional payment" -> {tax refunds: `VATReimbursement`, `incomeTaxReimbursement`, `withholdingTaxReimbursement`, `companyTaxReimbursement`; loan: `incomingLoan`, `incomingLoanReimbursement`; `incomingCapitalMovement`; `creditCardReimbursement`; `interest`/`cashback` (create other-revenue); `otherProfessionalIncomingPayment`}, non-professional income {`realEstateActivities`, `financialIncome`, `miscellaneousActivities`, `otherNonProfessionalIncome`}, `creditNoteOnPurchase`, `personalIncomingPayment`.
Legacy enum values still in `TransactionCategoryEnum` (idx:111299): `personalPayment`, `VAT`, `incomeTax`, `loanRepayment`, `capitalMovement`, `other`.
Bulk classification is disabled for tx already matched or whose category is VATPayment, incomeTaxPayment, incomeTaxPrePayment, VATReimbursement, incomeTaxReimbursement, socialContributions, companyTax{Payment,PrePayment,Reimbursement} (idx:111442).

**French labels**: the label text is NOT in the bundle (`fr-*.js` has no `payments.*` keys; translations are served at runtime). The i18n key per category is `payments.transaction_category_short.<enum>` (fallback `transactions.transaction_category_short.<enum>`), group headings `payments.payment_classification.{another_professional_payment,tax_payment,a_non_professional_income,a_professional_expense_subtitle,...}`, unclassify button `transaction.unclassify`, link/create titles `payments.payment_classification.{create_a_new_expense,link_to_an_existing_expense,link_to_an_existing_invoice,create_a_new_invoice,import_an_existing_invoice,create_other_revenue,link_to_credit_note_on_purchase,...}` (nB:7335-7440). Do not hard-code French strings; use the enum ids.

### 2.3 UNCLASSIFY ("Déclasser") (nB:9500-9515)
`PUT /v1/transactions/{id}` with `{ ...tx, matchedItems: [], taxPeriod: null, transactionCategory: null }`. Shown only when the tx is already classified (`k = nr(tx)` truthy). That is also the way to **unlink** all documents. There is no separate unlink endpoint.

### 2.4 LINK to existing expense(s) / revenue(s) ("Lier à une dépense existante") (nB:8089-8240, component `O0`)
Candidate lists come from the expense/revenue list endpoints (promiseFn per type; page size 25, `text` search, `payment: "no-payment"` for the "unpaid only" toggle, nB:8070ff).
- **Single transaction -> N documents** (checkboxes, state `h` initialised from `tx.matchedItems`; ticking appends `{type, documentId, isCreditNote, amount}`, unticking removes by documentId; already-linked docs stay in the list so they can be unticked):
  `PUT /v1/transactions/{id}` with `{ ...tx, matchedItems: h /*the FULL desired list: existing + newly ticked*/, transactionCategory: tx.transactionCategory || null }` (nB:8230). So the tx-side call **replaces** `matchedItems`; to append you must send existing items too. For a Belgian credit note on purchase/sales `isCreditNote: true`, type stays `"expense"`/`"invoice"`.
- **Several transactions -> ONE document** (radio): `PATCH /v2/transactions/bulk` with `ops = txs.map(t => ({resourceId: t._id, body: {transactionCategory: all share one category ? t.transactionCategory : getDocumentTransactionCategory(doc), expenseId|revenueId: documentId}}))` (nB:8218-8228 + 7518). Category set from the doc: expense -> `professionalExpense` (credit note -> `creditNoteOnPurchase`); invoice/other-revenue -> `professionalIncome`; credit-note -> `creditNoteOnSales` (idx:159816).
- **Category on link** (single case): the PUT keeps the existing `transactionCategory` (or null); when linking is chosen from the classification menu the menu first sets `transactionCategory` to the picked id (e.g. `professionalExpense`) and `matchedItems: []`, then opens the link view (nB:9690-9705).
- Document-side effect: server mirrors into expense `payments.transactions` / revenue `transactions`. The expense/revenue write endpoints still accept those id lists (see section 2.7) but the transaction-side PUT is what the bank page uses.

### 2.5 "Ajouter/Créer une nouvelle dépense" from a transaction (nB:9706-9735, hook `Zt` nB:7226)
Steps the UI performs:
1. `GET /v1/transactions/{id}/guess?document=expense&lang` -> `{isInvoice, guessedFrom (al_version_id), supplierName, categoryId, professionalPart, ...}` (nB:7146). (Optionally `GET /v1/expenses/categories/{country}/{categoryId}` nB:7140.)
2. Client builds a draft with `formatExpenseFromTransaction` (idx:198400-198520): `{expenseDateNumber: YYYYMMDD(valueDate||executionDate), isCreditNote: tx.amount>0, currency, currencyRate, items:[{currencyAmount:|sum|, VATRate, VATRegime, vehicle, ...category}], supplier:{name: supplierName||counterPartyName}, payments:{transactions:[txIds], cash:false, other_accounts:false}, period, taxPeriod, isValidated:true, guessed_data:{is_invoice, al_version_id, supplier:{name}, items:[{category_id, professional_part}]}}`. `documentOptions`: `{inCreditNote:false}` / `{isCreditNote:true}` for credit note on purchase.
3. The expense form opens pre-filled (`openExpenseDetails`). On save the form calls the standard **`POST /v3/expenses`** `{expense, options:{update_tax_status, create_recurrence}}` (idx:243473, see expenses doc) with `payments.transactions` containing the tx id.
4. `afterSubmit(createdExpense)` then does **`PUT /v1/transactions/{id}`** `{...tx, transactionCategory: "professionalExpense"|"creditNoteOnPurchase", matchedItems: [{type:"expense", documentId: createdExpense._id, isCreditNote}]}` (nB:9475 `Oe`, nB:9715-9733). Hence a headless client should: POST /v3/expenses (with `payments.transactions:[txId]`), then PUT the tx with the matchedItem.
Revenues ("professionalIncome"/"creditNoteOnSales"): `GET /v1/transactions/{id}/guess?document=invoice`, draft by `formatInvoiceFromTransaction` (idx:198520), invoice number from `bc`, form -> `POST /v2/revenues` (idx:165977) with `transactions:[txId]`, `status:"paid"`; afterSubmit PUT tx with `{type:"invoice", documentId, isCreditNote}`; for **other-revenue** the PUT sets `transactionCategory: null` (nB:9757-9768). The "scan/import invoice" path (`openImportRevenueModal`) uploads then the same afterSubmit.

### 2.6 Suggestions / one-click classification
`GET /v1/transactions/{id}/guess-classification-action?lang&expense_version=3` -> `{guessedAction: create|import|scan|link_existing|classify_as, guessedDocumentType: expense|invoice|other_revenue|credit_note_on_sales|credit_note_on_purchase, guessedCategory, expense?, invoice?}` (nB:7333-7345; consumed by `$9`/`L0` nB:7345-7500). Query key `SuggestedClassification`. For `classify_as`, accepting = PUT with `transactionCategory: guessedCategory` (nB:9660 `at` branch).

### 2.7 Document-side writes (still valid, not used by the bank panel for linking)
Expense: `payments.transactions: string[]` on `POST/PUT /v3/expenses[/{id}]` (idx:197688) and `PATCH /v3/expenses/{id}` `{expense:{payments:{transactions,...}}}` (idx:243596); `GET /v3/expenses/{id}?expand=payments.transactions` returns full tx objects (idx:243521). Revenue: `transactions: string[]` on `POST/PUT/PATCH /v2/revenues`, `PATCH /v2/revenues/{id}/locked` (idx:166241). Whether the server treats these as authoritative (replace) is **unverified**; they replace the whole array as sent (the UI always sends the full list).

---

## 3. Connectors (bank accounts / connections)

### `GET /v1/connectors` - idx:255731
Response body is `{data: Connector[]}` -> `getConnectors` returns `.data`. Cached under `BankTransactions:Connectors`. UI enrichments via `resolveConnectorUIProps`.
```ts
interface Connector {
  _id: string;
  provider: "swan"|"ibanity"|"finAPI"|"tink"|"klarna"|"credit-card"|"accountable";
  status: "ready"|"technicalFailure"|"authorizationFailed"|"unknownError"|"refused"|"waitingForInformation"|string;
  expiresAt?: string;                // consent expiry (null for swan/no PSD2 expiry)
  lastSynchronizationDate?: string|null;
  syncing?: boolean;
  manualSyncRequired?: boolean;
  isCustomSubAccount?: boolean;      // Swan sub-account created by user
  bankAccountReference?: { name: "main_account"|"tax_reserve_account"|string; IBAN?: string; ... };
  // plus IBAN/account number, balance {amount}, savingsGoal {amount} for swan (idx:159781ff)
}
```
Helpers (idx:159691-159760, 159830-159890):
- Accountable Bank = `provider==="swan"`; main account `bankAccountReference.name==="main_account"`; tax reserve `"tax_reserve_account"`; `BankAccountTypes = main_account|tax_reserve_account|external`.
- `getConnectorDaysLeft` = days until `expiresAt`; `didConnectorExpire` = expiresAt set and <1 day left; `isConnectorBankError` = status in [technicalFailure, authorizationFailed, unknownError]; `isConnectorSyncing` = non-swan, status ready, and (never synced or `syncing`).
- Consent rules (Belgium, ibanity, idx:159881-159895): `canRenewConsent(c)` = bank error OR (expiresAt set AND < 15 days left); `canSyncConnector(c)` = no error AND expiresAt set AND >15 days left AND provider != "accountable" AND !manualSyncRequired; max 10 external connectors, 10 credit cards. German variant at idx:199374.

### `POST /v2/connectors/{provider}/start-flow` - idx:255975-255980
Starts a PSD2 consent/connect (also used for **consent renewal**: **(unverified)** the same call with the connector/bank id).
Body (`createConnectorConnection`): `{provider, successRedirectUri, errorRedirectUri, ...extra}`; the hook sets `provider` from feature flag `banks.provider`, `successRedirectUri = origin+pathname+"?"+queryparams`, `errorRedirectUri = window.location.href`. Response `{redirectUri}`; the browser is redirected there (interactive, user must authenticate at the bank - **not automatable**).

### `POST /v2/connectors/{id}/statements` - idx:157744
Credit-card statement OCR: body `{filename, accountNumber, originalFilename}` after uploading the PDF (`uploadFile` returns `key`; `filename = key.split("/").pop()`). `GET /v3/credit-card-statements/{id}` -> `.statement` (idx:243357).

### Accountable Banking (Swan) related, for reference
`GET|PATCH /v2/accountable-banking/activation` (`{activationFurthestStepReached}`), `PATCH /v2/accountable-banking/onboarding` (+`version: 2`), `GET .../onboarding/ongoing`, `GET .../cards`, `POST .../cards/start-flow`, `GET .../cards/products`, `GET|PATCH .../tax-aside/config`, `GET .../card-cashback`, `POST .../consent-transfers/start-flow` (transfer initiation consent, idx:272923), `GET .../search-beneficiaries`, `POST .../beneficiaries/verify`, `GET .../iban/validation` (idx:255725-273588). Out of scope for bookkeeping.
Additional connector calls now found: `POST /v1/connectors/{id}/synchronize` (nB:10490, returns `{data}`), `PATCH /v1/connectors/{id}` (D1:7802, settings), `DELETE /v1/connectors/{id}` (D1:7896), `PATCH /v2/connectors/reorder?orderedConnectorIds=a,b` (D1:1972), `POST /v2/connectors/credit-card` (useViewCardData:572), `POST|PATCH|DELETE /v2/connectors/{id}/custom-sub-accounts[/{subId}]` (useViewCardData:940-951), `GET /v2/connectors/financial-institutions` (Renew:242), statements: `GET|PATCH|DELETE /v2/connectors/{id}/statements/{sid}`, `POST .../retry` (nB:10715-10778).
**Consent renewal**: `PUT /v2/connectors/{connectorId}/start-flow` body `{successRedirectUri, errorRedirectUri}` -> `{redirectUri}`; browser then navigates to it (Renew:84-90). (The earlier "POST start-flow" is for creating a new connection.)

---

## 4. Proposed MCP tools

All write tools must GET the transaction first and PUT the full object (`PUT /v1/transactions/{id}`), overriding only the fields below.

| tool | description | inputs | kind |
|---|---|---|---|
| `accountable_list_bank_accounts` | `GET /v1/connectors` -> accounts with provider, status, IBAN, balance, consent expiry, `needs_renewal` | none | read-only |
| `accountable_list_transactions` | `GET /v1/transactions` (`expand=matchedItems`, `expense_version=3`) | `accountNumbers?`, `currency?`, `toClassify?`, `deleted?`, `text?`, `periods?` (`YYYY-MM-DD/YYYY-MM-DD`), `transactionCategories?[]`, `transactionTypes?[]`, `amountSign?`, `sort?` (`valueDate|counterPartyName|amount` + `_asc|_desc`), `page`, `perPage` | read-only |
| `accountable_get_transaction` | `GET /v1/transactions/{id}` | `id` | read-only |
| `accountable_suggest_classification` | `GET /v1/transactions/{id}/guess-classification-action` | `id` | read-only |
| `accountable_classify_transaction` | PUT with `transactionCategory`, `matchedItems:[]`, optional `taxPeriod` | `id`, `category` (enum), `taxPeriod?{year,quarter?,month?,frequency}`, `markTaxPaid?` | write |
| `accountable_unclassify_transaction` | PUT `{matchedItems:[], taxPeriod:null, transactionCategory:null}` | `id` | write |
| `accountable_link_transaction_to_documents` | PUT with `matchedItems` = existing + new `{type, documentId, isCreditNote, amount}` (set `transactionCategory` to professionalExpense/Income/credit note when currently null) | `id`, `documents:[{type:"expense"|"invoice", documentId, isCreditNote?}]`, `mode: append|replace` | write |
| `accountable_unlink_transaction_document` | PUT with `matchedItems` minus given documentId | `id`, `documentId` | write |
| `accountable_bulk_classify_transactions` | `PATCH /v2/transactions/bulk` `ops[{resourceId, body:{transactionCategory}}]` | `ids[]`, `category` | write |
| `accountable_bulk_link_transactions_to_document` | `PATCH /v2/transactions/bulk` with `expenseId|revenueId` | `ids[]`, `type`, `documentId` | write |
| `accountable_create_expense_from_transaction` | `GET .../guess?document=expense`, `POST /v3/expenses` (draft per 2.5, `payments.transactions:[id]`, `isValidated:true`), then PUT tx with matchedItem | `transactionId`, overrides: `category?`, `VATRate?`, `supplierName?`, `isCreditNote?` | write |
| `accountable_create_revenue_from_transaction` | `GET .../guess?document=invoice`, `POST /v2/revenues` (status paid, `transactions:[id]`), then PUT tx | `transactionId`, `type`, `client?` | write |
| `accountable_hide_transaction` / `accountable_restore_transaction` | `DELETE /v2/transactions/{id}` (or bulk) / `PATCH /v2/transactions/restore/bulk` | `id(s)` | destructive / write |
| `accountable_cancel_scheduled_transfer` | `DELETE /v2/transactions/swan/{provider_id}` | `providerId` | destructive |
| `accountable_sync_bank_connector` | `POST /v1/connectors/{id}/synchronize` (nB:10490) | `connectorId` | write |
| `accountable_start_consent_renewal` | `PUT /v2/connectors/{id}/start-flow` returns `{redirectUri}`; user must open it | `connectorId`, redirect URIs | write (interactive) |

## 5. Remaining unknowns
- Whether the server validates/uses `matchedItems[].amount` for partial links (UI only ever sends the document's full amount) and whether a minimal PUT body (without the full transaction) is accepted.
- Response array/paging exact fields beyond `data[]` and `paging.{page,totalCount,pageCount,pagesCount}`; the filter value set of `amountSign`/`transactionTypes` (server `GET /v1/transactions/filters` returns it).
- Wire format of `amount`/date range filters beyond `periods`; no free numeric amount filter exists in the UI.
- French label strings (not shipped in the bundle).
- Bulk PATCH response shape; behavior of `expenseId`/`revenueId` when the doc already has other transactions (UI assumes server appends/overwrites per op).
