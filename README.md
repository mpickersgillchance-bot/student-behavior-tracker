# St. James High School Student Behavior Tracker — Phase 12 Suspension & Staff Improvements

Static PWA frontend using Supabase Auth/Database. This package adds an opt-in SMS send checkbox when recording a suspension and an opt-in urgent-incident SMS checkbox when recording an infraction.

## TextBee integration
- Supabase Edge Function: `send-textbee-sms` (JWT verification enabled).
- Supabase table: `public.sms_notifications` for an audit trail and idempotency.
- The TextBee API key must be configured as a Supabase Edge Function secret named `TEXTBEE_API_KEY`; do not add it to this repository or any frontend config file.
- TextBee requires a registered Android phone with an active SMS-capable SIM, online connection, verified TextBee account, and a phone number in international E.164 format.
- A successful API response means TextBee accepted/queued the SMS, not that the carrier delivered it.

## Configure the secret
In Supabase Dashboard, open Project Settings / Edge Functions / Secrets (or Edge Functions > Secrets, depending on the dashboard layout) and add:
`TEXTBEE_API_KEY` = your newly rotated TextBee API key.

Then test with a staff account that has the Dean, Principal, or Vice Principal role. The key supplied in chat should be revoked and must not be reused.

## Trigger behavior
- Suspension form: “Send suspension SMS to parent/guardian” is checked by default; uncheck it to skip SMS.
- Infraction form: “Mark as urgent and send SMS to parent/guardian” is unchecked by default; check it only for urgent incidents.
- The SMS uses a brief message asking the parent/guardian to contact the school; it does not include sensitive incident details.
- The SMS is not sent while offline. The record is still saved/queued; staff must send the notification after reconnecting.
- Parent numbers should be stored as international numbers (preferred, e.g. `+1876XXXXXXX`). Ten-digit Jamaican numbers beginning 876/658, eleven-digit numbers beginning 1, and seven-digit Jamaican local numbers are normalized in the frontend.

## Deploying the frontend
Upload the contents of the `phase10` directory to the connected Vercel/Git deployment source and deploy. The Supabase Edge Function and database migration have already been deployed separately; the live website will not use these frontend changes until this package is deployed.


## Phase 12 improvements
- Added “Place referral was made to” on the suspension form and suspension print draft. This is saved to `suspensions.referral_made_to`.
- The Active Suspensions dashboard card and report card are clickable and open a table of all currently active suspensions, including student, start/end, days, reason, and referral destination. Click the student's name to open their profile.
- Added a Dean-only “Refresh list” control in Staff Accounts to fetch the latest staff profiles. The Vice Principal profile `Joseph Haughton` with role `vice_principal` and active status was confirmed in the database on October 11, 2026. If the deployed site still doesn't show it, deploy this frontend and hard-refresh/clear the old PWA cache.
- Updated the service-worker cache name so deployed browsers can fetch the updated interface.


## Phase 13 — Student editing and login data refresh
- Added a dedicated **Edit** button to each row in the Students directory, so editing does not depend on opening the profile modal first. The Edit Student button remains available inside each profile.
- Fixed a possible duplicate startup race between Supabase session retrieval and the authentication state listener.
- Refreshes live data when opening Dashboard or Students, and re-renders after the initial data load.
- Added `positive_behaviors` to the online data-loading list so dashboard/report views can receive those records as well.
- Bumped the service-worker cache version to `stjames-behavior-v6-student-edit-login-load`; deploy this frontend package and hard-refresh the browser/PWA to use it.
