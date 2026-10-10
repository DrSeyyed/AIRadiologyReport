# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project in the current directory
npx sv create

# create a new project in my-app
npx sv create my-app
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.

## Persistent audio storage

Browser uploads and Telegram voice recordings both default to `uploads/audio`, relative to the application's working directory. In the Docker image, this is `/app/uploads/audio`.

Persist `/app/uploads` and `/app/db` using bind mounts or named volumes. For example, these Compose volume mappings preserve audio, text reports, and the database when the container is recreated:

```yaml
volumes:
  - ./pacs/db:/app/db
  - ./pacs/uploads:/app/uploads
```

`VOICE_SAVE_DIR` still overrides the Telegram recording directory. Leave it unset to use the same location as browser uploads; if overridden, ensure that directory is also persisted.

This change applies to new recordings only. Existing files and database paths are not migrated automatically. Before removing an old container, back up recordings stored at `/uploads/voices`; recovering them into the new directory also requires updating their `audio_report_path` values in the database.

## Study-only demographics and Excel import

Patient demographics now belong to each study. There is no separate patient table or automatic demographic linking. Search by patient ID or name still works; repeated patient IDs do not overwrite other studies. Age is optional and stored directly with years, months, weeks, or days. Birth date is not used to infer age. Choose a corresponding attending when adding or importing studies. Residents are assigned independently to each recording.

Administrators can open **Studies → Import Excel** and upload an XLS/XLSX PACS export (first worksheet, up to 10 MB and 5,000 source rows). Required columns are `ID`, `NAME` or `SRC NAME`, `MODALITY`, `DESCRIPTION`, `STUDY DATE`, and `STUDY INST UID`. `SEX` and `AGE` are optional. DICOM ages such as `089Y` and formatted IDs with leading zeros are preserved.

1. Preview the workbook without writing any studies or mappings.
2. Review the original source modality/description, demographics, duplicates and errors, choose the attending for this import, then confirm selected ready rows. Each source study UID creates **one study**, regardless of how the operator describes combined examinations. Unknown source modality labels are retained for reference and do not block import.
3. Open the study's **Recordings & reports** dialog. Upload or record as many separate dictations as needed. Each recording has its own examination configuration, report and reviewer signatures.
4. For each recording, select its resident, modality and body-part/examination, including the appropriate contrast-specific exam type (`WO`, `WC`, or `WWC`), plus optional side/details. Telegram resident recordings are automatically assigned and locked to their sender. Save these selections, then use **Transcribe & Generate**. Transcription and report generation remain one action and require a configured template for the selected examination.

There are no description mappings or automatic clinical interpretations. The source description is reference text only; it never selects a report template. Source study UID identifies duplicates, not patient ID. Repeated workbook rows or imports are skipped. Conflicting demographics or source details for the same UID block import; existing studies are never silently overwritten. Changing source data or existing studies after preview requires another preview. Invalid rows are not imported.

Recording uploads and Telegram replies append audio instead of replacing previous recordings. Each report can be viewed, edited, printed and signed independently. Examination or resident changes invalidate only that recording's report; signed reports must be unsigned before editing or reconfiguring. The assigned resident signs their own recording; the corresponding study attending or an administrator may override that resident signature. Attending signatures belong to the corresponding study attending or administrator. Resident approval is required before attending approval, including administrator signatures. The actual signing user and time are recorded and displayed, so an override is not attributed to the assigned resident. An administrator may reset both signatures; otherwise unsign the attending first. Changing a study's attending is blocked while any recording is signed or processing. Generation locks prevent simultaneous recording/study edits, study deletion or duplicate processing; interrupted locks expire after ten minutes.

**Telegram:** approved residents and attendings reply to the original study message with voice/audio to attach a new recording. Resident replies automatically assign that resident; attending replies require a resident selected on the website. An attending sender never replaces the study's selected attending. Configure the recording's reviewers and examination and generate its report on the site; Telegram replies never start generation automatically. Study messages show recording/report counts and pending examination selections. Final-report notifications identify the recording and its selected examination. Re-delivered webhook updates do not create duplicate recordings.

Workbook processing is local to the server. Uploaded workbooks and demographic previews are not retained as files. If Telegram is configured, optional notifications are queued persistently and sent gradually, with retry after failure; imports succeed even when Telegram is unavailable. Uncheck this option to keep the imported patient details off Telegram. Notification delivery is at-least-once: a process crash between sending and saving the message ID can cause a repeated message. Preserve `/app/db` to retain queued notifications.

## Telegram registration and approval

New residents, attendings and typists register **only through the Telegram bot**, not the manual website user form. Existing website accounts are retained; Telegram audio requires an approved resident/attending registration linked to the sender's Telegram identity. Administrators can still create admin accounts on the website. Typists manage studies and recordings on the website; they cannot sign reports or attach Telegram audio.

