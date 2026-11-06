Phase 15 — Editable SMS messages and clearer failure notices

Changes:
- Added editable SMS message textareas to the suspension and urgent-incident forms.
- [student name] is automatically replaced with the selected student's name before sending.
- Failed-send toast now includes the error returned by the function where available.
- Updated service-worker cache name.

Important: This frontend change does not by itself fix a TextBee gateway/API credential issue. Check Supabase Edge Function secrets and TextBee gateway/device status. Never place the TextBee API key in frontend config.js or share it in chat.
