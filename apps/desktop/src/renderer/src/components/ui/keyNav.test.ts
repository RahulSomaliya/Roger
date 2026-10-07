import { describe, expect, it } from 'vitest';
import { nextIndex } from './keyNav';

describe('nextIndex, a tab row (horizontal)', () => {
  it('moves right and left, and wraps at both ends', () => {
    expect(nextIndex('horizontal', 'ArrowRight', 0, 4)).toBe(1);
    expect(nextIndex('horizontal', 'ArrowRight', 3, 4)).toBe(0);
    expect(nextIndex('horizontal', 'ArrowLeft', 2, 4)).toBe(1);
    expect(nextIndex('horizontal', 'ArrowLeft', 0, 4)).toBe(3);
  });

  it('jumps to the first and the last with Home and End', () => {
    expect(nextIndex('horizontal', 'Home', 2, 4)).toBe(0);
    expect(nextIndex('horizontal', 'End', 1, 4)).toBe(3);
  });

  it('leaves the vertical arrows alone, so a page scroll still works', () => {
    expect(nextIndex('horizontal', 'ArrowDown', 1, 4)).toBeNull();
    expect(nextIndex('horizontal', 'ArrowUp', 1, 4)).toBeNull();
  });
});

describe('nextIndex, a menu (vertical)', () => {
  it('moves down and up, and wraps at both ends', () => {
    expect(nextIndex('vertical', 'ArrowDown', 0, 3)).toBe(1);
    expect(nextIndex('vertical', 'ArrowDown', 2, 3)).toBe(0);
    expect(nextIndex('vertical', 'ArrowUp', 1, 3)).toBe(0);
    expect(nextIndex('vertical', 'ArrowUp', 0, 3)).toBe(2);
  });

  it('leaves the horizontal arrows alone', () => {
    expect(nextIndex('vertical', 'ArrowLeft', 1, 3)).toBeNull();
    expect(nextIndex('vertical', 'ArrowRight', 1, 3)).toBeNull();
  });
});

describe('nextIndex, anything else', () => {
  it('ignores other keys and an empty list', () => {
    expect(nextIndex('horizontal', 'Enter', 1, 4)).toBeNull();
    expect(nextIndex('horizontal', 'a', 1, 4)).toBeNull();
    expect(nextIndex('vertical', 'ArrowDown', 0, 0)).toBeNull();
  });
});
