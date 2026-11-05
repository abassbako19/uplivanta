# Uplivanta — bill assistance platform starter

A responsive web platform starter for people who need help with genuine bills and supporters who may choose to help. It includes a global discovery interface, public opt-in supporter directory, account-based bill submission flow, server-side moderation endpoints, Supabase schema, X sharing links, and a Paystack test-mode contribution flow connected to the Supabase Edge Functions.

## Brand note
**Uplivanta** is the selected working brand name. It has not been trademark-cleared; check trademark, company-name, domain and social-handle availability before launch. Before spending on a domain, logo, ads or incorporation, obtain a professional trademark/company-name clearance in target markets and check domain/social handles. No claim is made that this is the first platform of its kind.

## Important: not production-ready for taking money
- Payments are disabled by default. Do not collect money until a regulated payment provider has reviewed and approved this precise bill-assistance/fundraising model in writing, and qualified counsel has reviewed the applicable countries.
- Supabase payment Edge Functions (initialize-donation, verify-donation, and paystack-webhook) have been deployed separately for test-mode development. The website contribution buttons now call the deployed Supabase Edge Functions `initialize-donation` and `verify-donation`. Paystack webhook settlement remains server-side. This is test-mode wiring only; complete a real test transaction and validate all settlement and callback behavior before considering launch.
- Paystack's published international-payment eligibility guidance lists crowdfunding businesses among restricted categories. Obtain a written decision from the provider before choosing it.
- In Nigeria, payment activity is regulated. Use an appropriately licensed payment provider; do not create an in-app wallet, hold donor balances, or move funds yourself without a legal/licensing assessment.
- This starter does not implement beneficiary payouts, refunds, chargebacks, a KYC vendor, document scanning, or X OAuth login.
- The X share button opens the standard post-intent composer. X is a social distribution channel, not the payment rail. Never ask users to pay via X DMs.
- Requests are private/pending until a moderator approves them. Add a real admin user to `ADMIN_EMAILS`.

## Stack
- Node.js + Express server
- Supabase Auth + Postgres
- Server-only Supabase service-role key for moderation
- X post-intent links for sharing
- Payment provider adapter intentionally blocked until compliance sign-off

## Setup
1. Create a Supabase project.
2. In Supabase SQL Editor, run `schema.sql`.
3. Create a private Storage bucket called `bill-evidence`; configure policies after reviewing your privacy requirements.
4. Copy `.env.example` to `.env`; fill in Supabase URL, anon key and service-role key. Never expose the service-role key in browser code.
5. `public/config.js` is already populated with this project’s public Supabase URL and publishable key. These are intended for browser use; never add the service-role key to this file.
6. Add the administrator email(s) to `ADMIN_EMAILS`.
7. Run `npm install`, then `npm start`.
8. Deploy the Node server to a host that supports server-side Node applications (not static-only HTML hosting). Configure all environment variables in the host dashboard.
9. Set up HTTPS, backups, monitoring, privacy policy, terms, complaint handling, deletion process, age restrictions and security review before inviting the public.

## Admin API
- Admin interface: open `/admin.html` after configuring Supabase.
- `GET /api/supporters` — list active profiles that opted into public discovery.
- `POST /api/supporters` — create/update the signed-in user's supporter profile.
- `GET /api/admin/requests` — list pending/needs-info requests
- `POST /api/admin/requests/:id/review` with `{ "decision":"publish"|"reject"|"more_info", "note":"..." }`
- Both require a valid Supabase access token and an email in `ADMIN_EMAILS`.

## Paystack test-mode setup
- In Supabase Edge Function Secrets, set `PAYSTACK_SECRET_KEY` to the Paystack test secret (`sk_test_...`). Never put it in `public/config.js`, browser code, or Git.
- In Paystack Test Mode, set the webhook URL to `https://ydjubbdxhvuocwqwcgns.supabase.co/functions/v1/paystack-webhook`.
- Configure the Paystack callback URL to the deployed HTTPS site root so the browser can call `verify-donation` after checkout. The webhook also verifies and settles successful transactions.
- `public/config.js` must contain only the Supabase project URL and anon key.

## Payment launch gate
Before implementing the checkout adapter:
1. Present the exact product flow, countries, currencies, donor/fundraiser model, settlement destinations, fees and refund policy to a regulated PSP.
2. Obtain written approval for this model. Do not assume ordinary merchant checkout approval covers crowdfunding or charitable solicitation.
3. Get legal advice on CBN/SEC/AML/KYC, consumer protection, tax, privacy and charitable solicitation obligations in each launch country.
4. Prefer provider-managed direct-to-biller settlement where supported; otherwise use an approved custodian/escrow structure designed by counsel and the PSP.
5. Implement webhook signature verification, idempotency, reconciliation, refunds, disputes, transaction ledger, fraud monitoring and audit logs.
6. Never store card numbers, CVV, online banking passwords or donor credentials.

