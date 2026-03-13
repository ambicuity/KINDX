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

**On screen:** The demo command auto-scaffolds a sample collection and begins embedding.

**Expected output:**
```
Setting up demo collection "kindx-demo"...
  Added 12 sample documents from built-in corpus
  Embedding documents... ████████████████████████ 12/12 (100%)
  BM25 index built (12 docs, 3,847 terms)
  Vector index ready (12 docs, 384 dimensions)

Demo collection "kindx-demo" is ready!
```

**Talking point:** "Automatic collection setup, local embeddings, zero API keys."

**Timing cue:** Let the progress bar animate naturally (~8s). Do not fast-forward -- the speed is the point.

---

## SCENE 3: Hybrid Search (0:15 - 0:25)

**On screen:** Type and run a hybrid search query.

**Type:**
```
$ kindx query "raising money for startup" --top 3
```

**Expected output:**
```
Hybrid Search: "raising money for startup" (3 results)

  #1  [0.91] kindx://kindx-demo/fundraising-guide.md
      "Series A fundraising requires a clear narrative around traction,
       market size, and capital efficiency..."

  #2  [0.84] kindx://kindx-demo/startup-finance.md
      "Early-stage startups typically raise through SAFEs or convertible
       notes before pricing a priced round..."

  #3  [0.78] kindx://kindx-demo/investor-relations.md
      "Building investor relationships 6-12 months before you need
       capital gives you leverage in negotiations..."
```

**Talking point:** "Hybrid retrieval -- keyword + semantic -- ranked and scored, all local."

**Timing cue:** Results appear instantly. Pause 2s so viewer can scan the output.

---

## SCENE 4: The CTA (0:25 - 0:30)

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
      "args": ["serve"]
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
