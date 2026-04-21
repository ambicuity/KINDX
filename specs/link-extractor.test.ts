import { describe, expect, it } from 'vitest';
import { extractInternalLinks } from '../engine/link-extractor.js';

describe('link-extractor', () => {
  it('extracts basic markdown links', () => {
    const content = `
      Here is a [link to api](api.md).
      Also a [guide](../guide/index.md).
      External [link](https://google.com) should be ignored.
      And [mailto](mailto:test@test.com) too.
    `;
    const links = extractInternalLinks(content, 'docs/features/test.md');
    expect(links).toContain('docs/features/api.md');
    expect(links).toContain('docs/guide/index.md');
    expect(links).not.toContain('https://google.com');
    expect(links).not.toContain('mailto:test@test.com');
  });

  it('extracts wiki links', () => {
    const content = `
      Check out [[architecture]] and [[design|Design Docs]].
    `;
    const links = extractInternalLinks(content, 'docs/test.md');
    expect(links).toContain('docs/architecture.md');
    expect(links).toContain('docs/design.md');
  });

  it('strips url hashes from targets', () => {
    const content = `
      Here is [api](api.md#section-1).
      And [[getting-started#Setup]].
    `;
    const links = extractInternalLinks(content, 'docs/test.md');
    expect(links).toContain('docs/api.md');
    expect(links).toContain('docs/getting-started.md');
  });

  it('ignores links in codeblocks', () => {
    const content = `
      Some text [valid](valid.md).
      \`\`\`md
      [invalid](invalid.md)
      \`\`\`
    `;
    const links = extractInternalLinks(content, 'test.md');
    expect(links).toContain('valid.md');
    expect(links).not.toContain('invalid.md');
  });
  
  it('handles absolute links appropriately', () => {
    const content = `[absolute](/root/file.md) and [[/another]]`;
    const links = extractInternalLinks(content, 'some/nested/file.md');
    expect(links).toContain('root/file.md');
    expect(links).toContain('another.md');
  });
});
