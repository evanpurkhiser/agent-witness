import {describe, expect, it} from 'vitest';

import {formatCommand} from './formatCommand';

describe('formatCommand', () => {
  it('leaves ordinary shell arguments compact', () => {
    expect(formatCommand(['git', 'push', 'origin', 'main'])).toBe('git push origin main');
  });

  it('quotes arguments without changing their boundaries', () => {
    expect(formatCommand(['deploy', '', 'release candidate', "Evan's build"])).toBe(
      "deploy '' 'release candidate' 'Evan'\\''s build'",
    );
  });
});
