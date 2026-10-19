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

### Browser styling compatibility

The site uses Tailwind CSS 3 and DaisyUI 4, with JavaScript/CSS builds targeting Chrome and Edge 109 (the final versions available on Windows 7). Keep these styling major versions when updating dependencies: Tailwind CSS 4 requires newer browser features. The site has an explicit light theme, including fallback colors for browsers without OKLCH support. Internet Explorer is not supported; prefer a supported operating system and current browser when possible.

The green page background covers the full document. Wide study and administration tables scroll inside their own containers rather than expanding the page; the header wraps on narrow screens. Study filter controls share consistent text alignment, and favorites filters/category fields shrink to fit narrow mobile screens. Study-table Favorite and Categories buttons keep their labels on one line within the horizontally scrolling table.

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

Patient demographics now belong to each study. There is no separate patient table or automatic demographic linking. Patient names use one **Full name** field throughout study forms, lists, filters, import previews and Telegram messages; ordinary names are never guessed into first/last components. Existing first/last names are joined in their previous display order, and names stored entirely in the last-name field remain intact. Run `npm run db:init` before starting the updated app to add `study_key` and backfill `patient_fullname` without changing study IDs, recordings or signatures. **Study key** is an optional text field (up to 128 characters) on new/edit study forms; existing studies start with it blank. Legacy name columns and API inputs remain compatible. Search by patient ID or full name still works; repeated patient IDs do not overwrite other studies. Age is optional and stored directly with years, months, weeks, or days. Birth date is not used to infer age. Choose a corresponding attending when adding or importing studies. Residents are assigned independently to each recording.

Administrators, attendings and residents can open **Studies → Import studies** and upload an XLS/XLSX PACS export (first worksheet, up to 10 MB and 5,000 source rows). Required columns are `ID`, `NAME` or `SRC NAME`, `MODALITY`, `DESCRIPTION`, `STUDY DATE`, and `STUDY INST UID`. `STUDY KEY`, `SEX` and `AGE` are optional. `STUDY KEY` is shown in the import preview and stored per study as text, preserving formatted leading zeros; missing headers or blank cells are allowed. It does not replace `ID` or `STUDY INST UID` for patient codes or duplicate detection. Reimporting an existing UID still skips that study without overwriting its metadata; edit its Study key manually if needed. Both name columns contain complete names: each row uses nonblank `NAME`, falling back to `SRC NAME` only when `NAME` is blank; the two columns are never concatenated. A row with neither name is invalid. DICOM caret-separated names retain their prior display order (`FAMILY^GIVEN` becomes `GIVEN FAMILY`). DICOM ages such as `089Y` and formatted IDs with leading zeros are preserved.

### Managing body parts

Administrators can open **Admin → Body parts** to add or edit the examination/body-part list. Enter a unique, case-sensitive code (up to 64 characters) and a name (up to 200 characters), including contrast type when relevant. Entries become available in examination selectors immediately after their page is loaded or refreshed. Add a report template for each modality used with a new entry via **Templates**.

Editing retains the entry's ID and updates its labels wherever referenced, including existing recordings and templates. It does not replace imported source descriptions, change examination details/order, modify saved report text, or clear signatures. Use a new entry for a different examination rather than repurposing one already in use. Only administrators can load this management page or submit changes; deletion is not provided. No database migration is needed for this page.

### Study row colors

Study rows use light backgrounds with dark text and visible borders. Colors follow this priority: **yellow** for Needs attention (overrides other states), **red** for no recordings, **pink** while any recording is missing a resident, attending or typist signature, and **green** only when every recording has all three signatures. A legend above the table explains the colors; existing attention and signature indicators remain available. Colors update after changes are saved and the study list refreshes.

### Personal study favorites

Every signed-in user, including typists, has a private **Favorites** list. Use **☆ Favorite** on a study to save it, or **★ Saved** to remove it from Favorites and all its categories. This does not edit the study, reports or signatures.

Open **My study favorites — manage categories** to create, rename or delete categories. Category names are optional; blank names display as **Unnamed category #ID**. Use a study's **Categories** button to place it in multiple categories, or save with no categories to keep it only in the default Favorites list. Deleting a category leaves its studies in Favorites and other categories.

Choose **My favorites → All favorites** or a category in the study filters, then apply the filters. Favorites combine with the existing patient, date, reviewer, signature, sorting and pagination controls. Other users (including administrators) do not see or manage your lists. Run `npm run db:init` before restarting the upgraded app to create the favorites tables; saved lists survive restarts and repeated initialization. Removing a study or user permanently also removes its associated favorites.

### PACS viewer links

