#!/usr/bin/env bash
set -e

echo "🧪 Running Auth Test Suite..."
echo ""

echo "📦 Testing data package auth modules..."
npm --prefix packages/data run test:auth
echo ""

echo "🌐 Testing web auth refresh flow..."
npm --prefix web run test:auth
echo ""

echo "✅ All auth tests passed!"
