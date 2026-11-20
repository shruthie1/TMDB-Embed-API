import { describe, it, expect, afterEach } from 'vitest';
import { useRef } from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';
import useFocusTrap from '../../components/useFocusTrap';

function Page() {
  const ref = useRef(null);
  useFocusTrap(ref);
  return (
    <div>
      <button>behind-1</button>
      <div ref={ref} role="dialog">
        <button>first</button>
        <button>middle</button>
        <button>last</button>
      </div>
      <a href="/x">behind-2</a>
    </div>
  );
}

// jsdom has no layout, so give every element a client rect.
Element.prototype.getClientRects = function () { return [{ width: 1, height: 1 }]; };

const tab = (shiftKey = false) => fireEvent.keyDown(document.activeElement || document.body, { key: 'Tab', shiftKey });

afterEach(cleanup);

describe('useFocusTrap', () => {
  it('pulls focus from the page behind into the dialog', () => {
    const { getByText } = render(<Page />);
    getByText('behind-1').focus();
    tab();
    expect(document.activeElement).toBe(getByText('first'));
  });
  it('wraps Tab from the last control to the first', () => {
    const { getByText } = render(<Page />);
    getByText('last').focus();
    tab();
    expect(document.activeElement).toBe(getByText('first'));
  });
  it('wraps Shift+Tab from the first control to the last', () => {
    const { getByText } = render(<Page />);
    getByText('first').focus();
    tab(true);
    expect(document.activeElement).toBe(getByText('last'));
  });
  it('leaves a Tab between controls to the browser', () => {
    const { getByText } = render(<Page />);
    getByText('first').focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
