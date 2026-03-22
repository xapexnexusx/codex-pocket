# Codex Pocket

Codex Pocket is a local-first mobile web interface for a Mac-hosted Codex workflow.

It includes:

- Thread list and history replay
- Live prompt continuation through `codex app-server`
- Diff, plan, terminal, and approval panels
- Installable iPhone-friendly PWA shell
- First-run local password setup

## Stack

- Node.js CommonJS bridge
- `codex app-server` for live runtime control
- `.codex` session data for bootstrap and fallback replay
- Buildless PWA frontend with vanilla JavaScript and handcrafted CSS

## Quick Start

```bash
npm install
npm start
```

Open the printed URL in your browser. On first load, create the password you want to use for the bridge.

## Phone Access

To expose the bridge to devices on the same LAN:

```bash
CODEX_POCKET_HOST=0.0.0.0 npm start
```

Then open `http://YOUR-LAN-IP:47255` in Safari and enter your password.

For safer remote access, place the bridge behind a private tailnet or reverse proxy.

## Notes

- Passwords are stored locally as salted hashes in `~/.codex-pocket/auth.json`.
- Live control uses `codex app-server`.
- Fallback replay from `.codex` is best-effort and may be lossy.

## License

MIT
