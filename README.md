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
