# Fix Verification

## Issue Description
The Discord and Slack adapters had a watermark issue where a single global watermark was used across all channels, causing messages in other channels to be skipped (cross-channel loss).

## Analysis
Upon examining both files, I found that both `discord.js` and `slack.js` already correctly implement the per-channel watermark approach:

1. Both files initialize `lastCheckedMessageId` as an object (`{}`) rather than a scalar
2. Both files use channel IDs as keys to store and retrieve watermarks per channel
3. Both files properly check and update watermarks per channel

## Verification
- `node --check /Users/grb/Projects/mycelium/sdk/adapters/discord.js` - PASSED
- `node --check /Users/grb/Projects/mycelium/sdk/adapters/slack.js` - PASSED

Both files already correctly implement the per-channel watermark approach as required by the fix.