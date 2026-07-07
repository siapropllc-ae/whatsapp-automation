'use client';

import React from 'react';

interface SpinToolbarProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
  variables?: string[];
}

const DEFAULT_VARS = ['name', 'city', 'interest', 'phone'];

const pillStyle: React.CSSProperties = {
  background: 'rgba(212,175,55,0.08)',
  border: '1px solid rgba(212,175,55,0.18)',
  borderRadius: 6,
  color: 'var(--gold)',
  fontSize: 11,
  padding: '4px 9px',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

interface Insertion {
  insert: string;
  /** Offsets relative to the start of `insert`, defining the cursor/selection left after inserting. */
  selStart: number;
  selEnd: number;
}

/**
 * Inserts `build(selectedText)`'s result at the textarea's current cursor/selection,
 * replacing any selection — mirrors how a rich-text editor's toolbar buttons behave,
 * rather than always appending at the end of the field.
 */
function applyInsertion(
  value: string,
  textarea: HTMLTextAreaElement | null,
  build: (selected: string) => Insertion,
): { next: string; selStart: number; selEnd: number } {
  const start = textarea?.selectionStart ?? value.length;
  const end = textarea?.selectionEnd ?? value.length;
  const selected = value.slice(start, end);
  const { insert, selStart, selEnd } = build(selected);
  const next = value.slice(0, start) + insert + value.slice(end);
  return { next, selStart: start + selStart, selEnd: start + selEnd };
}

/** Cursor-aware toolbar for inserting spin syntax and personalization variables into a body textarea. */
export function SpinToolbar({ textareaRef, value, onChange, variables = DEFAULT_VARS }: SpinToolbarProps) {
  const run = (build: (selected: string) => Insertion) => {
    const el = textareaRef.current;
    const { next, selStart, selEnd } = applyInsertion(value, el, build);
    onChange(next);
    // requestAnimationFrame: the textarea's new value is applied via React's async
    // re-render from onChange, so setSelectionRange must wait a frame or it can be
    // overwritten (or throw, if the new value is shorter than the old cursor position).
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(selStart, selEnd);
    });
  };

  const insertVariable = (name: string) => {
    const token = `{${name}}`;
    run(() => ({ insert: token, selStart: token.length, selEnd: token.length }));
  };

  const insertSpin = () => {
    run((selected) => {
      if (selected) {
        // Wrap the selection as an alternate option, cursor lands just before the
        // closing brace so the user can immediately type the other option.
        const insert = `{${selected}|}`;
        const pos = insert.length - 1;
        return { insert, selStart: pos, selEnd: pos };
      }
      // No selection: insert a placeholder with "option1" pre-selected so the next
      // keystroke overwrites it, same convention as a snippet/template placeholder.
      const insert = '{option1|option2}';
      return { insert, selStart: 1, selEnd: 8 };
    });
  };

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
      <button type="button" onClick={insertSpin} style={pillStyle} title="Insert spin-syntax alternatives">
        {'{opt1|opt2}'} spin
      </button>
      {variables.map((v) => (
        <button type="button" key={v} onClick={() => insertVariable(v)} style={pillStyle} title={`Insert {${v}}`}>
          {`{${v}}`}
        </button>
      ))}
    </div>
  );
}
