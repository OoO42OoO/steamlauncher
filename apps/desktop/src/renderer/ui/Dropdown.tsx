/**
 * Select control styled like the rest of the launcher.
 *
 * A native <select> renders as an OS widget that ignores the app's palette
 * entirely — jarring inside a frameless dark window. This is the same control
 * rebuilt: a button plus a listbox, driven by the keyboard the way a select
 * is (Enter/Space/↓ opens, ↑/↓ move, Enter picks, Escape closes, Tab away
 * closes), and closed by a click anywhere outside.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { IconCheck, IconChevronDown } from './icons';

export interface DropdownOption<T> {
  value: T;
  label: string;
  /** Optional leading visual (flag, swatch, glyph). */
  icon?: ReactNode;
}

export function Dropdown<T extends string | number>({
  value,
  options,
  onChange,
  align = 'end',
  ariaLabel,
  className = '',
  triggerClassName = '',
  menuClassName = '',
  disabled = false,
  hideLabel = false,
}: {
  value: T;
  options: ReadonlyArray<DropdownOption<T>>;
  onChange: (value: T) => void;
  /** Which edge the menu lines up with. */
  align?: 'start' | 'end';
  ariaLabel?: string;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  disabled?: boolean;
  /** Show only the icon on the trigger. The label still reaches assistive
   *  tech through `ariaLabel` and the open listbox. */
  hideLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Which option the keyboard is on. Kept apart from `value`: moving through
  // the list must not commit a choice until Enter.
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );
  const selected = options[selectedIndex];

  const close = useCallback((focusTrigger = false) => {
    setOpen(false);
    if (focusTrigger) {
      rootRef.current?.querySelector<HTMLButtonElement>('[data-dd-trigger]')?.focus();
    }
  }, []);

  // Outside click / focus loss. Pointerdown rather than click so the menu is
  // already gone before the click lands on whatever is underneath.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open]);

  // Opening lands the cursor on the current value, not the top of the list.
  useEffect(() => {
    if (open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelectorAll<HTMLElement>('[role="option"]')
      [activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const commit = (index: number) => {
    const opt = options[index];
    if (opt) onChange(opt.value);
    close(true);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commit(activeIndex);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`} onKeyDown={onKeyDown}>
      <button
        type="button"
        data-dd-trigger
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        // The options never take DOM focus (the trigger keeps it so typing
        // keeps working), so the roving cursor has to be announced by id —
        // otherwise a screen reader reports nothing as the user arrows down.
        aria-activedescendant={open ? `${listId}-opt-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className={
          'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition cursor-pointer ' +
          'bg-[var(--color-surface)] text-[var(--color-dim)] ' +
          'hover:border-[#2e4457] hover:text-[var(--color-ink)] ' +
          'focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-2 ' +
          'disabled:opacity-50 disabled:cursor-not-allowed ' +
          (open
            ? 'border-[var(--color-accent)] text-[var(--color-ink)] '
            : 'border-[var(--color-border)] ') +
          triggerClassName
        }
      >
        {selected?.icon}
        {!hideLabel && <span className="truncate">{selected?.label ?? ''}</span>}
        <IconChevronDown
          size={11}
          className={
            'ml-auto shrink-0 text-[var(--color-dimmer)] transition-transform ' +
            (open ? 'rotate-180' : '')
          }
        />
      </button>

      {open && (
        <div
          id={listId}
          ref={listRef}
          role="listbox"
          aria-label={ariaLabel}
          className={
            'dd-scroll absolute z-40 mt-1.5 min-w-[190px] max-h-72 overflow-y-auto p-1.5 grid gap-px ' +
            'rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-3)] shadow-2xl ' +
            (align === 'end' ? 'right-0 ' : 'left-0 ') +
            menuClassName
          }
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={String(opt.value)}
                id={`${listId}-opt-${i}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => commit(i)}
                // The cursor needs a cue that survives a glance: a background
                // two shades off the menu is invisible on its own, so the
                // active row also lifts its text and carries an accent edge.
                className={
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs cursor-pointer transition ' +
                  (i === activeIndex
                    ? 'bg-[var(--color-border-soft)] outline outline-2 -outline-offset-2 outline-[var(--color-accent)] text-[var(--color-ink)] '
                    : isSelected
                      ? 'text-[#7fd0ff] '
                      : 'text-[#a7bacc] ')
                }
              >
                {opt.icon}
                <span className="truncate">{opt.label}</span>
                {isSelected && (
                  <IconCheck size={13} className="ml-auto shrink-0 text-[var(--color-accent)]" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
