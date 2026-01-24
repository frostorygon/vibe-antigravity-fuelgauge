#!/bin/bash
set -e

echo "🔒 Building Antigravity Cockpit (Secure Fork)..."

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Run linting (optional, can be strict)
# echo "🔍 Linting..."
# npm run lint

# Package extension
echo "📦 Packaging extension..."
npm run package

echo "✅ Build complete! Check the .vsix file in the root directory."
