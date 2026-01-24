# Publishing Guide

## Quick Release (Recommended)

Use the one-click release script for automated compile, package, and publish:

```bash
# Option 1: Publish using current version number (from package.json)
npm run release

# Option 2: Update version number and publish
npm run release 2.1.0
```

**The script will automatically:**
1. ✅ Clean old build artifacts
2. ✅ Run lint checks
3. ✅ Compile production version
4. ✅ Package VSIX
5. ✅ Create Git tag
6. ✅ Push to GitHub

---

## Complete Release Flow

### Step 1: Prepare Release

```bash
# 1. Ensure all changes are committed
git status

# 2. Update CHANGELOG (important!)
# Edit CHANGELOG.md with new version content

# 3. Commit CHANGELOG
git add CHANGELOG.md
git commit -m "docs: update changelog for v2.1.0"
```

### Step 2: Execute Release

```bash
# Use release script (recommended)
npm run release 2.1.0

# Or run manually
./scripts/release.sh 2.1.0
```

### Step 3: Verify Release

1. **Check GitHub Actions progress**
   - Confirm workflows completed successfully

2. **Check GitHub Release**
   - Verify new version is published and VSIX package is uploaded

---

## Automation Setup

### Git Hooks

The project has Git hooks configured to check before pushing tags:

- **pre-push hook**: Checks if VSIX package exists when pushing tags
- **Auto-install**: Hooks are installed automatically when running `npm install`

Manual hook installation:
```bash
npm run postinstall
# or
bash scripts/install-hooks.sh
```

### GitHub Actions

Two automated workflows are configured:

1. **publish-ovsx.yml**: Publish to Open VSX Registry
   - Trigger: Push `v*` tag
   - Steps: Compile → Package → Publish to Open VSX

2. **release.yml**: Create GitHub Release
   - Trigger: Push `v*` tag
   - Steps: Compile → Package → Upload VSIX to Release

### GitHub Secrets

Configured Secrets:
- `OVSX_TOKEN`: Open VSX Registry Personal Access Token

---

## Pre-Release Checklist

- [ ] All features tested
- [ ] Code passes lint check (`npm run lint`)
- [ ] Updated `CHANGELOG.md`
- [ ] Updated `package.json` version field (if not using parameter publish)
- [ ] All changes committed to Git
- [ ] Tag version matches `package.json`

---

## Version Numbering

Follow Semantic Versioning:

- **Major**: Incompatible API changes
  - Example: `v2.0.0` → `v3.0.0`
  
- **Minor**: Backwards-compatible new features
  - Example: `v2.0.0` → `v2.1.0`
  
- **Patch**: Backwards-compatible bug fixes
  - Example: `v2.0.0` → `v2.0.1`

---

## Manual Publishing (Backup)

If automated scripts fail, publish manually:

```bash
# 1. Compile production version
npm run build:prod

# 2. Package VSIX
npm run package

# 3. Create tag
git tag v2.1.0
git push origin v2.1.0

# 4. Manually publish to Open VSX (if GitHub Actions fails)
npx ovsx publish -p YOUR_TOKEN
```

---

## Notes

1. **Tags must start with `v`**, e.g., `v2.0.2`
2. **Version must be unique**, cannot republish same version
3. **Publishing is irreversible**, proceed carefully
4. **VSIX packages are not committed to Git**, excluded in `.gitignore`
5. **View publish logs**: GitHub repository → Actions tab

---

## Troubleshooting

### Problem: GitHub Actions publish failed

**Solution:**
1. Check if `OVSX_TOKEN` is correctly configured
2. View Actions logs for specific errors
3. Use manual publish as backup

### Problem: VSIX package not generated

**Solution:**
```bash
# Clean and rebuild
rm -rf out node_modules
npm install
npm run build:prod
npm run package
```

### Problem: Tag already exists

**Solution:**
```bash
# Delete local tag
git tag -d v2.1.0

# Delete remote tag
git push origin :refs/tags/v2.1.0

# Recreate tag
git tag v2.1.0
git push origin v2.1.0
```
