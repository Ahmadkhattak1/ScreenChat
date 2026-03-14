# ScreenChat Extension Release SOP

## Configuration Model

The extension does not read `.env` at runtime.

Chrome extensions run from packaged files, so the live runtime backend URL comes from:

- `runtime-config.json`

The frontend `.env` file is only a build-time input for:

- `scripts/sync-runtime-config.mjs`

That script reads:

- `SCREENCHAT_BACKEND_URL`
- `SCREENCHAT_API_BASE_URLS` optional

and writes the baked runtime config used by the extension.

## Rules

1. If you change `ScreenChat/.env`, you must regenerate `runtime-config.json`.
2. Before local testing, regenerate `runtime-config.json` for the intended backend.
3. Before packaging or uploading to Chrome Web Store, regenerate `runtime-config.json` for production.
4. Treat `runtime-config.json` as the actual frontend runtime target.
5. Do not assume Railway, localhost, or any other backend switch is active until `runtime-config.json` has been rebuilt and the extension reloaded.

## Local Development

Example:

```powershell
cd C:\Users\Ahdfa\OneDrive\Desktop\Projects\Screenchat\ScreenChat
node .\scripts\sync-runtime-config.mjs
```

Then:

1. Reload the unpacked extension in `chrome://extensions`
2. Refresh the target webpage
3. Re-open ScreenChat

## Production Release

Before pushing a production extension build:

1. Set `SCREENCHAT_BACKEND_URL` in `ScreenChat/.env` to the production backend
2. Run:

```powershell
cd C:\Users\Ahdfa\OneDrive\Desktop\Projects\Screenchat\ScreenChat
node .\scripts\sync-runtime-config.mjs
```

3. Confirm `runtime-config.json` points to the production backend
4. Reload/test the unpacked extension against production
5. Run:

```powershell
cd C:\Users\Ahdfa\OneDrive\Desktop\Projects\Screenchat\ScreenChat
node .\scripts\prepare-webstore-package.mjs
```

6. Upload only the generated zip from `ScreenChat\dist\`

The packaging script refuses to build if `runtime-config.json` still points at localhost, loopback, or another private-network backend.

## Backend Contrast

Backend environment variables on Railway are real runtime env vars.

Examples:

- `OPENAI_API_KEY`
- `AI_PROVIDER`
- Firebase backend credentials

Those are different from the extension frontend config, which must be baked into the extension package before use.
