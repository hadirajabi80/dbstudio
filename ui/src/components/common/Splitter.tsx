import { useRef } from 'react';

interface SplitterProps {
  /** `vertical` = a vertical bar that resizes horizontally (left | right panes). */
  direction: 'vertical' | 'horizontal';
  /** Called while dragging with the pointer delta in px since the drag started. */
  onDrag: (delta: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDoubleClick?: () => void;
  ariaLabel?: string;
}

export function Splitter({ direction, onDrag, onDragStart, onDragEnd, onDoubleClick, ariaLabel }: SplitterProps) {
  const start = useRef<number | null>(null);
  return (
    <div
      className={`splitter splitter-${direction}`}
      role="separator"
      aria-orientation={direction}
      aria-label={ariaLabel}
      onDoubleClick={onDoubleClick}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        start.current = direction === 'vertical' ? e.clientX : e.clientY;
        document.body.classList.add(direction === 'vertical' ? 'resizing-col' : 'resizing-row');
        onDragStart?.();
      }}
      onPointerMove={(e) => {
        if (start.current === null) return;
        onDrag((direction === 'vertical' ? e.clientX : e.clientY) - start.current);
      }}
      onPointerUp={(e) => {
        if (start.current === null) return;
        start.current = null;
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
        document.body.classList.remove('resizing-col', 'resizing-row');
        onDragEnd?.();
      }}
    />
  );
}