Administrators can configure **Admin → PACS viewer settings** with an HTTP(S) URL containing the literal `{studyKey}` placeholder. The default is `https://taleghanisms.pacs.sbmu.ac.ir:5010/adminpanel/LoadViewer?studyKey={studyKey}`. Leave it blank to disable links. Run `npm run db:init` before restarting to add the settings table; saved settings survive restarts and repeated initialization.

Each enabled study has an **Open PACS** action (including for typists). It opens a new browser tab with the stored Study key safely URL-encoded. If the key is missing, **Open PACS** reveals an inline Study key field. Enter the key, then select **Open PACS** to follow a normal new-tab link; no browser prompt or scripted popup is used, avoiding lost user activation while entering the key. For admins, attendings and residents, the entered key is saved through the existing study-edit API and reused on subsequent opens. Save failures are shown next to the action; existing disabled/processing protections still apply. Typists may open PACS with a temporary key, but cannot save it or edit the study. Disabled studies do not offer this action. PACS is contacted only by the user's browser, so the application server does not need PACS network access. Users sign in directly to PACS with their own browser sessions; this application neither stores PACS credentials nor reads the PACS response.

Study headings in Telegram, website dialogs and printouts use the imported `ID`/Code (`patient_code`). `Study #20` is the internal database row ID, not an imported accession number; it is shown only when the code is unavailable. Source study UID still controls duplicate detection, and internal IDs/links are unchanged. Telegram summaries and registration prompts omit repeated workflow instructions; this documentation retains the complete workflow.

1. Preview the workbook without writing any studies or mappings.
2. Review the original source modality/description, demographics, duplicates and errors, choose the attending for this import, then confirm selected ready rows. Each source study UID creates **one study**, regardless of how the operator describes combined examinations. Unknown source modality labels are retained for reference and do not block import.
3. Open the study's **Recordings & reports** dialog. Upload or record as many separate dictations as needed. Each recording has its own examination configuration, report and reviewer signatures.
4. For each recording, select its resident, **one modality**, and one or more body-part/examinations, including the appropriate contrast-specific exam types (`WO`, `WC`, or `WWC`). Add examinations in report order; use the arrow buttons to reorder or **Remove** to deselect individual entries. Each entry has its own optional side/details (up to 200 characters). The same body part can be added more than once with different details, such as left and right; reordering keeps each entry's details with it. The resident, modality and examination selectors stay aligned even when their labels wrap. Telegram resident recordings are automatically assigned and locked to their sender. Save these selections, then use **Transcribe & Generate**. Transcription and report generation remain one action and require a nonempty template for **every** selected examination under that modality.

For multiple examinations, the saved templates merge in selection order. Generation is instructed to use separate body-part headings including each entry's details, keep findings attributed to the correct examination/side, retain repeated body parts as separate entries, and produce **one shared final Conclusion** instead of individual template conclusions. Report/print titles and Telegram recording labels include each selected body part and its own details. Single-examination templates and reports retain their existing behaviour. Templates are shared by modality/examination type, so repeated entries reuse the same template; create/edit controls appear once per distinct type. The recording opens the first missing template; saving it checks for the next missing template. Changing selections, their order or any entry's details clears only that recording's report and signatures. Signed, processing and disabled recordings remain protected from configuration changes. Existing installations must run `npm run db:init` before restarting this update: the migration allows repeated body parts and copies old shared details to every existing entry without modifying saved reports or signatures. The recording configuration API accepts `examinations: [{ exam_type_id, exam_details }]` for independent details and repeated types; legacy `exam_type_id`/`exam_type_ids` with shared `exam_details` remain supported but cannot be mixed with the new payload.

Transcription supplies bilingual Persian/English radiology guidance to the existing transcription model, without forcing a single input language. It requests Persian speech with English medical terms and sequence names in Latin characters, including terms spoken with a Persian accent (such as high/low, T1/T2, hypodense/hyperdense and hypointense/hyperintense). The spelling glossary is context only, not findings to insert; instructions preserve negation, uncertainty, laterality, measurements and sequence/signal distinctions. This applies to uploaded audio, browser recordings and every appended Telegram voice part. Prompt guidance cannot guarantee recognition accuracy; check clinically important wording against the original audio.

Report generation uses British radiology terminology and UK English, follows the selected template, preserves all dictated findings, and includes a concise Conclusion. New reports request one blank line before the Conclusion; preview and print also separate existing Conclusion sections from findings and leave a blank-line gap before the resident/attending names. The prompt prohibits invented findings or recommendations and requests double-asterisk bolding only for abnormalities and recommendations, including all recommendations in the body and Conclusion. Clinical review remains required.

