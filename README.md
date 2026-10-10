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

Patient demographics now belong to each study. There is no separate patient table or automatic demographic linking. Search by patient ID or name still works; repeated patient IDs do not overwrite other studies. Age is optional and stored directly with years, months, weeks, or days. Birth date is not used to infer age. Resident and attending assignments are optional.

Administrators can open **Studies → Import Excel** and upload an XLS/XLSX PACS export (first worksheet, up to 10 MB and 5,000 source rows). Required columns are `ID`, `NAME` or `SRC NAME`, `MODALITY`, `DESCRIPTION`, `STUDY DATE`, and `STUDY INST UID`. `SEX` and `AGE` are optional. DICOM ages such as `089Y` and formatted IDs with leading zeros are preserved.

1. Preview the workbook without writing any studies or mappings.
2. Review the original source modality/description, demographics, duplicates and errors, then confirm selected ready rows. Each source study UID creates **one study**, regardless of how the operator describes combined examinations. Unknown source modality labels are retained for reference and do not block import.
3. Open the study's **Recordings & reports** dialog. Upload or record as many separate dictations as needed. Each recording has its own examination configuration, report and reviewer signatures.
4. For each recording, select its modality and body-part/examination, including the appropriate contrast-specific exam type (`WO`, `WC`, or `WWC`), plus optional side/details. Save these selections, then use **Transcribe & Generate**. Transcription and report generation remain one action and require a configured template for the selected examination.

There are no description mappings or automatic clinical interpretations. The source description is reference text only; it never selects a report template. Source study UID identifies duplicates, not patient ID. Repeated workbook rows or imports are skipped. Conflicting demographics or source details for the same UID block import; existing studies are never silently overwritten. Changing source data or existing studies after preview requires another preview. Invalid rows are not imported.

Recording uploads and Telegram replies append audio instead of replacing previous recordings. Each report can be viewed, edited, printed and signed independently. Examination changes invalidate only that recording's report; signed reports must be unsigned before editing or reconfiguring. The corresponding resident/attending or an administrator signs each recording, with resident approval required before attending approval (except administrator overrides). Generation locks prevent simultaneous recording/study edits, study deletion or duplicate processing; interrupted locks expire after ten minutes.

**Telegram:** reply to the original study message with voice/audio to attach a new recording. Configure its examination and generate its report on the site; Telegram replies never start generation automatically. Study messages show recording/report counts and pending examination selections. Final-report notifications identify the recording and its selected examination. Re-delivered webhook updates do not create duplicate recordings.

Workbook processing is local to the server. Uploaded workbooks and demographic previews are not retained as files. If Telegram is configured, optional notifications are queued persistently and sent gradually, with retry after failure; imports succeed even when Telegram is unavailable. Uncheck this option to keep the imported patient details off Telegram. Notification delivery is at-least-once: a process crash between sending and saving the message ID can cause a repeated message. Preserve `/app/db` to retain queued notifications.

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
