# St. James High School Student Behavior Tracker — Phase 6

Vercel-ready static PWA build.

Phase 6 retains the Phase 5 role workspaces, positive behaviour, student/user profile editing, Dean-only student deletion, private student photos, audit logging, and shifts 1/2.

Reliability upgrade: offline inserts, edits, and deletions now update the local IndexedDB state immediately and queue clean database payloads for synchronization when connectivity returns. Offline-only metadata is stripped before synchronization to Supabase.

Deployment: upload the contents of this folder (with `index.html` at the project root) to the existing Vercel project `student_behavior_tracker`.
