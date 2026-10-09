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

1. Preview the workbook. This saves only new description mappings, not patients or studies.
2. Open **Admin → Import descriptions**. For each modality and exact description, explicitly select one or more exam types and optional details such as Right/Left. Select the appropriate contrast-specific exam type (`WO`, `WC`, or `WWC`). Local abbreviations and combined examinations are never guessed.
3. Refresh the preview, review demographics, separate study components, duplicates, and errors, then confirm the selected ready rows. Each component becomes its own study using its own report-template selection. Up to 10,000 expanded studies are allowed per import.

Descriptions match after case/whitespace normalization; punctuation is significant. Source study UID plus mapped component identifies duplicate studies, not patient ID. Conflicting demographics or examination details for the same UID block import; existing studies are never silently overwritten. Changing mappings or source data after preview requires another preview. Invalid/unmapped rows are not imported.

Workbook processing is local to the server. Uploaded workbooks and demographic previews are not retained as files. If Telegram is configured, optional notifications are queued persistently and sent gradually, with retry after failure; imports succeed even when Telegram is unavailable. Uncheck this option to keep the imported patient details off Telegram. Notification delivery is at-least-once: a process crash between sending and saving the message ID can cause a repeated message. Preserve `/app/db` to retain queued notifications.

### Replacing the old test database schema

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
