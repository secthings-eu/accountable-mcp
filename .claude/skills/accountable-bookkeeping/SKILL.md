---
name: accountable-bookkeeping
description: Methodology for doing bookkeeping in Accountable with the accountable_* MCP tools — reconcile a quarter (every bank movement backed by a document or classified), fetch and import supplier invoices, fix wrong automatic links, handle duplicates, foreign-currency invoices, refunds, document-less expenses. Use when the user asks to "match payments", "find missing invoices", "triage the bank", "prepare the VAT quarter", or import receipts.
---

# Accountable bookkeeping with the MCP

Goal of a reconciliation pass: **every bank movement in the period is either linked to a document
(expense / revenue / credit note) or classified** (personal, tax, loan, capital…), and every expense
is validated (no "Revoir") with a sensible VAT treatment. Work in this order; each step is cheap to
re-run.

## Ground rules

- Read before write. Confirm the account (`accountable_get_account_overview`) before the first write;
  never run write tests on a real account.
- Ask before: deleting anything, classifying as personal/loan/capital, changing VAT treatment,
  changing an amount. Classifying obvious professional expenses the user already called "pro" and
  linking an invoice to its payment do not need a question.
- Deletions are confirmed per item and verified first: the candidate must be the copy **without**
  a linked payment, and its twin must be linked.
- Keep the user's prior decisions (e.g. "all of these are pro", "X is a restaurant", "invoices billed
  to me personally → not an invoice") and apply them without re-asking.
- Report faithfully: what was linked, what was classified, what is still open and why.

## 0. Before a pass

If the account is new to this MCP, run `accountable_learn_suppliers` first so bank texts resolve to the
supplier names used on expenses (see the setup skill, step 4b).

## 1. Measure the backlog

`accountable_list_transactions` with `to_classify: true` for the period (page through), then group
by counterparty and amount. Separate:

- **(a) a document probably exists** — known recurring suppliers (subscriptions, SaaS, leasing, telecom, advisors);
- **(b) a document must be fetched** — invoices that live in a mailbox, a portal, a shop account, a
  photo;
- **(c) no document will exist** — personal payments, taxes, loans, reimbursements, rent patterns,
  bank fees, small restaurant/shop card payments the user accepts without a receipt.

`accountable_list_suppliers` for the year gives, per supplier, how many expenses exist and whether
they arrived automatically (Peppol, email forwarding, accountant) or manually — manual suppliers are
the ones worth a fetch module.

## 2. Link what already exists

For each (a) payment: `accountable_list_expenses` around the date (±35 days, same supplier, same
amount, or the sum for grouped debits) and `accountable_link_transaction`. Also check **shifted
links**: subscriptions where invoice N is linked to payment N+1 (visible as one orphan at each end).
Fix with `mode: "replace"` on each payment.

Pairing rule for recurring invoices: payment early in month M+1 ↔ invoice dated end of month M;
card debits usually post 1–2 days after the invoice date, the bank line carries the card date in its
communication — use it to confirm.

One payment covering several invoices: pass all expense ids in one `accountable_link_transaction`;
`remaining_to_link` must come back 0.

Refunds: classify the incoming movement as `creditNoteOnPurchase` and link it to the original
expense (same tool); it does not need its own document.

## 3. Fetch and import missing documents

1. `accountable_list_invoice_providers` → which modules are ready.
2. `accountable_fetch_invoices` (period, `detail: "missing"`) → downloads to
   `~/Documents/Invoices/<provider>/`, marks what Accountable already has (same supplier within
   3 days; for photos: a documented expense within 2 days).
3. Review what is going to be imported — open the files when in doubt (photos and email renders
   especially; the Photos search returns screenshots that merely contain "TVA").
4. `accountable_import_invoices` with the `source_refs` (or `files` for hand-downloaded PDFs,
   `YYYY-MM-DD_` filename prefix = date). It uploads, waits for OCR, applies the module's overrides,
   then links to the bank payment: same supplier/merchant text, amount within ±3 % (card FX), date
   −5…+20 days, closest first. It also corrects Accountable's own automatch (see Gotchas).
5. Read the report: `no_match` → link by hand (step 2); `validated: false` → fix with
   `accountable_update_expense` (supplier name, VAT, `is_invoice`), which also validates.

