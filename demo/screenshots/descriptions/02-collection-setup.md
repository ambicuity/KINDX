# Screenshot 02: Collection Setup

## Description

Shows the process of registering a directory as a KINDX collection before indexing and embedding it.

## Command

```bash
$ kindx collection add ~/Documents --name my-docs
```

## Expected Terminal Output

```text
$ kindx collection add ~/Documents --name my-docs
✓ Collection 'my-docs' added -> /Users/demo/Documents

Next steps:
  kindx update -c my-docs
  kindx embed

$ kindx collection list
my-docs  /Users/demo/Documents
```

## Annotations

- **Collection name (`my-docs`):** The identifier used with `-c my-docs` in later search commands.
- **Source path:** KINDX expands `~` and stores the absolute path internally.
- **Next steps:** Run `kindx update -c my-docs` to refresh the lexical index, then `kindx embed` to generate vectors.
- **`collection list`:** A quick way to verify the collection name and source path.