## X integration
The included `Share on X` button shares a public request URL through X's post composer. This requires no X API key. OAuth sign-in and posting directly to an account require an X developer app, approved API access, OAuth 2.0 PKCE, secure token storage and consent screens; not implemented in this starter.

## Known limitations
- The browser signup flow is a basic starter and needs production-grade email verification, password reset, abuse protection and UX testing.
- Upload handling is not implemented; the SQL includes a private storage reference placeholder.
- The sample request list is not seeded. It will show approved requests after the database and API are configured. Contribution checkout is available only for NGN requests and requires a signed-in user.
- Admin moderation API is present; a polished admin UI still needs to be added.
- No automated bill verification or OCR is implemented.
- No money movement is enabled.

## Suggested launch order
Nigeria closed pilot → verify operations and fraud controls → PSP/legal sign-off → small public beta → additional countries only after local review.

## Public discovery and social links
The site links to public X, LinkedIn, Instagram and web searches. It does not scrape platforms or claim public figures have joined. Uplivanta's own supporter directory contains only users who explicitly opt into public listing. Do not send bulk unsolicited messages.

## Railway deployment (prepared configuration)
This repository includes `railway.json` with the Node start command and `/api/health` health check.
1. Create a Railway project and deploy this folder/repository as a Node service.
2. Add the environment variables from `.env.example` in Railway's Variables panel. Set `PUBLIC_SITE_URL` to the deployed HTTPS URL.
3. Create/configure the Supabase project first and run `schema.sql` in its SQL Editor. Use the Supabase project URL, anon key, and service-role key as Railway variables. Keep the service-role key server-side only.
4. In Supabase Auth, configure the production site URL and allowed redirect URLs to match the deployed domain.
5. Verify `/api/health`, sign-up/sign-in, request submission, supporter opt-in, and admin moderation before inviting users.

Deployment configuration does not deploy the project or create external accounts. The Express placeholder endpoint remains disabled; the browser calls the separate Supabase Edge Functions for Paystack test mode. Do not switch to live mode or accept real funds without written provider approval, legal review, and end-to-end validation.


## Trust & Impact foundation (new)

This version adds a Trust & Impact Centre, confidential user reports, a guided FAQ assistant, a private Impact Points ledger, assistance history summaries, public request timeline API, and admin-only moderation/points-award endpoints. It also adds an identity-verification status placeholder.

### Apply the database migration

Before deploying this version, open Supabase SQL Editor for your existing project and run the complete file `migrations/001_trust_impact_features.sql`. This is additive and does not replace existing tables. Verify the SQL completes successfully.

### Important feature status

- **Impact Points:** ledger and read/award controls are implemented. Point awards are admin-only and idempotent by unique event key. Exact automatic earning rules remain unconfigured; do not award points until a reviewed event qualifies. Points are non-cash and separate from donations.
- **Trust metrics:** dashboard reports completed/total commitments only when trusted workflows populate `assistance_commitments`. It does not claim a person is scam-free or guarantee future behaviour.
- **Reports:** users can submit private account/request reports; only the reporter and authorized administrators can read them. A report is an allegation, not a finding.
- **Assistant:** the built-in assistant currently answers common platform FAQs using a guided rules-based flow. It is not a generative AI service and cannot make verification, moderation or fraud decisions.
- **Identity verification:** provider connection is intentionally not active. The API refuses identity submissions until an approved provider flow, consent, server-side credentials and verified callback handling are configured. Do not collect NIN, BVN, passport or driver's licence images through ordinary forms or chat. Store provider status/reference only; complete a privacy and data-protection review first.
- **Payments:** remain disabled. Do not set `PAYMENTS_ENABLED=true`; provider approval, compliance review, a completed secure checkout/webhook and end-to-end tests are still required.

### New admin API endpoints

- `GET /api/admin/reports` — review open/investigating reports.
- `POST /api/admin/reports/:id/review` — set `investigating`, `substantiated`, `unsubstantiated` or `dismissed`, with a review note.
- `POST /api/admin/impact-points/award` — award 1–500 points for a documented event using a unique `event_key`. Admin access uses `ADMIN_EMAILS`.