Administrators, attendings and residents can create and edit shared templates under **Templates**. Choose a modality and body-part/examination, then write manually or select **Generate with AI**. AI receives only the selected modality and examination, not patient data or dictation. The drafting prompt excludes adjacent regions and requests short complete sentences, one structure or system per line, without colon labels or extra sections. Review and edit the normal-findings draft, then explicitly **Save template**; generating a draft does not save it or change any report. Deleting templates remains administrator-only. Selecting a missing template in a recording opens this editor with that examination preselected. Save the template, then save the recording selections before **Transcribe & Generate**.

There are no description mappings or automatic clinical interpretations. The source description is reference text only; it never selects a report template. Source study UID identifies duplicates, not patient ID. Repeated workbook rows or imports are skipped. Conflicting demographics or source details for the same UID block import; existing studies are never silently overwritten. Changing source data or existing studies after preview requires another preview. Invalid rows are not imported.

Recording uploads and voice/audio replies directly to a Telegram study message create separate recordings instead of replacing previous recordings. Replying to an existing Telegram voice/audio message with another voice/audio message appends a part to that same recording; replies to appended parts also stay in the same recording. Only the original voice sender, assigned resident or study attending may append, and the sender must remain an approved resident or attending. Signed or processing recordings cannot receive extra audio. All parts remain individually playable on the website, in reply order. Appending does not transcribe, generate or alter the existing report: click **Transcribe & Generate** to transcribe every part in order and generate one combined report. A failed regeneration retains the previous report. Existing installations must run `npm run db:init` before using voice replies to add the audio-part and reply-mapping schema without removing existing recordings. Each report can be viewed, edited, printed and signed independently. Website previews and printouts begin with an automatic examination title from the recording's saved body-part/examination, modality and side/details (for example, **Brain MRI without contrast** or **Left Hand MRI**). Titles are not inserted into the editable report text. Previews and printouts preserve single line breaks and Markdown bold formatting, and end with the recording's assigned resident and the study's attending names, even before signing. These names are displayed separately from actual signer details and are not inserted into the editable report text. Examination or resident changes invalidate only that recording's report; signed reports must be unsigned before editing or reconfiguring. The assigned resident signs their own recording; the corresponding study attending or an administrator may override that resident signature. Attending signatures belong to the corresponding study attending, administrator or an explicitly authorised assigned resident. Administrators can edit a resident under **User Management** and check **Allow attending signature on assigned recordings**. This permission defaults off and applies only to that resident's assigned recordings; it does not change the study's attending. Revocation immediately prevents further delegated attending signature changes without removing existing signatures. Changing away from the resident role clears this permission. Resident approval is required before attending approval, including administrator signatures. The actual signing user and time are recorded and displayed, so an override is not attributed to the assigned resident. An administrator may reset both signatures; otherwise unsign the attending first. Changing a study's attending is blocked while any recording is signed or processing. Generation locks prevent simultaneous recording/study edits, study deletion or duplicate processing; interrupted locks expire after ten minutes.

**Study deletion:** **Delete** opens a confirmation dialog that checks and counts the linked Telegram voice/audio messages known to the bot, including reply chains and queued voices. If any remain, the confirmation checkbox is required before deleting them together with the study. Telegram voices are removed first, then the original study message; only after all Telegram deletions succeed is the website study removed. The bot needs permission to delete other members' messages, and Telegram may reject deletions because of its time limits. If any deletion fails, the study and its reports/signatures remain on the website as **Disabled**, read-only. The original Telegram study message is marked **DISABLED** with strikethrough where editing is permitted; an explicit warning is shown if even this edit fails. Telegram cannot disable replies to one individual message, so the bot rejects new voice replies instead of creating recordings or reports. Pending downloads cannot attach to a disabled or deleted study, and pending notifications are cancelled. Use **Retry deletion** to retry remaining messages; successfully deleted Telegram messages are not restored. Linked-message tracking survives individual website recording deletion, but Telegram does not provide a history lookup to recover message mappings already lost before this update. Run `npm run db:init` before starting the updated app to add disabled-state/message tracking and backfill retained voice mappings without removing existing studies.

**Study attention:** each study row has a **Needs attention** checkbox and an optional short description (up to 300 characters), such as repeat imaging or more clinical history. Any attending, resident or administrator can change it and click **Save**, regardless of assignment. Typists can view it but cannot change it. Unchecking the flag retains the description for reference; it can also be edited or emptied. These notes are separate from reports and signatures, and can be updated while recordings are processing or signed. Saving also updates the original Telegram study message with the attention status and description; after unchecking, the retained description is labelled as a previous note for reference. No additional Telegram message is posted. If Telegram cannot be updated, the website keeps the saved change and shows a warning. For an existing installation, run `npm run db:init` before starting the updated application to add the fields without removing existing studies.

