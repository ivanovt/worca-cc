import { describe, expect, it } from 'vitest';
import { stripShebangPlugin } from '../../vitest-strip-shebang.js';

describe('stripShebangPlugin', () => {
  const plugin = stripShebangPlugin();

  it('has the correct name', () => {
    expect(plugin.name).toBe('strip-shebang');
  });

  it('strips a Unix shebang (LF)', () => {
    const code = "#!/usr/bin/env node\nconsole.log('hello');";
    const result = plugin.transform(code, '/fake/bin/cli.js');
    expect(result.code).toBe("\nconsole.log('hello');");
  });

  it('strips a Windows shebang (CRLF)', () => {
    const code = "#!/usr/bin/env node\r\nconsole.log('hello');";
    const result = plugin.transform(code, '/fake/bin/cli.js');
    expect(result.code).toBe("\nconsole.log('hello');");
  });

  it('returns null for files without a shebang', () => {
    const code = "console.log('no shebang');";
    const result = plugin.transform(code, '/fake/bin/cli.js');
    expect(result).toBeNull();
  });

  it('only strips the first line when it starts with #!', () => {
    const code = '#!/usr/bin/env node\nline2\n#!/not-a-shebang';
    const result = plugin.transform(code, '/fake/bin/cli.js');
    expect(result.code).toBe('\nline2\n#!/not-a-shebang');
  });
});