The public website does not expose raw identity documents or private reports. Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only.


## v0.3 changes: auth, Paystack on the server, face verification

**Run first:** `migrations/002_payments_auth.sql` in the Supabase SQL Editor (contributions table, settlement function, auto-profile trigger).

### Auth (Supabase)
- Header now has Sign in / Sign up / Sign out. Password reset and "resend confirmation" are included.
- In Supabase > Authentication > URL Configuration: set **Site URL** to your Railway URL and add it to **Redirect URLs**. Without this, confirmation and reset links fail.
- Supabase's built-in email sender is heavily rate-limited. For real users set up custom SMTP (Authentication > Emails > SMTP). While testing you can switch off "Confirm email".
- Railway variables needed: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PUBLIC_SITE_URL`.

### Paystack
- Checkout, verify and webhook now live in `server.js` (the old Supabase Edge Function calls were removed from the page).
- Railway variables: `PAYSTACK_SECRET_KEY`, `PAYMENTS_ENABLED=true`.
- Paystack dashboard > Settings > API Keys & Webhooks: set the webhook URL to `https://YOUR-SITE/api/webhooks/paystack`.
- Start with `sk_test_` keys. Bank transfer appears on Paystack's checkout page when enabled on your account.

### Face verification (Dojah)
- Create an EasyOnboard flow (ID + selfie/liveness), publish it, and set the four `DOJAH_*` variables.
- Subscribe the `kyc_widget` service to `https://YOUR-SITE/api/webhooks/dojah` (Dojah dashboard or `POST /api/v1/webhook/subscribe`).
- Only the status and a reference are stored. Anything the webhook does not clearly mark successful goes to `manual_review`.
- Test with a sandbox verification and check what status your webhook actually delivers before relying on it.

## v0.4.1: Impact Points experience

The Trust & Impact Centre now displays the member's current recognition level, progress to the next level, and a dated ledger of recent point awards. Recognition levels are presentation-only milestones: Getting Started (0), Active Participant (25), Community Contributor (100), Community Builder (250), and Impact Champion (500). These thresholds do not automatically award points. Point awards remain admin-only and must be tied to a reviewed, documented event with a unique event key. The points ledger API read now includes the award note.

The additive migration `migrations/004_impact_points_access.sql` tightens Data API privileges: anonymous access is removed, signed-in users may read only rows allowed by RLS, and only the server-side service role can write. This application reads point history through its authenticated server endpoint.

## v0.4: trust measurements
Run `migrations/003_trust_measurements.sql`. Five measurements now appear in the Trust & Impact Centre (yours) and on each request via the **Trust** button (public, counts only):
- **Identity status**: Identity checked / Pending / Not verified (from the Dojah result).
- **Assistance completion**: completed verified commitments out of all commitments.
- **Evidence rate**: completed cases where staff marked `has_evidence: true` (send it to `POST /api/admin/commitments`).
- **Response rate**: prompts answered out of prompts sent. A prompt is logged automatically when staff choose "more info" on a request; record replies with `POST /api/admin/prompts/:id/responded`.
- **Community reports**: received, under investigation, substantiated, cleared. Reporter identities and details are never shown.


## v0.4.2 account, assistant and test-checkout update

- The app is gated behind signup/sign-in. Email signup requires a unique username and a strong 12+ character password (upper/lowercase, number and symbol). Email confirmation is required before email/password sign-in when Supabase email confirmation is enabled.
- Username login resolves the email privately on the server and never returns the email address. Username checks and login are rate limited.
- Google, Facebook and X OAuth buttons are included; each provider must be enabled and configured in Supabase Auth with provider credentials and the production callback URL. Instagram and TikTok require custom OAuth integration and separate developer credentials; they are not falsely presented as ready.
- Assistance and supporter writes are performed server-side using the existing Railway service-role environment variable, rather than direct browser inserts blocked by RLS. Detailed database errors go to server logs without exposing secrets to users.
- The AI assistant uses the OpenAI Responses API through a server-only `OPENAI_API_KEY`. Set that key in Railway Variables; never put it in `public/config.js`. `OPENAI_MODEL` defaults to `gpt-6-luna`.
- Paystack checkout uses the existing Supabase Edge Functions and `donations` ledger. Those functions must enforce a `sk_test_` secret and the interface is clearly labelled TEST MODE. Real payments and beneficiary payouts remain disabled. Test transactions do not move real money.
- Apply `migrations/005_username_first_auth.sql` to the linked Supabase project before deploying if it has not already been applied.
