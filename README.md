# Antigravity FuelGauge

A VS Code extension for monitoring AI model quotas in real-time.

## Features

- **Dashboard View** - Visual card layout showing quota status for all models
- **QuickPick Mode** - Lightweight keyboard-navigable quota viewer
- **Status Bar Monitor** - Always-visible quota indicator with customizable formats
- **Quota Grouping** - Automatically groups models sharing the same quota pool
- **Threshold Notifications** - Alerts when quota falls below warning levels
- **Auto Wake-up** - Schedule automated requests to trigger quota resets
- **Privacy Mode** - Mask sensitive account information

## Usage

1. **Open Dashboard**: `Ctrl/Cmd+Shift+Q` or click the status bar icon
2. **Refresh**: `Ctrl/Cmd+Shift+R` when dashboard is active
3. **Configure**: Click the gear icon in the dashboard header

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `agCockpit.displayMode` | `webview` | Display mode: `webview` / `quickpick` |
| `agCockpit.refreshInterval` | `120` | Refresh interval in seconds (10-3600) |
| `agCockpit.statusBarFormat` | `standard` | Status bar display format |
| `agCockpit.warningThreshold` | `30` | Warning threshold percentage |
| `agCockpit.criticalThreshold` | `10` | Critical threshold percentage |
| `agCockpit.groupingEnabled` | `true` | Enable quota grouping |
| `agCockpit.notificationEnabled` | `true` | Enable threshold notifications |

## Installation

```bash
code --install-extension antigravity-fuelgauge-x.y.z.vsix
```

## Build from Source

```bash
npm install
npm run compile
npm run package
```

Requires Node.js v18+ and npm v9+.

## License

[MIT](LICENSE)
