# RentOLedger API reference

REST API for the RentOLedger app. All endpoints are served under `API_PREFIX`
(default **`/api/v1`**). Local development: `http://localhost:4000/api/v1`.

- [Conventions](#conventions): envelope, pagination, errors, dates and money
- [Authentication](#authentication): OTP sign-in, tokens, roles
- [Endpoints](#endpoints): the full list by module
- [Business rules](#business-rules): how balances, statuses and allocation work

---

## Conventions

### Response envelope

Every JSON response uses the same shape.

```jsonc
// success
{ "success": true, "data": { ... } }

// paginated list
{ "success": true, "data": [ ... ], "meta": { "page": 1, "pageSize": 20, "total": 43, "totalPages": 3, "hasMore": true } }

// error
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Please check the highlighted fields.",
  "details": [ { "field": "phone", "message": "Enter a valid 10-digit mobile number" } ] } }
```

`DELETE` endpoints and a few actions return **204 No Content**. Create endpoints return **201**.
Every response carries an `X-Request-Id` header (a valid incoming one is reused), which also appears in the logs.

### Pagination, search and sorting

List endpoints accept `page` (default 1), `pageSize` (default 20, max 100),
`search` (up to 100 characters, where supported) and `sort` (a field name, `-` prefix for descending, e.g. `sort=-paidOn`).
Unsupported sort fields return `400 VALIDATION_ERROR` with the allowed list.
Some lists add extra aggregates to `meta` (counts per status, totals); these are listed with each endpoint.

### Errors

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body, query or path parameter failed validation; `details[]` lists the fields |
| 400 | `BAD_REQUEST` | Malformed request (invalid JSON etc.) |
| 401 | `UNAUTHORIZED` / `TOKEN_EXPIRED` | Missing/invalid access token, or it expired; refresh and retry |
| 403 | `FORBIDDEN` | Signed in but not allowed (e.g. partner calling an owner-only action, tenant calling landlord APIs) |
| 404 | `NOT_FOUND` | Record does not exist **or belongs to another account** |
| 409 | `CONFLICT` | Duplicate or business-rule conflict: unit already rented, duplicate tenant phone, deleting a record that has history, confirming a payment that is not pending, collecting on a fully paid entry |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 200 KB |
| 422 | `UNPROCESSABLE` | Reserved for input that is well-formed but cannot be processed |
| 429 | `TOO_MANY_REQUESTS` | Rate limit hit (see `Retry-After`) |
| 503 | `SERVICE_UNAVAILABLE` | Database unreachable |
| 500 | `INTERNAL_ERROR` | Unexpected failure (details only in server logs) |

### Data formats

- **IDs** are UUIDs. A malformed ID in a path returns `404 NOT_FOUND`, like an unknown one.
- **Money** is a JSON number in rupees with up to 2 decimals (`41300`, `14516.13`); stored as `NUMERIC(14,2)`.
- **Business dates** (`dueDate`, `paidOn`, `startDate`, ...) are `YYYY-MM-DD` strings in the account's time zone.
  Months are `YYYY-MM`. Timestamps (`createdAt`, ...) are ISO-8601 UTC.
- **Phone numbers** are accepted as `9876543210`, `98765 43210`, `+91 98765 43210` or E.164, and returned in E.164 (`+919876543210`).
  Indian mobile numbers are validated (10 digits starting 6-9) when the country code is +91.
- **Optional text** fields accept `""` or `null` to clear a value.

### Rate limits

| Scope | Limit (production) | Development default |
|---|---|---|
| All API routes, per IP | `RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MINUTES` (1500 / 15 min) | same |
| `/auth/otp/verify`, `/auth/refresh`, per IP | `AUTH_RATE_LIMIT_MAX` (30) per window | 300 |
| `/auth/otp/request`, per IP | 20 per hour | 500 |
| OTP codes per phone number | `OTP_MAX_PER_HOUR` (6) per hour, `OTP_RESEND_COOLDOWN_SECONDS` (30 s) between sends | 60 / 30 s |

---

## Authentication

RentOLedger signs people in with their mobile number and a one-time code (OTP).
The same person can be a **landlord** (owner or partner of an account) and/or a **tenant** (their phone number
is on a tenant record of one or more landlords).

1. `POST /auth/otp/request` `{ "phone": "9876543210" }` sends a 6-digit code by SMS.
   In development (SMS provider `console`) the response also contains `devCode`, and `npm run dev` fixes the code to `123456`.
2. `POST /auth/otp/verify` `{ "phone": "9876543210", "code": "123456" }` returns tokens and the session:

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "A6V6woWSg4KO_M9nmchB...",
    "expiresIn": 900,
    "tokenType": "Bearer",
    "isNewUser": false,
    "session": {
      "user": { "id": "…", "phone": "+919876543210", "name": "Vaibhav Dixit", "email": "vaibhav@example.com", "lateRentNotifications": true },
      "account": { "id": "…", "name": "Dixit Properties", "role": "owner", "gstEnabled": true, "gstRate": 18,
                   "timezone": "Asia/Kolkata", "reminderDaysBefore": 3, "memberCount": 2 },
      "tenancies": [],
      "modes": ["owner"],
      "defaultMode": "owner"
    }
  }
}
```

3. Send `Authorization: Bearer <accessToken>` on every other request. Access tokens are JWTs (HS256) valid for
   `ACCESS_TOKEN_TTL_SECONDS` (15 minutes).
4. When a call returns `401`, exchange the refresh token: `POST /auth/refresh` `{ "refreshToken": "…" }` returns a **new pair**.
   Refresh tokens are opaque, stored hashed, valid for `REFRESH_TOKEN_TTL_DAYS` (30) and **rotate on every use**.
   Presenting an already-used refresh token revokes that whole session (theft detection).
5. `session.modes` says which side(s) of the app the user can open: `owner` (has an account) and/or `tenant`
   (has tenancies with the tenant app enabled). A new user with neither calls `POST /auth/onboarding` to create a landlord account.

**Roles.** Landlord endpoints need an account membership. `owner` can do everything; `partner` can do everything except
manage members. Tenant-portal endpoints (`/portal/*`) need the caller's phone number to match an active tenant record with
`portalEnabled`. All data is scoped to the caller's account; IDs from other accounts return `404`.

---

## Endpoints

Legend: 🔓 public · 👤 any signed-in user · 🏠 landlord (owner/partner) · 👑 owner only · 🧾 tenant

### Health (no prefix)

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness: process is up |
| GET | `/ready` | Readiness: database reachable (503 otherwise) |
| GET | `/api/v1/health` | Liveness under the API prefix |

### Auth: `/auth`

| Method | Path | Access | Description |
|---|---|---|---|
| POST | `/auth/otp/request` | 🔓 | Send a sign-in code. Body `{ phone }`. Returns `{ phone, expiresInSeconds, resendInSeconds, devCode? }` |
| POST | `/auth/otp/verify` | 🔓 | Verify the code. Body `{ phone, code }`. Returns tokens + session (above). Wrong codes count towards `OTP_MAX_ATTEMPTS` |
| POST | `/auth/refresh` | 🔓 | Body `{ refreshToken }`. Returns a new `{ accessToken, refreshToken, expiresIn, tokenType }` |
| POST | `/auth/logout` | 🔓 | Body `{ refreshToken }`. Revokes that session |
| GET | `/auth/me` | 👤 | Current session (same shape as `session` above) |
| POST | `/auth/onboarding` | 👤 | Create a landlord account. Body `{ name, accountName?, email? }`. Returns the session |

### Users: `/users`

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/users/me` | 👤 | Current session |
| PATCH | `/users/me` | 👤 | Body `{ name?, email?, lateRentNotifications? }` |
| POST | `/users/me/logout-all` | 👤 | Revoke every refresh token of the user (sign out everywhere) |

### Account (landlord workspace): `/account`

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/account` | 🏠 | Settings: name, GST default, time zone, reminder days, payee/UPI/bank details |
| PATCH | `/account` | 🏠 | Body (all optional): `name, gstEnabled, gstRate (0-100), timezone (IANA), reminderDaysBefore (0-30), payeeName, upiId, bankAccountName, bankAccountNumber (9-18 digits), bankIfsc, bankName` |
| GET | `/account/members` | 🏠 | Owner and partners with last sign-in |
| POST | `/account/members` | 👑 | Add a partner: `{ name, phone }`. The partner signs in with that number |
| DELETE | `/account/members/:userId` | 👑 | Remove a partner |
| POST | `/account/leave` | 🏠 | A partner leaves the account (204) |
| GET | `/account/activity` | 🏠 | Audit trail. Query: `page, pageSize, entityType?, entityId?` |

### Dashboard: `/dashboard`

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/dashboard?month=YYYY-MM` | 🏠 | Month overview (defaults to the current month) |

Response `data`:

| Field | Contents |
|---|---|
| `rent` | `expected, collected, gstCollected, gstRate, collectionRate, counts{total,collected,pending,toConfirm,overdue,partial}, outstanding, outstandingPrevious, overdueAmount` |
| `portfolio` | `properties, units, occupied, vacant, reserved, occupancyRate, activeTenants, expiringAgreements` (ending within 60 days)`, monthlyRentRoll` |
| `finance` | `cashReceived, expenses, netIncome, depositsHeld` for the month |
| `overdue[]`, `toConfirm[]` | Rent entries needing attention (entry shape below) |
| `upcoming[]` | Dues in the next 30 days, including projected entries that are not generated yet (`source: "projected"`) |
| `recentPayments[]`, `recentActivity[]` | Latest transactions and audit events |
| `trend[]` | Six months ending at the selected month: `{ month, label, expected, collected }` |

### Properties: `/properties`

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/properties` | 🏠 | List with unit/occupancy counts and this month's rent. Query: pagination, `search` (name, city, address), `sort` (`name, createdAt, updatedAt, type, city`), `type`, `archived` |
| POST | `/properties` | 🏠 | Create. Body: `name, type, addressLine?, city?, state?, pincode? (6 digits), notes?, singleUnit?{ name?, type?, defaultRent?, areaSqft? }` (`singleUnit` also creates its only unit, e.g. for a house) |
| GET | `/properties/:id` | 🏠 | Detail with units (occupancy, current tenant, current rent) and income summary |
| PATCH | `/properties/:id` | 🏠 | Update any create field |
| POST | `/properties/:id/archive` | 🏠 | Hide it (409 while any unit has an active agreement) |
| POST | `/properties/:id/restore` | 🏠 | Un-archive |
| DELETE | `/properties/:id` | 🏠 | Delete (409 when it has rental or expense history; archive instead) |

`type`: `building, complex, house, shop, office, warehouse, land, other`.

### Units: `/units`

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/units` | 🏠 | Rent roll. Query: pagination, `search` (unit, property, tenant), `sort` (`name, rent, createdAt, property, dueDay`), `propertyId`, `occupancy` (`occupied, vacant, reserved`), `type`, `archived`. `meta.counts` = `{ all, occupied, vacant, reserved }` |
| POST | `/units` | 🏠 | Body: `propertyId, name, type, floor?, areaSqft?, defaultRent?, notes?` |
| GET | `/units/:id` | 🏠 | Detail: current/upcoming agreement, tenant, balance, recent entries, past tenancies |
| PATCH | `/units/:id` | 🏠 | Update |
| POST | `/units/:id/archive` · `/restore` | 🏠 | Archive (409 while rented) / restore (needs the property restored first) |
| DELETE | `/units/:id` | 🏠 | Delete (409 when it has rental history; archive instead) |

`type`: `shop, office, flat, house, room, warehouse, floor, land, other`. Occupancy is derived from agreements:
**occupied** (active agreement started), **reserved** (agreement starts in the future), **vacant**.

### Tenants: `/tenants`

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/tenants` | 🏠 | Query: pagination, `search` (name, phone, business, email, unit), `sort` (`name, createdAt, outstanding, overdue`), `status` (`active, upcoming, past, new, all`), `dues` (`any, overdue`), `archived`. Each item has `outstanding` and `overdue`. `meta.counts` per status |
| POST | `/tenants` | 🏠 | Body: `name, phone, email?, businessName?, gstin?, idProofType?, idProofNumber?, address?, emergencyContactName?, emergencyContactPhone?, notes?, portalEnabled?` (phone unique per account) |
| GET | `/tenants/:id` | 🏠 | Detail: tenant fields plus `financials { totalCharged, totalPaid, outstanding, overdue, advanceCredit, netBalance, depositHeld, pendingConfirmation }`, `agreements[]`, `openEntries[]`, `recentPayments[]` |
| GET | `/tenants/:id/statement?from&to` | 🏠 | Account statement: `tenant, from, to, openingBalance, totalCharges, totalPayments, closingBalance` and `lines[]` (charges and payments in date order with `debit`, `credit` and running `balance`) |
| PATCH | `/tenants/:id` | 🏠 | Update |
| POST | `/tenants/:id/archive` · `/restore` | 🏠 | Archive (409 with an active agreement) / restore |
| DELETE | `/tenants/:id` | 🏠 | Delete (409 when the tenant has agreements or payments; archive instead) |

### Agreements (tenancies): `/agreements`

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/agreements` | 🏠 | Query: pagination, `search` (tenant, unit, property), `sort` (`startDate, endDate, rent, createdAt, tenant`), `status` (`active, ended, all`), `unitId`, `tenantId`, `propertyId`, `expiringWithinDays` |
| POST | `/agreements` | 🏠 | Rent out a unit (see body below). Generates rent entries up to the current period |
| GET | `/agreements/:id` | 🏠 | Detail: terms, current rent (after escalation), deposit ledger, balance, entries |
| PATCH | `/agreements/:id` | 🏠 | Update terms: `endDate, rentAmount, dueDay, gstApplicable, gstRate, securityDeposit, escalationPercent, escalationIntervalMonths, proratePartialPeriods, noticePeriodDays, lockInMonths, notes`. Billing changes apply from the next billing period (a new rent also restarts the escalation clock); entries already created keep their amounts and can be adjusted one by one with `PATCH /rents/:id` |
| POST | `/agreements/:id/end` | 🏠 | Move-out: `{ endedOn, reason? }`. Bills up to the move-out date, cancels periods that start after it (money paid for them becomes credit) and pro-rates the final period when enabled |
| DELETE | `/agreements/:id` | 🏠 | Delete (409 when payments or deposits are recorded; end it instead) |
| POST | `/agreements/:id/deposits` | 🏠 | Deposit transaction: `{ type: received|refunded|deducted|applied, amount, date, method?, reference?, notes? }`. `applied` settles rent from the deposit |
| DELETE | `/agreements/:id/deposits/:txnId` | 🏠 | Remove a deposit transaction |

Create body:

```jsonc
{
  "unitId": "uuid",
  "tenantId": "uuid",                        // or "newTenant": { "name", "phone", "email?", "businessName?", "address?", "portalEnabled?" }
  "startDate": "2026-09-01",
  "endDate": null,                           // optional fixed term
  "billingStartDate": "2026-09-01",          // first period to bill; defaults to the current period (no back-billing)
  "rentAmount": 20000,
  "billingCycle": "monthly",                 // monthly | quarterly | half_yearly | yearly
  "dueDay": 5,                               // 1-31, clamped to the month length
  "gstApplicable": true, "gstRate": 18,      // default: account GST for commercial unit types
  "securityDeposit": 60000,
  "escalationPercent": 5, "escalationIntervalMonths": 12,
  "proratePartialPeriods": true,
  "noticePeriodDays": 30, "lockInMonths": 11,
  "openingBalance": { "amount": 10000, "dueDate": "2026-08-31", "description": "Dues before RentOLedger" },
  "advancePayment": { "amount": 20000, "paidOn": "2026-09-01", "method": "upi", "reference": "UTR123" },
  "depositReceived": { "amount": 60000, "date": "2026-09-01", "method": "bank_transfer" }
}
```

Only one active agreement per unit is allowed (`409` otherwise); a new agreement may start after the previous tenant's move-out date.

### Rent entries (charges / ledger): `/rents`

Every amount a tenant owes is a **rent entry**: the periodic `rent` created by the billing engine, plus one-off
`opening_balance`, `maintenance`, `utility`, `late_fee` and `other` charges.

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/rents` | 🏠 | Ledger. Query: pagination, `search` (unit, tenant, business, property, description), `sort` (`dueDate, amount, balance, unit, tenant, period, createdAt`), `month`, `status` (`all, overdue, to_confirm, pending, partial, collected, unpaid, void`), `propertyId`, `unitId`, `tenantId`, `agreementId`, `kind`. `meta.counts` per status, `meta.totals { expected, collected, outstanding, overdue, gstCollected }`, `meta.earlierDues { amount, count }` (unpaid entries from earlier months) |
| POST | `/rents` | 🏠 | Add a one-off charge: `{ agreementId, kind, description?, amount, gstApplicable?, dueDate, periodStart?, periodEnd? }` |
| POST | `/rents/generate` | 🏠 | Generate any missing entries now (normally automatic) |
| GET | `/rents/:id` | 🏠 | Entry detail with `calculation`, `payments[]`, `pendingPayments[]`, `agreement`, `actions` |
| PATCH | `/rents/:id` | 🏠 | Adjust: `{ baseAmount?, dueDate?, description?, reason? }` (GST is recalculated) |
| POST | `/rents/:id/void` | 🏠 | Cancel: `{ reason }`. Payments on it move to other dues/advance |
| POST | `/rents/:id/collect` | 🏠 | "Mark as Collected": `{ amount?, paidOn?, method, reference?, notes? }`. Defaults to the entry balance; more than the balance settles older dues then becomes advance |
| POST | `/rents/:id/remind` | 🏠 | Returns a ready reminder `{ phone, message, whatsappUrl, smsUrl, notifiedInApp }` and notifies the tenant in the app when they use it |

Entry (list item) fields:

```jsonc
{
  "id": "uuid", "agreementId": "uuid", "kind": "rent", "description": null,
  "periodStart": "2026-09-01", "periodEnd": "2026-09-30", "periodLabel": "September 2026", "month": "2026-09",
  "dueDate": "2026-09-10",
  "baseAmount": 35000, "gstRate": 18, "gstAmount": 6300, "totalAmount": 41300,
  "paidAmount": 20000,      // confirmed payments allocated to this entry
  "balance": 21300,         // totalAmount - paidAmount
  "pendingAmount": 0,       // tenant-reported payments awaiting confirmation
  "status": "overdue",      // collected | to_confirm | overdue | pending | void
  "isOverdue": true, "isPartial": true, "daysOverdue": 13,
  "tenant": { "id", "name", "phone", "businessName" }, "unit": { "id", "name", "type" }, "property": { "id", "name", "type" }
}
```

Detail adds the statement-style `calculation`:

```jsonc
"calculation": {
  "baseAmount": 35000, "gstRate": 18, "gstAmount": 6300,
  "periodTotal": 41300,     // this entry
  "previousDue": 11300,     // unpaid earlier entries, as of this period
  "totalPayable": 52600,    // previousDue + periodTotal
  "paid": 20000,            // paid towards those since the period started
  "remaining": 32600,       // totalPayable - paid
  "entryPaid": 20000, "entryBalance": 21300, "advanceCredit": 0
}
```

### Payments: `/payments`

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/payments` | 🏠 | Query: pagination, `search` (tenant, unit, reference, notes), `sort` (`paidOn, amount, createdAt, tenant`), `tenantId`, `propertyId`, `unitId`, `agreementId`, `method`, `status` (`pending, confirmed, rejected, void`), `source` (`owner, tenant, system`), `from`, `to`. `meta.summary { count, amount }` |
| POST | `/payments` | 🏠 | Record money received: `{ tenantId, agreementId?, targetChargeId?, amount, paidOn, method, reference?, notes?, status? }`. `status: "pending"` keeps a cheque "awaiting clearance" |
| GET | `/payments/:id` | 🏠 | Detail with the entries it was allocated to and the unallocated (advance) part |
| PATCH | `/payments/:id` | 🏠 | Edit `{ amount?, paidOn?, method?, reference?, notes? }`; allocations are recalculated |
| POST | `/payments/:id/confirm` | 🏠 | Confirm a tenant-reported (or pending) payment; it is allocated to dues |
| POST | `/payments/:id/reject` | 🏠 | `{ reason }`. The tenant is notified |
| POST | `/payments/:id/void` | 🏠 | `{ reason }`. Reverses a confirmed payment (kept for history) |

`method`: `cash, upi, bank_transfer, cheque, card, other` (`deposit` is system-generated when a deposit is applied).

### Expenses: `/expenses`

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/expenses/categories` | 🏠 | `[{ value, label }]` |
| GET | `/expenses` | 🏠 | Query: pagination, `search` (payee, notes, reference, property), `sort` (`date, amount, createdAt, category`), `category`, `propertyId`, `unitId`, `from`, `to`. `meta.summary { count, amount, byCategory[{ category, label, amount, count }] }` |
| POST | `/expenses` | 🏠 | `{ category, amount, expenseDate, propertyId?, unitId?, payee?, method?, reference?, notes? }` |
| GET · PATCH · DELETE | `/expenses/:id` | 🏠 | Read / update / delete |

`category`: `maintenance, repairs, property_tax, utilities, insurance, salary, society, legal, commission, cleaning, security, loan_interest, other`.

### Reports: `/reports`

All accept `from`, `to` (`YYYY-MM-DD`, default: the last 12 months) and `propertyId` unless noted.

| Method | Path | Description |
|---|---|---|
| GET | `/reports/summary` | `expected, collected, collectedOfExpected, collectionRate, gstBilled, gstCollected, outstanding, overdue, expenses, depositDeductions, netIncome, depositsHeld, entries` |
| GET | `/reports/collections?groupBy=month\|year` | Monthly or yearly collection: `series[{ period, label, fullLabel, expected, collected, collectedOfExpected, pending, expenses, net }]` and `totals` |
| GET | `/reports/pending` | Pending rent as of today: `totals { outstanding, overdue, entries, buckets }` with ageing buckets `current, d1_30, d31_60, d61_90, d90_plus`, and `tenants[]` with units, outstanding, oldest due date, days overdue and their own buckets. Query: `propertyId`, `search` |
| GET | `/reports/properties` | Property-wise income: `items[{ property, units, occupied, expected, collected, expenses, net, outstanding }]`, `unassigned` (expenses not tied to a property) and `totals` |
| GET | `/reports/expenses` | `total`, `byCategory[]`, `byProperty[]`, `byMonth[]` |
| GET | `/reports/tenants` | Tenant history (paginated): `{ tenant, units[{ name, status, startDate, endedOn }], billed, paid, payments, outstanding }`. Query adds `search`, `page`, `pageSize` |

### Notifications: `/notifications`

`audience` = `owner` (landlord feed, default) or `tenant` (tenant-app feed) for people who are both.

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/notifications` | 👤 | Query: `audience`, `page`, `pageSize`, `unreadOnly`. `meta.unread` |
| GET | `/notifications/unread-count?audience=` | 👤 | `{ unread }` |
| POST | `/notifications/read-all` | 👤 | Mark all read (`audience` in query or body) |
| POST | `/notifications/:id/read` | 👤 | Mark one read |
| DELETE | `/notifications/:id` | 👤 | Delete one |

Types: `rent_overdue`, `rent_due_soon`, `payment_submitted`, `payment_confirmed`, `payment_rejected`, `payment_recorded`,
`agreement_expiring`, `reminder`, `partner_added`.

### Tenant portal: `/portal`

For a signed-in tenant (their phone number is on one or more landlords' tenant records with the tenant app enabled).

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/portal/summary?month=` | 🧾 | "My Rent": `amountDue, arrears, advanceCredit, pending, paid, entries[], pendingPayments[], landlords[]` (landlord name, phone, payee/UPI/bank details) |
| GET | `/portal/charges` | 🧾 | History of rent entries. Query: `page, pageSize, status (all, unpaid, collected)` |
| GET | `/portal/charges/:id` | 🧾 | One entry with its payments |
| GET | `/portal/payments` | 🧾 | Payments made/reported by the tenant |
| POST | `/portal/payments` | 🧾 | "I have paid": `{ chargeId?, tenantId?, amount, paidOn, method, reference?, notes? }`. Creates a **pending** payment the landlord confirms ("To confirm") |
| DELETE | `/portal/payments/:id` | 🧾 | Withdraw a report that is still pending |

---

## Business rules

**Balances come from transactions.** Nothing like "amount due" is stored. Balances are always computed from
rent entries (`rent_charges`), confirmed payments and their allocations (`payment_allocations`), and deposit transactions.

**Billing engine.** Each active agreement produces one `rent` entry per billing period (monthly, quarterly, half-yearly
or yearly, anchored to the agreement's start month). The due date is `dueDay` of the period's first month, clamped
to the month's length (a due day of 31 in February falls on the 28th/29th). A partial first or last period is prorated by days when
`proratePartialPeriods` is on. Escalation raises rent by `escalationPercent` every `escalationIntervalMonths` from the start.
GST is `baseAmount × gstRate`. Generation is idempotent (unique `agreement_id + period_start`) and runs on every read of
the ledger/dashboard (throttled) and in the background scheduler.

**Allocation.** A confirmed payment first pays its target entry (if given), then the oldest unpaid entries (FIFO). Whatever
is left is **advance credit** and is applied automatically to the next entries as they are created. Editing or voiding a payment,
voiding an entry or changing an amount re-runs allocation for that tenant.

**Statuses** (computed in SQL with "today" in the account's time zone):

| Status | Rule |
|---|---|
| `void` | Entry was cancelled |
| `collected` | `balance = 0` |
| `to_confirm` | Unpaid and the tenant reported a payment that is waiting for confirmation |
| `overdue` | Unpaid and `dueDate < today` |
| `pending` | Unpaid and not yet due |

`isPartial` is true when something, but not all, has been paid.

**Rent entry calculation** (the design's "Rent Entry" screen):
`remaining = previousDue + periodTotal − paid`. For example, rent ₹20,000 with ₹10,000 due from before and ₹15,000 paid
leaves ₹15,000 remaining.

**Reminders.** Every `JOBS_INTERVAL_MINUTES` (a Postgres advisory lock keeps it to one instance) the scheduler generates
entries, notifies landlords and partners about overdue rent, reminds app-using tenants `reminderDaysBefore` days before
the due date and again when overdue, and warns about fixed-term agreements ending within 30 days. Every notification has a
dedupe key, so repeated runs never send duplicates.
