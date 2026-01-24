# Release Automation System

This project has a complete automated release flow configured to ensure every release is automatically compiled, packaged, and published.

## Features

- ✅ **One-click release**: Use `npm run release` to complete all release steps
- ✅ **Auto compile**: Automatically clean, lint, and compile production version before release
- ✅ **Auto package**: Automatically generate VSIX package
- ✅ **Git Hooks**: Check if VSIX package exists before pushing tags
- ✅ **GitHub Actions**: Automatically publish after pushing tags
- ✅ **Version management**: Support auto-updating version number or using current version

## Quick Start

### Release New Version

```bash
# Option 1: Publish using current version number
npm run release

# Option 2: Update version number and publish
npm run release 2.1.0
```

### Complete Release Flow

1. **Preparation**
   ```bash
   # Ensure all changes are committed
   git status
   
   # Update CHANGELOG
   # Edit CHANGELOG.md
   
   # Commit CHANGELOG
   git add CHANGELOG.md
   git commit -m "docs: update changelog for v2.1.0"
   ```

2. **Execute Release**
   ```bash
   npm run release 2.1.0
   ```

3. **Verify Release**
   - Check GitHub Actions
   - Check GitHub Release

## Project Structure

```
scripts/
├── install-hooks.sh    # Install Git hooks
├── pre-version.sh      # Pre-version compile and package script
└── release.sh          # One-click release script

.github/workflows/
├── publish-ovsx.yml    # Auto publish to Open VSX
└── release.yml         # Auto create GitHub Release
```

## How It Works

### Local Release Flow

```
npm run release
    ↓
Clean build artifacts (rm -rf out *.vsix)
    ↓
Run lint check (npm run lint)
    ↓
Compile production version (npm run build:prod)
    ↓
Package VSIX (npm run package)
    ↓
Create Git tag (git tag v2.0.x)
    ↓
Push to GitHub (git push --tags)
    ↓
Trigger GitHub Actions
```

### GitHub Actions Flow

```
Detect v* tag
    ↓
┌─────────────────┬─────────────────┐
│  publish-ovsx   │   release.yml   │
│                 │                 │
│  Compile → Pack │  Compile → Pack │
│  ↓              │  ↓              │
│  Publish to VSX │  Upload Release │
└─────────────────┴─────────────────┘
```

## Git Hooks

### pre-push Hook

Automatically checks before pushing tags:
- ✅ Detect if pushing `v*` tag
- ✅ Verify VSIX package exists
- ✅ Version number matches

### Install Hooks

```bash
# Auto install (during npm install)
npm install

# Manual install
npm run postinstall
```

## Pre-Release Checklist

- [ ] All features tested
- [ ] Code passes lint check
- [ ] Updated CHANGELOG.md
- [ ] All changes committed to Git
- [ ] Version number follows semantic versioning

## Troubleshooting

### VSIX package not generated

```bash
# Clean and rebuild
rm -rf out node_modules
npm install
npm run build:prod
npm run package
```

### Tag already exists

```bash
# Delete local and remote tag
git tag -d v2.1.0
git push origin :refs/tags/v2.1.0

# Recreate
git tag v2.1.0
git push origin v2.1.0
```

### GitHub Actions failed

1. Check Actions logs
2. Verify `OVSX_TOKEN` configuration
3. Use manual publish: `npx ovsx publish -p YOUR_TOKEN`

## Related Documentation

- [Complete Publish Documentation](./PUBLISH.md)
- [CHANGELOG](../CHANGELOG.md)

## Tips

- VSIX packages are excluded in `.gitignore`, not committed to repo
- Publishing is irreversible, proceed carefully
- Version number must be unique, cannot republish
- Tags must start with `v`, e.g., `v2.0.2`
