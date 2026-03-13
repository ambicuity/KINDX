# 30-Second Terminal Demo: KINDX Wow Factor

**Target:** Social media / landing page hero clip
**Format:** Terminal recording (VHS or asciinema), GIF or MP4
**Resolution:** 1200x600, FontSize 14, dark theme

---

## SCENE 1: The Hook (0:00 - 0:05)

**On screen:** Clean terminal, cursor blinking.

**Type:**
```
$ kindx demo
```

**Talking point:** "One command. Local semantic memory for your AI agents."

**Timing cue:** Pause 0.5s after typing, then press Enter.

---

## SCENE 2: Setup Magic (0:05 - 0:15)

**On screen:** The demo command prints a guided walkthrough with sample commands and results.

**Expected output:**
```
KINDX - Interactive Demo

Step 1: Collection Setup
  $ kindx collection add ./specs/eval-docs --name kindx-demo
  Registered collection 'kindx-demo'

Step 2: Embedding
  $ kindx embed
  Embedded 42 chunks from 6 documents

Step 3: BM25 Search
  $ kindx search "API versioning best practices" -c kindx-demo
```

**Talking point:** "One command shows the real workflow: add a collection, embed locally, then search."

**Timing cue:** Let the walkthrough breathe for a few seconds so viewers can read the commands.

---

## SCENE 3: The CTA (0:15 - 0:30)

**On screen:** Type the config snippet, then freeze.

**Type:**
```
$ cat ~/.claude/claude_desktop_config.json
```

**Show:**
```json
{
  "mcpServers": {
    "kindx": {
      "command": "kindx",
      "args": ["mcp"]
    }
  }
}
```

**Text overlay / voiceover:** "Add to Claude Desktop in 30 seconds."

**Talking point:** "MCP-native. Drop it into Claude Desktop, Cursor, or any MCP client."

**Timing cue:** Hold final frame for 2s. Fade to logo / repo URL.

---

## Production Notes

- Use `Set Theme "Catppuccin Mocha"` for dark theme consistency.
- Ensure terminal prompt is minimal: `$ ` only, no hostname or path clutter.
- If converting to GIF, target < 5 MB for fast page loads.
- Record at 1200x600 so text is readable on mobile at 50% scale.