Hand-downloaded documents (portals without a module yet):
the user downloads them; name them `YYYY-MM-DD_<supplier>_<ref>.pdf` and import with `files`.

## 4. Classify what will never have a document

`accountable_classify_transaction` categories used in practice:

| Situation | Category |
|---|---|
| Private purchase on the business card, reimbursed later | `personalOutgoingPayment` (+ the reimbursement `personalIncomingPayment`) |
| Pro expense with no receipt (small card payments the user accepts as such) | `professionalExpense` |
| Advance company tax / VAT payment | `companyTaxPrePayment` / `VATPayment` with `tax_year`+`tax_quarter` |
| Social contributions paid without the notice | `socialContributions` |
| Loan between the company and a shareholder/director | `outgoingLoan` / `incomingLoan` (repayments: `…LoanReimbursement`) |
| Paid-and-refunded wash (cancelled event) | both sides personal, or `professionalExpense` + `creditNoteOnPurchase` if it was pro |
| Recurring charge agreed by contract but never invoiced (a lease or rent pattern) | a **document-less expense** per period (see 6), not a mere classification |

## 5. Expense quality (VAT, flags)

- `is_invoice: false` for receipts/invoices without the company's VAT number (consumer-app stores,
  marketplaces, order confirmations). Cost stays deductible, VAT not
  recoverable.
- Intra-EU SaaS suppliers: `vat_rate_percent: 0`, `vat_regime: "eu-reverse-charge"`. Non-EU suppliers:
  `extra-eu-supplier`.
- Foreign-currency invoices: keep the face value; pin the EUR value to the bank debit with
  `eur_amount` (sets the exchange rate so the link shows 0 remaining). Double-check the date pairing
  first (card date in the bank line).
- Tax-type categories (social contributions) need a `taxPeriod`; `accountable_update_expense`
  derives it when the API complains.
- Order confirmations are not VAT invoices: import as `is_invoice: false` and tell the user to
  request the invoice from the seller when the VAT matters.

## 6. Document-less expenses (recurring contractual charges)

Confirm the accounting treatment with the user's accountant first. Then copy the structure of an
existing, accountant-reviewed entry of the same kind (supplier name, category, VAT fields) and create
one per period, each with `payments.transactions = [tx id]`, `isValidated: true` and the `period`.
Until a `accountable_create_expense` tool exists this is done with `POST /v3/expenses` (body needs
`file: null`, `items[0]._id: null`, the `user` snapshot). Flag anything copied that looks questionable
rather than silently changing it.

## 7. Duplicates and broken OCR stubs

Symptoms: two expenses same supplier/date/amount with one unlinked; a 0.00 € expense with
`supplier: null` (OCR failed) whose file name matches an existing expense; an "unknown supplier"
stub. Procedure: `accountable_get_expense` both, compare `file.name`, `origin.process`, links →
delete the unlinked copy with `accountable_delete_expense` after the user's go-ahead. A 0.00 stub of
a *new* document is not a duplicate: fix it (supplier, amount) instead.

## 8. Close the pass

Re-run step 1 for the period: the "to classify" list should be empty or contain only items the user
explicitly deferred. Summarise: documents imported (count, suppliers), links corrected, classified
without document (by category), deleted, and the open questions for the accountant (VAT choices,
FX handling).

## Gotchas (learned on real data)

- **Server-side automatch**: right after an expense is created, Accountable links it to *a* payment
  with the same amount — often the wrong month of a subscription or another supplier's identical
  amount. The importer waits for it, picks the right payment and moves the link; when linking by hand
  after an import, always check the link that is already there.
- Bank counterparty is often generic (just the vendor group); the merchant text in the communication
  before "Paiement…" identifies the actual product.
- Expense lists filtered by `vat_period` silently drop "Revoir" expenses (no period yet): use date
  ranges.
- AliExpress: one card debit = one checkout = several orders; the order list API hides some orders,
  the module probes gaps and merges all receipts of a checkout into one PDF.
- Camoufox headed windows sometimes do not get keyboard focus until a field is clicked.
- Harness timeouts during long imports: the expense may still have been created — check before
  re-importing (the ledger records `expense_id` only on success).
