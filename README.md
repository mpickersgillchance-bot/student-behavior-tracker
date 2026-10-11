# St. James High School Student Behavior Tracker — Phase 11 TextBee SMS

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