**Printing confirmation:** after both the resident and attending have signed, print the report and check **Typist signed (printed)** in the recording card or report preview. Any typist, administrator, the recording's assigned resident or the study's corresponding attending can check or uncheck this third signature. It records the actual confirming user and time, not an assigned typist. Checking never replaces clinical approval or happens automatically when opening the print dialog. Withdrawing either clinical approval clears the printing confirmation; an administrator resetting the resident approval clears all three signatures. Study messages in Telegram update their signature counts and per-recording checked/unchecked printing marks. Printing remains available without this confirmation.

The study filters include **Resident signature**, **Attending signature** and **Typist signature**, each with All / Checked / Unchecked. Combined signature filters must match the same recording. Unchecked includes studies with at least one pending recording; studies without recordings are included only when all selected signature filters are Unchecked. The study list also shows every distinct resident assigned to its recordings. **Attending** and **Resident** selectors filter by the study's corresponding attending and a recording's assigned resident. When a resident and signature filters are combined, all selected statuses must match that resident's recording; studies without assigned recordings do not match a selected resident. Existing patient, examination, date, sort and pagination options remain available.

**Examination date** offers Today, Yesterday, Within 3 days, Within 1 week, Within 1 month (30 days), and Within 1 year (365 days). Ranges use the examination's Jalali date and today's date in Asia/Tehran, include both endpoints, and exclude future dates. Rolling ranges include today (for example, 3 days means today and the preceding 2 days); Yesterday matches only yesterday. Choose a preset and click **Filter**. The From/To fields display its bounds; editing either switches to a custom range. Saved preset URLs recalculate their bounds each time they load. Selecting All dates / custom range clears the date bounds.

Click a study-table data header to sort ascending, then click it again to sort descending. The arrow and accessible header state show the active direction. Sorting applies to all matching studies before pagination, preserves other filters and resets to page 1. Recordings/Reports and the R/A/T signature counts have separate links within their headers; My favorites sorts only your own saved status. Resident sorting uses the alphabetically ordered list of recording residents; date/time sorting includes time in the chosen direction. Age sorting compares approximate duration (years = 365.25 days, months = 30.4375 days, weeks = 7 days), not just the displayed number. Attention and Actions are not sortable. The Order By/Direction selectors remain available and reflect header sorting.

**Telegram:** approved residents and attendings reply to the original study message with voice/audio to attach a new recording. Resident replies automatically assign that resident; attending replies require a resident selected on the website. An attending sender never replaces the study's selected attending. Configure the recording's reviewers and examination and generate its report on the site; Telegram replies never start generation automatically. Study messages show recording/report counts and pending examination selections. All signature changes edit the original imported study message; signing never posts a separate final-report message. Reports remain available on the website. Re-delivered webhook updates do not create duplicate recordings.

Workbook processing is local to the server. Uploaded workbooks and demographic previews are not retained as files. If Telegram is configured, optional notifications are queued persistently and sent gradually, with retry after failure; imports succeed even when Telegram is unavailable. Uncheck this option to keep the imported patient details off Telegram. Notification delivery is at-least-once: a process crash between sending and saving the message ID can cause a repeated message. Preserve `/app/db` to retain queued notifications.

## Telegram registration and approval

New residents, attendings and typists register **only through the Telegram bot**, not the manual website user form. Existing website accounts are retained; Telegram audio requires an approved resident/attending registration linked to the sender's Telegram identity. Administrators can still create admin accounts on the website. Typists have read-only access to studies, recordings and reports on the website, except for their printing-confirmation signature. They cannot create, import, edit or delete studies, upload audio, transcribe/generate or edit reports, change clinical signatures, or attach Telegram audio.

1. Open a private chat with the configured bot and send `/register` (or `/start`).
2. Send your full name, then choose **Resident**, **Attending** or **Typist** using the bot's role buttons (typed role names also work), then a lowercase website username and a unique website password. The role keyboard is removed before credentials are requested. Usernames must start with a letter and contain 3–32 letters, numbers, dots, underscores or hyphens. Passwords must contain at least 8 characters and at most 72 UTF-8 bytes. `/cancel` cancels an unapproved registration; drafts expire after 30 minutes.
3. An administrator opens **Telegram approvals**, verifies the identity and role, then approves or rejects the request. The administrator can correct the requested resident/attending/typist role. Only approval creates the website user and login credentials. The approval/rejection notice is best-effort; approval remains saved if Telegram is unavailable. Approval also atomically queues the study group/channel invitation and saved website link for retryable Telegram delivery. Configure the website once under **Admin → Users → Telegram onboarding links**; if unset, approval still succeeds and warns that the website link was not queued.
4. After approval, sign in on the website with the chosen username/password. Residents and attendings can reply to study messages in the configured study group. Unknown, anonymous, bot, typist or unapproved senders cannot attach Telegram audio.

