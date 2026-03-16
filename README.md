# Tab Sleeper

A Chrome extension that suspends inactive tabs to save memory. Sleeping tabs are replaced with a lightweight placeholder page and restored on demand.

## Features

- **Auto-sleep** — tabs are suspended after a configurable idle timeout (default 30 min)
- **Manual sleep** — sleep the current tab via the popup, context menu, or `Alt+S`
- **Sleep All / Wake All** — bulk actions from the popup
- **Sleeping tabs list** — see all suspended tabs and wake individual ones from the popup
- **Auto-wake** — sleeping tabs can be automatically restored after a configurable number of hours
- **Per-domain timeout** — set custom sleep delays for specific domains
- **Exclusion rules** — prevent certain domains from ever being slept
- **Never-sleep toggle** — pin the current tab so it won't be suspended
- **Site favicon** — the sleeping tab placeholder shows the original site's favicon
- **Export / Import settings** — back up or transfer your configuration as JSON
- **Badge count** — the extension icon shows the number of currently sleeping tabs

## Installation

### From source (development)

1. Clone this repository
2. Go to `chrome://extensions` and enable **Developer mode**
3. Click **Load unpacked** and select the `src/` folder

The extension will be active immediately. Click the icon in the toolbar to open settings.

### Build a distribution zip

```bash
npm install
npm run build
```

This creates `dist/tab-sleeper.zip` containing only the extension files, ready to submit to the Chrome Web Store or share.

## Usage

### Popup

| Control | Description |
|---|---|
| Sleep This Tab | Suspend the current tab immediately |
| Sleep All Tabs | Suspend all eligible tabs |
| Wake All | Restore all sleeping tabs at once |
| Never sleep this tab | Toggle to exclude the current tab permanently |
| Auto-sleep | Enable/disable automatic suspension |
| Timeout | Minutes of inactivity before a tab is slept |
| Auto-wake | Restore sleeping tabs after N hours automatically |
| Excluded domains | One domain per line — matching tabs are never slept |
| Per-domain timeout | Override the timeout for specific domains (`example.com = 60`) |
| Export / Import | Save or restore all settings as a JSON file |

### Keyboard shortcut

`Alt+S` — sleep the currently active tab. Can be changed at `chrome://extensions/shortcuts`.

### Context menu

Right-click any page for **Sleep this tab** and **Never sleep this tab** options.

## What gets skipped

The following tabs are never slept regardless of settings:

- Pinned tabs
- `chrome://` and `chrome-extension://` pages
- `about:` pages
- Tabs marked as "never sleep"
- Tabs matching an exclusion rule

## License

MIT — see [LICENSE](LICENSE)
