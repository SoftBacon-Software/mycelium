import { useState, useRef, useEffect, type ReactNode } from 'react'

interface TooltipProps {
  content: string
  children: ReactNode
  position?: 'top' | 'bottom' | 'left' | 'right'
  delay?: number
}

export default function Tooltip({ content, children, position = 'right', delay = 300 }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0 })
  const triggerRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [])

  function show() {
    timerRef.current = setTimeout(() => {
      if (!triggerRef.current) return
      const rect = triggerRef.current.getBoundingClientRect()
      const gap = 8

      switch (position) {
        case 'right':
          setCoords({ top: rect.top + rect.height / 2, left: rect.right + gap })
          break
        case 'left':
          setCoords({ top: rect.top + rect.height / 2, left: rect.left - gap })
          break
        case 'top':
          setCoords({ top: rect.top - gap, left: rect.left + rect.width / 2 })
          break
        case 'bottom':
          setCoords({ top: rect.bottom + gap, left: rect.left + rect.width / 2 })
          break
      }
      setVisible(true)
    }, delay)
  }

  function hide() {
    if (timerRef.current) clearTimeout(timerRef.current)
    setVisible(false)
  }

  const transformOrigin = {
    right: 'translateY(-50%)',
    left: 'translateX(-100%) translateY(-50%)',
    top: 'translateX(-50%) translateY(-100%)',
    bottom: 'translateX(-50%)',
  }

  return (
    <>
      <div
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className="contents"
      >
        {children}
      </div>
      {visible && (
        <div
          ref={tipRef}
          className="fixed z-[9999] px-2.5 py-1.5 rounded bg-surface-raised border border-border/60 text-xs text-text-dim shadow-lg max-w-[240px] pointer-events-none animate-fade-in"
          style={{
            top: coords.top,
            left: coords.left,
            transform: transformOrigin[position],
          }}
        >
          {content}
        </div>
      )}
    </>
  )
}