### Website account management

Every signed-in user can open **Account** to change their own full name, username and password. Users cannot change their own role through this page or delete their account. **Admin → Users** provides edit and remove controls for administrators, including role changes and password resets for other users. Names are 1–100 characters; credential validation matches Telegram registration. Usernames are reserved case-insensitively across accounts and pending registrations. Password changes revoke other sessions (an administrator reset revokes all of the target user's sessions).

Administrators cannot delete themselves or remove/demote the last administrator. Reassign a user's reviewer assignments before changing their role; signed/processing recordings block reviewer/signer deletion or role changes. Removing an eligible user revokes their credentials, sessions and Telegram approval, while retaining studies, recordings and uploaded files; related assignments are cleared. Deleted Telegram users can submit a new registration for approval.

Email and telephone fields are no longer stored or exposed. Startup removes old contact columns while preserving user IDs, credentials, sessions, Telegram registrations and study/report references. Back up the database before upgrading; no reset is needed. Database seeding reuses the existing administrator, even after their username is changed, rather than recreating the default login.

**Password privacy:** Telegram bot chats are not end-to-end encrypted. Use a unique password, never a password reused elsewhere. The bot tries to delete the password message immediately; deletion is best-effort and does not guarantee removal from Telegram's infrastructure. The application stores only a bcrypt hash, never plaintext passwords. Registration hashes are cleared after approval/rejection and never returned by administrator APIs. Do not enable request-body logging for this webhook.

### Study-group and website links

In **Admin → Users**, select users and click **Send group link**. Accounts without a Telegram ID, including unlinked administrators, cannot be selected; linked administrators are eligible. The bot privately sends a **Join study group** button for the configured `TELEGRAM_CHAT_ID`. It reuses the public/existing invite link and creates one only if none is available. For private groups, the bot needs administrator invitation permissions. Recipients must have started the bot and not blocked it.

Set the full HTTP/HTTPS **Website link** under **Telegram onboarding links** in **Admin → Users**, then click **Save website link**. This database-backed setting survives reloads/restarts and can be changed or cleared by administrators. Future approvals and selected-user **Send website link** actions use this saved address; there is no need to re-enter it for each send. Already queued messages retain their original address. Clearing the setting disables website sends and causes approvals to warn instead of queuing a website link. The bot privately sends the saved address and an **Open website** button; this does not create accounts, bypass login, or send passwords. Website delivery needs `TELEGRAM_BOT_TOKEN` but no study-group invite permissions or `TELEGRAM_CHAT_ID`. Website and group links have independent status columns and queues; a pending link cannot be replaced until delivery completes or fails. Run `npm run db:init` before starting the upgraded application to create the website-link queue without changing existing invitations.

Approval queues links without contacting Telegram inside the account-creation transaction. The group/channel link is resolved by the worker, so temporary invite lookup failures are retried without losing the approval or queued invitation. Delivery runs in a persistent background queue with **Queued**, **Sent** and **Failed** statuses. Pending selections are not duplicated; sent/failed invitations can be explicitly resent. Temporary errors are retried up to five attempts, and Telegram rate-limit delays pause delivery. Deleted or relinked accounts are not sent stale invitations. Preserve `/app/db` to retain the queue across rebuilds. Delivery is at least once: a crash immediately after Telegram accepts a message can cause a repeat.

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

Back up the database/uploads before upgrading. Startup (or `npm run db:init`) adds ordered per-recording examination selections and backfills each existing singular examination without changing reports or signatures. Repeated initialisation preserves saved multi-examination order; reload the browser after deployment. Startup adds registration/reviewer metadata and the per-recording typist confirmation fields without deleting users, studies, recordings, reports or queued jobs. Existing printing confirmations start unchecked; existing resident/attending signatures are preserved. Existing recordings inherit their previous study resident once and keep signatures, but historical signer identities are not fabricated. New recordings never inherit the old shared study resident; browser uploads by a resident autoassign that resident without a Telegram lock. Previously queued anonymous voice jobs remain processable as legacy recordings; new jobs require approved sender identity. Do not reset the database for this upgrade.

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