1. Open a private chat with the configured bot and send `/register` (or `/start`).
2. Send your full name, then choose **Resident**, **Attending** or **Typist** using the bot's role buttons (typed role names also work), then a lowercase website username and a unique website password. The role keyboard is removed before credentials are requested. Usernames must start with a letter and contain 3–32 letters, numbers, dots, underscores or hyphens. Passwords must contain at least 8 characters and at most 72 UTF-8 bytes. `/cancel` cancels an unapproved registration; drafts expire after 30 minutes.
3. An administrator opens **Telegram approvals**, verifies the identity and role, then approves or rejects the request. The administrator can correct the requested resident/attending/typist role. Only approval creates the website user and login credentials. Applicant notifications are best-effort; approval remains saved if Telegram is unavailable.
4. After approval, sign in on the website with the chosen username/password. Residents and attendings can reply to study messages in the configured study group. Unknown, anonymous, bot, typist or unapproved senders cannot attach Telegram audio.

### Website account management

Every signed-in user can open **Account** to change their own full name, username and password. Users cannot change their own role through this page or delete their account. **Admin → Users** provides edit and remove controls for administrators, including role changes and password resets for other users. Names are 1–100 characters; credential validation matches Telegram registration. Usernames are reserved case-insensitively across accounts and pending registrations. Password changes revoke other sessions (an administrator reset revokes all of the target user's sessions).

Administrators cannot delete themselves or remove/demote the last administrator. Reassign a user's reviewer assignments before changing their role; signed/processing recordings block reviewer/signer deletion or role changes. Removing an eligible user revokes their credentials, sessions and Telegram approval, while retaining studies, recordings and uploaded files; related assignments are cleared. Deleted Telegram users can submit a new registration for approval.

Email and telephone fields are no longer stored or exposed. Startup removes old contact columns while preserving user IDs, credentials, sessions, Telegram registrations and study/report references. Back up the database before upgrading; no reset is needed. Database seeding reuses the existing administrator, even after their username is changed, rather than recreating the default login.

**Password privacy:** Telegram bot chats are not end-to-end encrypted. Use a unique password, never a password reused elsewhere. The bot tries to delete the password message immediately; deletion is best-effort and does not guarantee removal from Telegram's infrastructure. The application stores only a bcrypt hash, never plaintext passwords. Registration hashes are cleared after approval/rejection and never returned by administrator APIs. Do not enable request-body logging for this webhook.

### Required webhook authentication

Configure `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (the study group), and **`TELEGRAM_WEBHOOK_SECRET`** in the application environment. The secret must contain 1–256 ASCII letters, numbers, underscores or hyphens; use a randomly generated value. Register the **same secret** with Telegram's `setWebhook`. Existing webhook registrations must be updated: missing/mismatched secret headers are rejected, and an unset secret disables webhook processing. Ensure the reverse proxy forwards `X-Telegram-Bot-Api-Secret-Token`.

With the token/secret supplied through environment variables, register the public HTTPS endpoint (replace the example URL):

```powershell
$payload = @{
  url = 'https://your-site.example/api/telegram/webhook'
  secret_token = $env:TELEGRAM_WEBHOOK_SECRET
  allowed_updates = @('message')
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$($env:TELEGRAM_BOT_TOKEN)/setWebhook" -ContentType 'application/json' -Body $payload
```

Keep bot tokens, webhook secrets and passwords out of source control and logs. The application's `setWebhook` helper also registers the configured secret automatically. Registration happens in private chats; study audio must be a reply in `TELEGRAM_CHAT_ID`.

### Upgrading existing independent recordings

Back up the database/uploads before upgrading. Startup adds registration/reviewer metadata without deleting users, studies, recordings, reports or queued jobs. Existing recordings inherit their previous study resident once and keep signatures, but historical signer identities are not fabricated. New recordings never inherit the old shared study resident; browser uploads by a resident autoassign that resident without a Telegram lock. Previously queued anonymous voice jobs remain processable as legacy recordings; new jobs require approved sender identity. Do not reset the database for this upgrade.

### Upgrading the previous study-only version

**Back up the database and uploaded files before upgrading.** Startup automatically migrates each existing study's audio/report into an independent recording, preserving examination selection, signatures, file paths, study IDs, Telegram message IDs and queued jobs. Users, credentials, sessions, templates and reference data remain intact. Retired description-mapping tables are removed. No `RESET_TEST_STUDIES` flag is needed for this upgrade.

Previously split studies are deliberately retained as separate studies to avoid losing or merging existing work; only new Excel imports use one study per source UID. An existing UID will not be reimported. Uploaded files are neither moved nor deleted by this migration. Preserve `/app/db` and `/app/uploads` as before. Reload the browser after deployment; audio/report/signing API operations now target individual recordings.

### Replacing the older patient-linked test database schema

**Back up the database and uploaded files before upgrading.** Existing patient-linked test studies are deliberately discarded, not migrated. Users, credentials, sessions, report templates, and reference data are retained; old patient records, studies, and pending voice jobs are removed. Uploaded audio/report files are not deleted automatically.

For an existing deployment, temporarily add `RESET_TEST_STUDIES=1` to the Compose environment for one startup, rebuild/recreate the app, then remove this setting. Without explicit opt-in, startup refuses to replace the old schema. A fresh database does not require the flag. For local initialization:

```powershell
$env:RESET_TEST_STUDIES = '1'
npm run db:init
Remove-Item Env:RESET_TEST_STUDIES
```

### Tests

```shell
npm test
npm run build
```
