import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/**
 * True when a row's contents don't fit its width (it would run off the side), so it can switch to
 * its compact form. Measured, not guessed from the screen width: an iPad's browser uses other fonts
 * than Windows, a theme can change the font, and the meters in the top bar come and go. Switches
 * back once the row is as wide as its contents needed.
 */
export function useCompactWhenCrowded(ref: RefObject<HTMLElement | null>, enabled = true): boolean {
  const [compact, setCompact] = useState(false)
  // How wide the row's contents were in the full form: wider than that, the full form fits again.
  const needed = useRef(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !enabled) {
      setCompact(false)
      return
    }
    const check = (): void => {
      if (!compact) {
        if (el.scrollWidth > el.clientWidth + 1) {
          needed.current = el.scrollWidth
          setCompact(true)
        }
      } else if (el.clientWidth >= needed.current) {
        setCompact(false)
      }
    }
    // The row's width changes with the window; its contents with what's in it (a meter appearing).
    const sizes = new ResizeObserver(check)
    const watch = (): void => {
      sizes.disconnect()
      sizes.observe(el)
      for (const child of el.children) sizes.observe(child)
    }
    watch()
    const contents = new MutationObserver(() => {
      watch()
      check()
    })
    contents.observe(el, { childList: true })
    check()
    return () => {
      sizes.disconnect()
      contents.disconnect()
    }
  }, [ref, enabled, compact])

  return compact
}
