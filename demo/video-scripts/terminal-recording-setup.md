# Terminal Recording Setup Guide

Instructions for recording clean, professional terminal demos of KINDX.

---

## Option 1: VHS (Preferred)

[VHS](https://github.com/charmbracelet/vhs) by Charmbracelet produces deterministic, reproducible terminal recordings from tape files.

### Installation

```bash
# macOS
brew install charmbracelet/tap/vhs

# Linux (via go)
go install github.com/charmbracelet/vhs@latest

# Requires ffmpeg and ttyd
brew install ffmpeg ttyd
```

### Usage

```bash
# Record using a tape file
vhs demo.tape

# Output is written to the file specified in the tape (e.g., demo.gif)
```

### Tape File Format

Tape files are plain text scripts that drive the recording. See `demo.tape` in this directory for a ready-to-use example.

Key commands:
- `Output <file>` -- set output filename (.gif, .mp4, .webm)
- `Set FontSize <n>` -- terminal font size
- `Set Width <n>` / `Set Height <n>` -- terminal dimensions in pixels
- `Set Theme "<name>"` -- color scheme (e.g., "Catppuccin Mocha")
- `Type "<text>"` -- simulate typing
- `Enter` -- press Enter
- `Sleep <duration>` -- pause (e.g., `Sleep 2s`, `Sleep 500ms`)
- `Hide` / `Show` -- hide/show recording (useful for setup steps)

---

## Option 2: asciinema

[asciinema](https://asciinema.org/) records real terminal sessions and can convert to GIF.

### Installation

```bash
# macOS
brew install asciinema

# Linux
pip install asciinema

# For GIF conversion
npm install -g svg-term-cli
# or
pip install asciinema-agg
```

### Recording

```bash
# Start recording
asciinema rec demo.cast

# Run your demo commands interactively, then Ctrl+D or type exit to stop

# Convert to GIF using agg
agg demo.cast demo.gif

# Or convert to SVG
svg-term --in demo.cast --out demo.svg --window --width 80 --height 24
```

### Playback

```bash
# Play locally
asciinema play demo.cast

# Upload (optional -- creates a shareable link)
asciinema upload demo.cast
```

---

## Tips for Clean Recordings

### Terminal Setup

1. **Use a minimal prompt.** Remove hostname, git status, and other clutter:
   ```bash
   export PS1="$ "
   ```

2. **Set a clean font.** Recommended:
   - JetBrains Mono (14-16pt)
   - Fira Code (14-16pt)
   - SF Mono (14-16pt)

3. **Use a dark theme.** Catppuccin Mocha or Dracula work well on recordings. Avoid pure black backgrounds -- dark gray (#1e1e2e) has better compression.

4. **Clear the terminal** before each take:
   ```bash
   clear
   ```

5. **Set terminal dimensions.** Aim for 80-100 columns by 24-30 rows. For VHS, use pixel dimensions (1200x600 is a good default).

### Recording Best Practices

1. **Type at a readable pace.** In VHS, use `Set TypingSpeed 50ms` for natural-looking typing. Too fast looks robotic; too slow is boring.

2. **Pause after output.** Give viewers 2-3 seconds to read command output before typing the next command. In VHS: `Sleep 2s`.

3. **Keep it focused.** One concept per recording. If you need to show multiple features, make separate recordings.

4. **Hide setup steps.** Use VHS `Hide`/`Show` to skip boring parts:
   ```
   Hide
   Type "cd /tmp && mkdir demo-workspace && cd demo-workspace"
   Enter
   Sleep 1s
   Show
   ```

5. **Use realistic data.** Don't demo with "test" or "foo" -- use realistic collection names and search queries.

6. **Pre-warm the system.** Run commands once before recording so any first-run initialization doesn't slow down the demo.

### File Size Optimization

- **GIF:** Target under 5 MB for web embeds. Reduce frame rate or dimensions if needed.
- **MP4:** Use H.264 for broad compatibility. Target 1-2 MB for short clips.
- **WebM:** Smaller than MP4 at same quality. Good for web, but less compatible.

For VHS GIF optimization:
```bash
# Optimize with gifsicle after recording
gifsicle -O3 --lossy=80 demo.gif -o demo-optimized.gif
```

### Color and Contrast

- Ensure sufficient contrast between text and background
- Test that the recording is readable on both light and dark web pages
- Avoid bright green-on-black "hacker" aesthetics -- they're hard to read

---

## Directory Structure

```
demo/
  video-scripts/
    30-second-wow.md       # Script for short demo
    5-minute-deep-dive.md  # Script for full walkthrough
    terminal-recording-setup.md  # This file
    demo.tape              # VHS tape file (ready to record)
  screenshots/
    descriptions/          # Screenshot descriptions and expected output
    README.md              # Screenshot index
```
